/**
 * Bundle-source remap — moves installed-bundle references from an old
 * source id onto a new one after a hub renamed a source's `url` (which
 * changes the `generateSourceId(type, url, config)`-derived stored id and
 * leaves the pre-rename record orphaned).
 *
 * Extracted from the extension's
 * `RegistryManager.remapBundleSource` (`apps/vscode-extension/src/services/
 * registry-manager.ts`) so both delivery layers — and any other host
 * consuming the `app` SDK surface — share one implementation. Takes ports,
 * imports no `vscode`, touches no filesystem of its own.
 *
 * Resolution comes first, deliberately. The replacement source's descriptor
 * is resolved before any store is written, and an unresolvable replacement
 * throws while everything is still untouched. That ordering is what lets the
 * caller (`loadHubSources`) keep an orphan alive on failure instead of
 * deleting a source whose bundles were only half migrated.
 * @module registry/remap-bundle-source
 */
import type {
  BundleSourceRemap,
  InstallationScope,
  LockfileSourceDescriptor,
  LogEvent,
  OnLogEvent,
  RegistrySource,
} from '@ai-primitives-hub/core';

/**
 * Scopes whose installation records this use case rewrites itself.
 *
 * Repository scope is deliberately absent: its records live in the
 * lockfile, which the `remapLockfileSourceId` port owns.
 */
const RECORD_SCOPES: InstallationScope[] = ['user', 'workspace'];

/**
 * Remap installed bundles from `oldSourceId` onto `newSourceId`.
 *
 * Rejects — before writing anything — when `newSourceId` is absent from
 * stored sources, naming the missing id so the caller can report an
 * actionable reason.
 * @param oldSourceId Source id currently referenced by installed bundles.
 * @param newSourceId Source id the bundles should reference instead.
 * @param ports Registry read/write access needed for the remap.
 * @param onLog Optional sink for diagnostic log events.
 */
export async function remapBundleSource(
  oldSourceId: string,
  newSourceId: string,
  ports: BundleSourceRemap,
  onLog?: OnLogEvent
): Promise<void> {
  const log = (level: LogEvent['level'], message: string, error?: Error): void => {
    onLog?.({ level, message, error });
  };

  log('debug', `Remapping bundle source ${oldSourceId} -> ${newSourceId}`);

  const sources = await ports.listSources();
  const replacement: RegistrySource | undefined = sources.find((s) => s.id === newSourceId);

  if (!replacement) {
    throw new Error(
      `Cannot remap bundle source '${oldSourceId}': `
      + `replacement source '${newSourceId}' is not present in the registry`
    );
  }

  const descriptor: LockfileSourceDescriptor = {
    type: replacement.type,
    url: replacement.url,
    branch: replacement.config?.branch,
    collectionsPath: replacement.config?.collectionsPath
  };

  // Repository scope, owned by the lockfile port: it consumes the
  // descriptor to rewrite the lockfile's `sources` map alongside its bundle
  // entries. An absent port is a valid skip, not a failure — repository-scope
  // bundles only exist inside an open workspace, so with no repository in
  // scope there is nothing to migrate, and refusing here would block an
  // otherwise valid user-scope and workspace-scope remap.
  if (ports.remapLockfileSourceId) {
    await ports.remapLockfileSourceId(oldSourceId, newSourceId, descriptor);
  }

  // User then workspace scope. The `sourceId === oldSourceId` filter below is
  // the single mechanism at work here: it selects what to rewrite, and it is
  // also the whole of the idempotence guarantee — a record already carrying
  // the new id no longer matches, so a retry after a partial run completes
  // the remainder and leaves finished records byte-identical. No bookkeeping
  // of what was already done, and no second pass, is needed on top of it.
  let remapped = 0;
  for (const scope of RECORD_SCOPES) {
    const bundles = await ports.getInstalledBundles(scope);
    const referencing = bundles.filter((bundle) => bundle.sourceId === oldSourceId);

    for (const bundle of referencing) {
      // Only `sourceId` changes; every other field is carried over as-is.
      await ports.recordInstallation({ ...bundle, sourceId: newSourceId });
    }

    remapped += referencing.length;
  }

  log(
    'debug',
    `Bundle source remap complete: ${oldSourceId} -> ${newSourceId} (${remapped} record(s))`
  );
}
