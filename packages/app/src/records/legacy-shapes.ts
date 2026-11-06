/**
 * Adapters from install record shapes to the legacy lockfile shapes
 * (`prompt-registry.*`, format 2.0.0) that today's fetch, update and listing
 * code reads. The CLI and the extension both use them, so a record entry
 * looks the same to old code everywhere.
 * @module records/legacy-shapes
 */
import type {
  SourceRecord,
  ToolEntry,
} from '@ai-primitives-hub/core';
import type {
  LockfileBundleEntry,
  LockfileSourceEntry,
} from '../stores/json-lockfile-store';

/**
 * A record source in the legacy lockfile source shape. Only the fields the
 * record carries are copied; an `authMode` other than `bearer` /
 * `anonymous` is dropped.
 * @param source - Source from `resolveRecordSource` (or a record's copy).
 * @returns The legacy source entry.
 */
export const toLockfileSourceEntry = (source: SourceRecord): LockfileSourceEntry => ({
  type: source.type,
  url: source.url,
  ...(typeof source.branch === 'string' ? { branch: source.branch } : {}),
  ...(typeof source.collectionsPath === 'string' ? { collectionsPath: source.collectionsPath } : {}),
  ...(typeof source.indexFile === 'string' ? { indexFile: source.indexFile } : {}),
  ...(source.authMode === 'bearer' || source.authMode === 'anonymous' ? { authMode: source.authMode } : {}),
  ...(typeof source.credentialRef === 'string' ? { credentialRef: source.credentialRef } : {})
});

/**
 * A record tool entry in the legacy lockfile bundle shape. Record entries
 * carry per-file checksums and no bundle archive checksum, so the legacy
 * archive checksum check does not apply; `recordInstall` re-checksums the
 * written files.
 * @param entry - Tool entry from a 3.0.0 record.
 * @returns The legacy bundle entry.
 */
export const toLockfileBundleEntry = (entry: ToolEntry): LockfileBundleEntry => ({
  version: entry.version,
  sourceId: entry.sourceId,
  sourceType: entry.sourceType,
  installedAt: entry.installedAt,
  files: entry.files.map((file) => ({ path: file.path, checksum: file.checksum }))
});
