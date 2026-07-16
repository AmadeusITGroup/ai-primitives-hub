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

export interface LoadHubSourcesResult {
  added: number;
  updated: number;
  skipped: number;
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
 * @returns Counts of added/updated/skipped sources.
 */
export async function loadHubSources(
  hubId: string,
  hubSources: HubSource[],
  ports: HubSourceSync,
  onLog?: OnLogEvent
): Promise<LoadHubSourcesResult> {
  const log = (level: LogEvent['level'], message: string, error?: Error): void => {
    onLog?.({ level, message, error });
  };

  log('info', `Found ${hubSources.length} sources in hub ${hubId}`);

  const existingSources = await ports.listSources();

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const hubSource of hubSources) {
    if (!hubSource.enabled) {
      log('debug', `Skipping disabled source: ${hubSource.id}`);
      skipped++;
      continue;
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
      continue;
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
      continue;
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
    } catch (sourceError) {
      const err = sourceError instanceof Error ? sourceError : new Error(String(sourceError));
      log('warn', `Failed to add hub source ${sourceId} (${hubSource.name}): ${err.message}`, err);
      skipped++;
    }
  }

  log('info', `Hub source loading complete for ${hubId}: ${added} added, ${updated} updated, ${skipped} skipped`);

  return { added, updated, skipped };
}
