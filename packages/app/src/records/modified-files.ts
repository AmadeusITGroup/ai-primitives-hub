/**
 * Locally modified installed files (NFR4.13; nfr-design security-design
 * "Modified files" and "Old-file rows").
 *
 * An installed file counts as modified when its bytes no longer match the
 * checksum recorded for it, or when it is gone. Callers keep modified files:
 * uninstall and update subtract them from the delete list and report them,
 * and the local-modification warning lists them. It works for record entries
 * and for old `prompt-registry` entries alike, since both carry `sha256:`
 * checksums.
 *
 * Every path goes through the delete-time confinement check first. A path
 * the check refuses, a leaf that is not a regular file (a symlink is never
 * followed) and a file with no recorded checksum are all treated as modified,
 * so they are kept rather than deleted.
 * @module records/modified-files
 */
import type {
  RecordFs,
} from '@ai-primitives-hub/core';
import {
  resolveDeleteTarget,
} from './confine-path';

/** A recorded file to check: its root-relative path and, when known, its checksum. */
export interface RecordedFileCheck {
  /** Path relative to the root, forward slashes. */
  path: string;
  /** `sha256:` plus 64 lowercase hex digits; absent for an old entry that never recorded one. */
  checksum?: string;
}

/**
 * Whether one recorded file differs from its checksum or is missing.
 * @param fs - Filesystem port.
 * @param root - Root the paths are relative to.
 * @param file - Recorded file.
 */
const isModified = async (fs: RecordFs, root: string, file: RecordedFileCheck): Promise<boolean> => {
  const target = await resolveDeleteTarget(fs, root, file.path);
  if (target.status !== 'delete') {
    return true;
  }
  if (file.checksum === undefined || (await fs.lstat(target.absolute))?.kind !== 'file') {
    return true;
  }
  try {
    return (await fs.hashFile(target.absolute)) !== file.checksum;
  } catch {
    // A file that cannot be read cannot be shown to be unchanged: keep it.
    return true;
  }
};

/**
 * The recorded files whose content no longer matches the recorded checksum,
 * or that are missing (NFR4.13).
 * @param fs - Filesystem port; `hashFile` gives the current checksum.
 * @param root - Root the paths are relative to (the git root for a repository record).
 * @param files - Recorded files with their checksums.
 * @returns The modified paths, without duplicates, sorted.
 */
export const findModifiedFiles = async (fs: RecordFs, root: string, files: readonly RecordedFileCheck[]): Promise<string[]> => {
  const modified = new Set<string>();
  for (const file of files) {
    if (!modified.has(file.path) && await isModified(fs, root, file)) {
      modified.add(file.path);
    }
  }
  return [...modified].toSorted();
};
