/**
 * Adapters from install record shapes to the legacy lockfile shapes that the
 * fetch, update and listing code reads, shared by the CLI and the extension.
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
 * A record source in the legacy lockfile source shape.
 * @param source - Record source.
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
 * A record tool entry in the legacy lockfile bundle shape, without an archive checksum.
 * @param entry - Record tool entry.
 */
export const toLockfileBundleEntry = (entry: ToolEntry): LockfileBundleEntry => ({
  version: entry.version,
  sourceId: entry.sourceId,
  sourceType: entry.sourceType,
  installedAt: entry.installedAt,
  files: entry.files.map((file) => ({ path: file.path, checksum: file.checksum }))
});
