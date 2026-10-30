/**
 * Locally modified installed files (NFR4.13; nfr-design security-design
 * "Modified files" and "Old-file rows").
 *
 * An installed file counts as modified when its bytes no longer match the
 * checksum recorded for it, or when it is gone. Callers keep modified files:
 * uninstall and update subtract them from the delete list and report them,
 * and the local-modification warning lists them. It works for record entries
 * and for old `prompt-registry` entries alike: a bare 64-hex checksum (the
 * old-file form) compares as `sha256:<hex>`.
 *
 * Every path goes through the delete-time confinement check first. A path
 * the check refuses, a leaf that is not a regular file (a symlink is never
 * followed) and a file with no recorded checksum are all treated as modified,
 * so they are kept rather than deleted.
 * @module records/modified-files
 */
import * as path from 'node:path';
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
  /**
   * `sha256:` plus 64 lowercase hex digits, or the bare 64-hex digest old
   * `prompt-registry` lockfiles store; absent for an old entry that never recorded one.
   */
  checksum?: string;
}

/** A bare SHA-256 hex digest, as old `prompt-registry` lockfiles store it. */
const BARE_SHA256 = /^[0-9a-f]{64}$/;

/**
 * A recorded checksum in the record's `sha256:<hex>` form; a bare 64-hex
 * digest gets the prefix, anything else is returned as is.
 * @param checksum - Checksum as recorded.
 */
const toRecordChecksum = (checksum: string): string => BARE_SHA256.test(checksum) ? `sha256:${checksum}` : checksum;

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
    return (await fs.hashFile(target.absolute)) !== toRecordChecksum(file.checksum);
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

/**
 * Whether every recorded file is missing (BR12.2): the stale-entry rule. An
 * entry listing no file is not stale. A path that cannot be checked counts
 * as present, so an entry is never offered for removal on an I/O error.
 * @param fs - Filesystem port.
 * @param root - Root the paths are relative to.
 * @param paths - Root-relative recorded paths, forward slashes.
 */
export const areAllFilesMissing = async (fs: RecordFs, root: string, paths: readonly string[]): Promise<boolean> => {
  if (paths.length === 0) {
    return false;
  }
  for (const recordedPath of paths) {
    try {
      if (await fs.lstat(path.join(root, ...recordedPath.split('/'))) !== undefined) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
};
