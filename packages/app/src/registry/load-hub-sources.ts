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
 * before hub adoption, or shared across two hubs), adds everything
 * else as new, and prunes orphaned sources — ones this hub previously
 * contributed that are no longer in its config (e.g. a collection whose
 * repository URL was renamed, producing a new sourceId while the old
 * one lingers as a stale duplicate).
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
  LogEvent,
  OnLogEvent,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  generateSourceId,
} from '@ai-primitives-hub/core';
import {
  createSourceSyncQueue,
} from './source-sync-queue';

/**
 * Why an orphaned source was kept rather than remapped and removed.
 * Diagnostic only — never persisted; each value appears as the reason marker
 * in the single keep-alive warning.
 */
export type KeepAliveReason =
  | 'no-candidate'
  | 'ambiguous-candidates'
  | 'missing-sticker'
  | 'remap-failed'
  | 'port-absent';

/**
 * The actionable remediation every keep-alive warning ends with: the hub
 * authoring convention that makes a URL rename provable in the first place.
 */
const KEEP_ALIVE_REMEDIATION
  = 'keep a source\'s `id` stable when changing its `url`';

export interface LoadHubSourcesResult {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
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
 * Per-source `addSource`/`removeSource` failures (e.g. a private repo
 * returning 404) are caught, logged, and skipped rather than failing
 * the whole operation — a hub with one bad source should still get its
 * other sources loaded. `listSources`/`updateSource` failures are not
 * caught here; they propagate to the caller.
 *
 * After syncing, any source belonging to this hub (`hubId` match) that
 * was not represented in the current config is pruned. Manually-added
 * sources (no `hubId`) and sources contributed by other hubs are never
 * touched. Disabled sources still count as "represented" — their id is
 * protected from pruning so `enabled: false` suppresses fetching without
 * destroying the registry entry.
 *
 * Pruning is deliberately conservative to avoid stranding installed
 * bundles (`removeSource` detaches a source but does not uninstall bundles
 * or clean lockfile entries, so a pruned source with live consumers can no
 * longer be updated):
 * - It is skipped entirely for the whole sync if any `addSource` failed,
 *   so a transient error on a renamed source's new id cannot delete the
 *   old id before its replacement lands.
 * - An orphan with installed bundles still referencing it (via
 *   `ports.listInstalledBundles`, when provided) is kept and logged as a
 *   warning rather than removed; deletion only proceeds once those
 *   consumers are migrated or uninstalled. When `listInstalledBundles` is
 *   not provided this guard is skipped and a pruned source may leave its
 *   installed bundles in an unmanaged state.
 * @param hubId Hub identifier the sources belong to.
 * @param hubSources Sources declared in the hub's config.
 * @param ports Registry read/write access.
 * @param onLog Optional sink for diagnostic log events.
 * @param options Optional orchestration settings.
 * @returns Counts of added/updated/skipped/removed sources.
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
  let removed = 0;

  // Ids of existing sources still represented in the current hub config
  // (added, updated, or matched as a duplicate). Any source belonging to
  // this hub but absent from this set after processing is orphaned and
  // must be pruned to avoid stale duplicates on URL rename.
  const protectedSourceIds = new Set<string>();

  // Stored source id -> its `hubSourceId` sticker, for sources storage actually
  // received this cycle (successful `addSource`/`updateSource` only). Disabled
  // declarations, failed adds, and matched duplicates stay out: remapping
  // installed bundles onto an id storage never received would point them at a
  // phantom source. This is the only pool replacement selection draws from.
  const registeredThisCycle = new Map<string, string | undefined>();

  // Set when any `addSource` fails this cycle. Orphan pruning is skipped
  // entirely in that case: a transient failure on a renamed source's new
  // id would otherwise let us delete the old id (now absent from config)
  // while the replacement never landed, stranding installed bundles. Better
  // to keep a stale duplicate than to lose the source outright.
  let addFailed = false;

  const processSource = async (hubSource: HubSource): Promise<void> => {
    // Generate the stable id up front and protect it from pruning
    // regardless of the enabled flag. Disabling a source in hub config is a
    // reversible action (e.g. a collection under maintenance); it must
    // suppress fetching, not destroy the registry entry and strand any
    // bundles installed from it.
    const sourceId = generateSourceId(hubSource.type, hubSource.url, {
      branch: hubSource.config?.branch,
      collectionsPath: hubSource.config?.collectionsPath
    });
    protectedSourceIds.add(sourceId);

    // The hub-author-assigned declaration id (the "sticker"): persisted as-is
    // so a later sync can match a pre-rename orphan to its replacement even
    // though the stored id is derived from the url. Declarations without an id
    // persist no key at all, keeping pre-feature and manual records untouched.
    const sticker: Pick<RegistrySource, 'hubSourceId'> = hubSource.id
      ? { hubSourceId: hubSource.id }
      : {};

    if (!hubSource.enabled) {
      log('debug', `Skipping disabled source: ${hubSource.id}`);
      skipped++;
      return;
    }

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
        hubId,
        ...sticker
      });
      registeredThisCycle.set(sourceId, hubSource.id);
      updated++;
      return;
    }

    const duplicateSource = findDuplicateSource(hubSource, existingSources);

    if (duplicateSource) {
      protectedSourceIds.add(duplicateSource.id);
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
      hubId,
      ...sticker
    };

    try {
      await ports.addSource(registrySource);
      registeredThisCycle.set(sourceId, hubSource.id);
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
      addFailed = true;
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

  // Skip pruning entirely if any add failed: the config sync is incomplete,
  // and deleting an orphan (e.g. the pre-rename id) while its replacement
  // never landed would strand installed bundles. A stale duplicate is
  // recoverable on the next successful sync; lost sources are not.
  if (addFailed) {
    log(
      'warn',
      `Skipping orphaned source pruning for hub ${hubId}: one or more sources failed to add this sync`
    );
  } else {
    // Prune orphaned sources: any source previously linked to this hub that
    // is no longer represented in the current config (e.g. a renamed URL).
    const orphanedSources = existingSources.filter(
      (s) => s.hubId === hubId && !protectedSourceIds.has(s.id)
    );

    const installedBundles = orphanedSources.length > 0
      ? await ports.listInstalledBundles()
      : [];

    for (const orphan of orphanedSources) {
      const consumers = installedBundles.filter((b) => b.sourceId === orphan.id);

      if (consumers.length > 0) {
        // Find the replacement among the ids storage actually received this
        // cycle, matching on the hub-author-assigned sticker: a renamed source
        // keeps its declaration `id` while its url-derived stored id changes,
        // so the sticker is what ties the pre-rename orphan to its successor.
        // Ids that were only protected from pruning (disabled declarations,
        // failed adds, matched duplicates) are not eligible: a remap onto one
        // of them would strand installed bundles on a source id no store holds.
        //
        // An orphan with no sticker matches nothing — `undefined === undefined`
        // is not evidence of a shared identity. Requiring exactly one candidate
        // also makes selection independent of the order workers populated the
        // map in, so `concurrency > 1` picks the same id as `concurrency: 1`.
        const orphanSticker = orphan.hubSourceId;
        const candidates = orphanSticker === undefined
          ? []
          : [...registeredThisCycle.entries()]
            .filter(([id, sticker]) => id !== orphan.id && sticker === orphanSticker)
            .map(([id]) => id);

        // One warning per keep-alive, carrying the orphan id and name, the
        // number of blocked consumers, the reason marker, and — last, so it is
        // the line's takeaway — the convention that prevents a recurrence.
        const keepAlive = (
          reason: KeepAliveReason,
          detail: string,
          error?: Error
        ): void => {
          log(
            'warn',
            `Keeping orphaned hub source ${orphan.id} (${orphan.name}): `
            + `${consumers.length} installed bundle(s) still reference it. `
            + `Reason [${reason}]: ${detail} `
            + `Remediation: ${KEEP_ALIVE_REMEDIATION}.`,
            error
          );
        };

        if (orphanSticker === undefined) {
          keepAlive(
            'missing-sticker',
            'the stored source carries no hubSourceId, so no replacement can be proven; '
            + 'it will be backfilled on the next successful sync of this hub.'
          );
          continue;
        }

        if (candidates.length === 0) {
          keepAlive(
            'no-candidate',
            `no source registered this sync carries hubSourceId "${orphanSticker}".`
          );
          continue;
        }

        if (candidates.length > 1) {
          keepAlive(
            'ambiguous-candidates',
            `${candidates.length} sources registered this sync carry hubSourceId `
            + `"${orphanSticker}" (${candidates.join(', ')}), so the replacement is not unique.`
          );
          continue;
        }

        const replacementId = candidates[0];

        if (!ports.remapBundleSource) {
          keepAlive(
            'port-absent',
            `replacement source ${replacementId} is available but the remapBundleSource `
            + 'port is not provided by this host.'
          );
          continue;
        }

        try {
          await ports.remapBundleSource(orphan.id, replacementId);
          await ports.removeSource(orphan.id);
          // The single success report: it names the sticker that proved the
          // match, so a reader can tell *why* these two ids were paired rather
          // than having to reconstruct it from the hub config.
          log(
            'info',
            `Remapped ${consumers.length} installed bundle record(s) from orphaned source `
            + `${orphan.id} to ${replacementId} (matched on hubSourceId "${orphanSticker}") `
            + 'and removed the orphan'
          );
          removed++;
        } catch (remapError) {
          const err = remapError instanceof Error ? remapError : new Error(String(remapError));
          keepAlive(
            'remap-failed',
            `remapping onto replacement source ${replacementId} failed: ${err.message}.`,
            err
          );
        }
        continue;
      }

      try {
        await ports.removeSource(orphan.id);
        log('info', `Removed orphaned hub source: ${orphan.id} (${orphan.name}) - no longer present in hub ${hubId}`);
        removed++;
      } catch (removeError) {
        const err = removeError instanceof Error ? removeError : new Error(String(removeError));
        log('warn', `Failed to remove orphaned hub source ${orphan.id} (${orphan.name}): ${err.message}`, err);
      }
    }
  }

  log(
    'info',
    `Hub source loading complete for ${hubId}: ${added} added, ${updated} updated, ${skipped} skipped, ${removed} removed`
  );

  return { added, updated, skipped, removed };
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
