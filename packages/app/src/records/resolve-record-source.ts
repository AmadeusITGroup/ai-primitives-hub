/**
 * Source trust gate for record replay and update. A record may come from a
 * cloned repository, so a configured source with the same id wins; otherwise
 * the recorded copy is used without credentials, and a `local` folder must stay
 * inside the repository.
 * @module records/resolve-record-source
 */
import * as path from 'node:path';
import {
  type RecordFs,
  type RegistrySource,
  relativeInside,
  type SourceRecord,
} from '@ai-primitives-hub/core';
import {
  copySourceFields,
  SOURCE_FIELDS_WITHOUT_CREDENTIALS,
} from './source-fields';
import {
  toRecordSource,
} from './to-record-source';

/** Outcome of {@link resolveRecordSource}. */
export type SourceDecision =
  /** Fetch from this source; `sourceId` is the record key. */
  | { use: SourceRecord & { sourceId: string } }
  /** Do not fetch; skip the entry and report the reason. */
  | { skip: string };

/** Reason reported for a `local` record source that leaves the repository. */
export const LOCAL_SOURCE_OUTSIDE_REASON = 'local source outside the repository';

const isLocalType = (type: string): boolean => type === 'local' || type.startsWith('local-');

/**
 * The record's copy without credentials, prototype-free.
 * @param sourceId - Record key.
 * @param fromRecord - Source as recorded.
 * @param url - URL to use.
 */
const fromRecordCopy = (sourceId: string, fromRecord: SourceRecord, url: string): SourceRecord & { sourceId: string } =>
  Object.assign(copySourceFields(fromRecord, fromRecord.type, url, SOURCE_FIELDS_WITHOUT_CREDENTIALS), { sourceId });

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
    // The repository root itself is an allowed local source folder.
    return relativeInside(realRoot, realFolder, { allowRoot: true }) === undefined ? undefined : realFolder;
  } catch {
    return undefined;
  }
};

/**
 * Whether a `local` source folder stays inside the repository root once every
 * symlink is resolved.
 * @param fs - Filesystem port.
 * @param root - Repository root.
 * @param localPath - The source's folder, relative to the root or absolute.
 */
export const isLocalSourceInsideRoot = async (fs: RecordFs, root: string, localPath: string): Promise<boolean> =>
  (await confineLocalFolder(fs, root, localPath)) !== undefined;

/**
 * Decide which source an entry is replayed or updated from.
 * @param sourceId - The entry's `sourceId`.
 * @param fromRecord - The record's copy of that source.
 * @param configured - Configured sources by id, active hub first.
 * @param root - Repository root.
 * @param fs - Filesystem port.
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
    // Normalised as an install records it, so older records are re-recorded the same way.
    return { use: toRecordSource(match, sourceId) };
  }
  if (!isLocalType(fromRecord.type)) {
    return { use: fromRecordCopy(sourceId, fromRecord, fromRecord.url) };
  }
  // Same check as `isLocalSourceInsideRoot`, keeping the realpath it resolved.
  const folder = await confineLocalFolder(fs, root, fromRecord.url);
  return folder === undefined
    ? { skip: LOCAL_SOURCE_OUTSIDE_REASON }
    : { use: fromRecordCopy(sourceId, fromRecord, folder) };
};
