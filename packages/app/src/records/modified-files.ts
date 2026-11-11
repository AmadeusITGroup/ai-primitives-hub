/**
 * Locally modified installed files: content that no longer matches the
 * recorded checksum, or a missing file. Callers keep them instead of deleting.
 * A path that fails confinement, is not a regular file or has no checksum
 * counts as modified, so it is kept.
 * @module records/modified-files
 */
import * as path from 'node:path';
import type {
  RecordFs,
} from '@ai-primitives-hub/core';
import {
  resolveDeleteTarget,
} from './confine-path';

/** A recorded file to check. */
export interface RecordedFileCheck {
  /** Path relative to the root, forward slashes. */
  path: string;
  /** `sha256:<hex>`, or the bare hex digest old lockfiles store. */
  checksum?: string;
}

/** A bare SHA-256 hex digest, as old `prompt-registry` lockfiles store it. */
const BARE_SHA256 = /^[0-9a-f]{64}$/;

const toRecordChecksum = (checksum: string): string => BARE_SHA256.test(checksum) ? `sha256:${checksum}` : checksum;

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
 * The recorded files that changed since the install or are missing, sorted.
 * @param fs - Filesystem port.
 * @param root - Root the paths are relative to.
 * @param files - Recorded files with their checksums.
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
 * Whether every recorded file is missing, the stale-entry rule. A path that
 * cannot be checked counts as present.
 * @param fs - Filesystem port.
 * @param root - Root the paths are relative to.
 * @param paths - Root-relative recorded paths.
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

/**
 * Whether any recorded file is missing. A path that cannot be checked counts as present.
 * @param fs - Filesystem port.
 * @param root - Root the paths are relative to.
 * @param paths - Root-relative recorded paths.
 * @param onError - Called for a path whose check failed.
 */
export const isAnyFileMissing = async (
  fs: RecordFs,
  root: string,
  paths: readonly string[],
  onError?: (recordedPath: string, error: unknown) => void
): Promise<boolean> => {
  for (const recordedPath of paths) {
    try {
      if (await fs.lstat(path.join(root, ...recordedPath.split('/'))) === undefined) {
        return true;
      }
    } catch (error) {
      onError?.(recordedPath, error);
    }
  }
  return false;
};
