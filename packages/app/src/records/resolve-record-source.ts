/**
 * Source trust gate for record replay and update (NFR4.11; nfr-design
 * security-design "Source trust gate").
 *
 * A record may come from a cloned repository, so its sources are not trusted:
 * 1. A configured source with the same id (active hub first, then detached
 *    sources; the caller builds the map in that order) always wins, with its
 *    own URL, branch and credentials.
 * 2. Otherwise the record's copy is used without `credentialRef` and
 *    `authMode`, so a fetch never reads an environment variable the record named.
 * 3. A `local` source from the record is resolved against the repository root
 *    when relative, realpath'd, and must stay inside the realpath'd root;
 *    otherwise the entry is skipped.
 *
 * The caller runs this once per entry before anything contacts a source (the
 * version lookup, any download, and under `--dry-run`), and uses the decided
 * source for both the lookup and the download.
 * @module records/resolve-record-source
 */
import * as path from 'node:path';
import type {
  RecordFs,
  RegistrySource,
  SourceRecord,
} from '@ai-primitives-hub/core';

/** Outcome of {@link resolveRecordSource}. */
export type SourceDecision =
  /** Fetch from this source; `sourceId` is the record key. */
  | { use: SourceRecord & { sourceId: string } }
  /** Do not fetch; skip the entry and report the reason. */
  | { skip: string };

/** Reason reported for a `local` record source that leaves the repository. */
export const LOCAL_SOURCE_OUTSIDE_REASON = 'local source outside the repository';

/** Optional string fields copied from a configured source's `config`. */
const CONFIGURED_FIELDS = ['branch', 'collectionsPath', 'indexFile', 'authMode', 'credentialRef'] as const;

/** Optional string fields kept from a record's copy; never credentials. */
const RECORD_FIELDS = ['branch', 'collectionsPath', 'indexFile'] as const;

/**
 * Whether a source type reads a folder on disk, kept in its `url`.
 * @param type - Source type.
 */
const isLocalType = (type: string): boolean => type === 'local' || type.startsWith('local-');

const isInside = (realRoot: string, candidate: string): boolean => {
  const relative = path.relative(realRoot, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

/**
 * The configured source as a record-shaped source, prototype-free.
 * @param sourceId - Record key.
 * @param configured - Configured source.
 */
const fromConfigured = (sourceId: string, configured: RegistrySource): SourceRecord & { sourceId: string } => {
  const source = Object.create(null) as SourceRecord & { sourceId: string };
  source.sourceId = sourceId;
  source.type = configured.type;
  source.url = configured.url;
  for (const field of CONFIGURED_FIELDS) {
    const value = configured.config?.[field];
    if (typeof value === 'string') {
      source[field] = value;
    }
  }
  return source;
};

/**
 * The record's copy without credentials, prototype-free.
 * @param sourceId - Record key.
 * @param fromRecord - Source as recorded.
 * @param url - URL to use.
 */
const fromRecordCopy = (sourceId: string, fromRecord: SourceRecord, url: string): SourceRecord & { sourceId: string } => {
  const source = Object.create(null) as SourceRecord & { sourceId: string };
  source.sourceId = sourceId;
  source.type = fromRecord.type;
  source.url = url;
  for (const field of RECORD_FIELDS) {
    const value = fromRecord[field];
    if (typeof value === 'string') {
      source[field] = value;
    }
  }
  return source;
};

/**
 * Realpath of a recorded `local` folder, when it stays inside the repository root.
 * @param fs - Filesystem port.
 * @param root - Repository root.
 * @param recordedPath - Recorded folder path, relative to the root or absolute.
 */
const confineLocalFolder = async (fs: RecordFs, root: string, recordedPath: string): Promise<string | undefined> => {
  try {
    const realRoot = await fs.realpath(root);
    const realFolder = await fs.realpath(path.resolve(root, recordedPath));
    return isInside(realRoot, realFolder) ? realFolder : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Decide which source an entry is replayed or updated from (NFR4.11).
 * @param sourceId - The entry's `sourceId`.
 * @param fromRecord - The record's copy of that source.
 * @param configured - Configured sources by id: the active hub's first, then detached sources.
 * @param root - Repository root a relative `local` path is resolved against.
 * @param fs - Filesystem port, for the `local` realpath check.
 * @returns The source to use, or why the entry is skipped.
 */
export const resolveRecordSource = async (
  sourceId: string,
  fromRecord: SourceRecord,
  configured: ReadonlyMap<string, RegistrySource>,
  root: string,
  fs: RecordFs
): Promise<SourceDecision> => {
  const match = configured.get(sourceId);
  if (match !== undefined) {
    return { use: fromConfigured(sourceId, match) };
  }
  if (!isLocalType(fromRecord.type)) {
    return { use: fromRecordCopy(sourceId, fromRecord, fromRecord.url) };
  }
  const folder = await confineLocalFolder(fs, root, fromRecord.url);
  return folder === undefined
    ? { skip: LOCAL_SOURCE_OUTSIDE_REASON }
    : { use: fromRecordCopy(sourceId, fromRecord, folder) };
};
