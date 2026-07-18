/**
 * Symlink Utilities
 *
 * Shared utilities for handling symbolic links, including detection of broken symlinks.
 *
 * IMPORTANT: fs.existsSync() returns false for broken symlinks (symlinks whose target
 * doesn't exist), which can cause issues during reinstallation/update flows. These
 * utilities use lstat() which can detect symlinks even when their target doesn't exist.
 */

import * as fs from 'node:fs';
import {
  promisify,
} from 'node:util';

const lstat = promisify(fs.lstat);
const fsStat = promisify(fs.stat);

/**
 * Result of checking if a path exists
 */
export interface PathExistsResult {
  /** Whether the path exists (including broken symlinks) */
  exists: boolean;
  /** Whether the path is a symbolic link */
  isSymbolicLink: boolean;
  /** Whether the symlink is broken (target doesn't exist) */
  isBroken: boolean;
}

/**
 * Check if a path exists, including broken symlinks.
 *
 * This function uses lstat() which can detect symlinks even when their target doesn't exist.
 * fs.existsSync() returns false for broken symlinks, which causes issues during reinstallation.
 * @param targetPath - The path to check
 * @returns Object with exists, isSymbolicLink, and isBroken flags
 * @example
 * ```typescript
 * const result = await checkPathExists('/path/to/symlink');
 * if (result.exists && result.isBroken) {
 *     // Handle broken symlink - remove and recreate
 *     await fs.promises.unlink('/path/to/symlink');
 * }
 * ```
 */
export async function checkPathExists(targetPath: string): Promise<PathExistsResult> {
  try {
    const stats = await lstat(targetPath);
    const isSymbolicLink = stats.isSymbolicLink();

    // Check if symlink target exists (to detect broken symlinks)
    let isBroken = false;
    if (isSymbolicLink) {
      try {
        // fsStat follows symlinks, so it will fail if target doesn't exist
        await fsStat(targetPath);
      } catch {
        isBroken = true;
      }
    }

    return { exists: true, isSymbolicLink, isBroken };
  } catch (error) {
    // ENOENT means the path doesn't exist at all (not even as a broken symlink)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, isSymbolicLink: false, isBroken: false };
    }
    // For other errors, re-throw
    throw error;
  }
}
