/**
 * Hub source-loading/dedup — ported from the extension's
 * `src/services/hub-manager.ts` (`HubManager.loadHubSources`/
 * `findDuplicateSource`). Stage 2 of the staged HubManager port
 * (migration plan §7.5, HubManager item; see `hub-manager.ts`'s
 * module doc for the full stage list).
 *
 * Converts a hub's declared `HubSource[]` into `RegistrySource`
 * entries and syncs them into the registry: skips disabled sources,
 * updates sources that already carry the same stable id (re-import/
 * sync of the same hub), skips true duplicates (same url/type/branch/
 * collectionsPath under a different id — e.g. added independently
 * before hub adoption, or shared across two hubs), and adds
 * everything else as new.
 *
 * SourceId format: `generateSourceId(type, url, config)` produces
 * `{type}-{12-char-hash}`, based on source properties rather than the
 * hub id, so lockfiles stay portable across different hub
 * configurations. Legacy hub-prefixed ids (`hub-{hubId}-{sourceId}`)
 * continue to work since duplicate detection matches on url/type/
 * branch/collectionsPath, not id.
 * @module registry/load-hub-sources
 */
import type {
  HubSource,
  HubSourceSync,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  generateSourceId,
} from '@ai-primitives-hub/core';
import type {
  LogEvent,
  OnLogEvent,
} from '../update/log-event';
import {
  createSourceSyncQueue,
} from './source-sync-queue';

export interface LoadHubSourcesResult {
  added: number;
  updated: number;
  skipped: number;
}

export interface LoadHubSourcesOptions {
  concurrency?: number;
  onSourceAdded?: (source: RegistrySource) => void;
}

/**
 * Check if a hub source is a duplicate of an already-registered
 * source, based on type + url + branch + collectionsPath (not id
 * matching, so it tolerates both the new stable-hash id format and
 * legacy hub-prefixed ids).
 * @param source Candidate hub source.
 * @param existingSources Already-registered sources to compare against.
 * @returns The matching existing source, or undefined.
 */
export function findDuplicateSource(
  source: HubSource,
  existingSources: RegistrySource[]
): RegistrySource | undefined {
  return existingSources.find((existing) => {
    if (existing.type !== source.type || existing.url !== source.url) {
      return false;
    }

    const existingConfig = existing.config ?? {};
    const sourceConfig = source.config ?? {};

    const existingBranch = existingConfig.branch ?? 'main';
    const sourceBranch = sourceConfig.branch ?? 'main';
    if (existingBranch !== sourceBranch) {
      return false;
    }

    const existingPath = existingConfig.collectionsPath ?? 'collections';
    const sourcePath = sourceConfig.collectionsPath ?? 'collections';
    if (existingPath !== sourcePath) {
      return false;
    }

    return true;
  });
}

/**
 * Sync a hub's declared sources into the registry.
 *
 * Per-source `addSource` failures (e.g. a private repo returning 404)
 * are caught, logged, and skipped rather than failing the whole
 * operation — a hub with one bad source should still get its other
 * sources loaded. `listSources`/`updateSource` failures are not
 * caught here; they propagate to the caller.
 * @param hubId Hub identifier the sources belong to.
 * @param hubSources Sources declared in the hub's config.
 * @param ports Registry read/write access.
 * @param onLog Optional sink for diagnostic log events.
 * @param options Optional orchestration settings.
 * @returns Counts of added/updated/skipped sources.
 */
export async function loadHubSources(
  hubId: string,
  hubSources: HubSource[],
  ports: HubSourceSync,
  onLog?: OnLogEvent,
  options?: LoadHubSourcesOptions
): Promise<LoadHubSourcesResult> {
  const log = (level: LogEvent['level'], message: string, error?: Error): void => {
    onLog?.({ level, message, error });
  };

  log('info', `Found ${hubSources.length} sources in hub ${hubId}`);

  const existingSources = await ports.listSources();

  let added = 0;
  let updated = 0;
  let skipped = 0;

  const processSource = async (hubSource: HubSource): Promise<void> => {
    if (!hubSource.enabled) {
      log('debug', `Skipping disabled source: ${hubSource.id}`);
      skipped++;
      return;
    }

    const sourceId = generateSourceId(hubSource.type, hubSource.url, {
      branch: hubSource.config?.branch,
      collectionsPath: hubSource.config?.collectionsPath
    });

    const existingSourceById = existingSources.find((s) => s.id === sourceId);

    if (existingSourceById) {
      log('info', `Updating existing hub source: ${sourceId}`);
      await ports.updateSource(sourceId, {
        name: hubSource.name,
        type: hubSource.type,
        url: hubSource.url,
        enabled: hubSource.enabled,
        priority: hubSource.priority,
        private: hubSource.private,
        token: hubSource.token,
        metadata: hubSource.metadata,
        config: hubSource.config,
        hubId
      });
      updated++;
      return;
    }

    const duplicateSource = findDuplicateSource(hubSource, existingSources);

    if (duplicateSource) {
      log(
        'info',
        `Skipping duplicate source: ${hubSource.name} `
        + `(already exists as "${duplicateSource.name}" with ID: ${duplicateSource.id})`
      );
      log(
        'debug',
        `Duplicate detected - URL: ${hubSource.url}, `
        + `Branch: ${hubSource.config?.branch ?? 'main'}, `
        + `CollectionsPath: ${hubSource.config?.collectionsPath ?? 'collections'}`
      );
      skipped++;
      return;
    }

    log('info', `Adding new hub source: ${sourceId} (${hubSource.name})`);

    const registrySource: RegistrySource = {
      id: sourceId,
      name: hubSource.name,
      type: hubSource.type,
      url: hubSource.url,
      enabled: hubSource.enabled,
      priority: hubSource.priority,
      private: hubSource.private,
      token: hubSource.token,
      metadata: hubSource.metadata,
      config: hubSource.config,
      hubId
    };

    try {
      await ports.addSource(registrySource);
      added++;
      try {
        options?.onSourceAdded?.(registrySource);
      } catch (hookError) {
        const err = hookError instanceof Error ? hookError : new Error(String(hookError));
        log('warn', `Source-added notification failed for ${sourceId} (${hubSource.name}): ${err.message}`, err);
      }
    } catch (sourceError) {
      const err = sourceError instanceof Error ? sourceError : new Error(String(sourceError));
      log('warn', `Failed to add hub source ${sourceId} (${hubSource.name}): ${err.message}`, err);
      skipped++;
    }
  };

  const raw = options?.concurrency ?? 1;
  const concurrency = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < hubSources.length) {
      const index = nextIndex++;
      await processSource(hubSources[index]);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  log('info', `Hub source loading complete for ${hubId}: ${added} added, ${updated} updated, ${skipped} skipped`);

  return { added, updated, skipped };
}

export interface ProgressiveLoadResult {
  /** Resolves when the first source sync settles, OR all registrations complete with zero syncs. */
  onFirstSettled: () => Promise<void>;
  /** Resolves when all source registrations AND all background syncs finish. */
  onComplete: () => Promise<void>;
}

export interface ProgressiveLoadOptions extends LoadHubSourcesOptions {
  /** Concurrency cap for background syncs (defaults to `concurrency`). */
  syncConcurrency?: number;
  /** Called for each source after it is registered, to trigger a background sync. */
  syncSource: (sourceId: string) => Promise<void>;
}

/**
 * Like `loadHubSources`, but also schedules a background sync for each newly
 * registered source via `options.syncSource`, and returns handles to wait for
 * the first sync or for the full batch to complete.
 *
 * - `onFirstSettled()` — resolves when the first sync settles, OR when
 *   registration finishes with zero syncs enqueued (so callers never hang on
 *   hubs whose sources are all disabled or duplicates).
 * - `onComplete()` — resolves after both registration and all sync tasks finish.
 * @param hubId Hub identifier the sources belong to.
 * @param hubSources Sources declared in the hub's config.
 * @param ports Registry read/write access.
 * @param onLog Optional sink for diagnostic log events.
 * @param options Progressive-load orchestration settings.
 */
export function loadHubSourcesProgressively(
  hubId: string,
  hubSources: HubSource[],
  ports: HubSourceSync,
  onLog: OnLogEvent | undefined,
  options: ProgressiveLoadOptions
): ProgressiveLoadResult {
  const queue = createSourceSyncQueue(
    options.syncSource,
    options.syncConcurrency ?? options.concurrency ?? 1
  );

  const registrationPromise = loadHubSources(hubId, hubSources, ports, onLog, {
    ...options,
    onSourceAdded: (source) => {
      queue.enqueue(source.id);
      options.onSourceAdded?.(source);
    }
  });

  return {
    onFirstSettled: () => Promise.race([
      queue.onFirstSettled(),
      // If registration finishes without any enabled, new sources, resolve so
      // callers do not hang. Otherwise keep waiting for an actual sync to
      // settle; registration can complete while background syncs are running.
      registrationPromise.then(() => (
        queue.hasEnqueued() ? queue.onFirstSettled() : undefined
      )).catch(() => undefined)
    ]),
    onComplete: () => registrationPromise
      .catch(() => undefined)
      .then(() => queue.onIdle())
  };
}
