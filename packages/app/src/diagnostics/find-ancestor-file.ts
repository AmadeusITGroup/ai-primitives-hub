/**
 * Preflight helper of `doctor diagnostics --primitives`: find a stray
 * project config, layouts file or lockfile above the run workspace.
 *
 * The project config and the layouts file are found by upward walks
 * (infra `findProjectConfigPath`, `LayoutConfigStore`), so a stray one
 * would be read, and `ai-primitives-hub.yml` written, outside the sandbox.
 * The lockfile names are defence in depth. Reads only.
 * @module diagnostics/find-ancestor-file
 */
import * as path from 'node:path';
import type {
  FileSystem,
} from '@ai-primitives-hub/core';
import {
  LAYOUTS_CONFIG_FILE,
} from '@ai-primitives-hub/infra';
import {
  LOCAL_LOCKFILE_NAME,
  LOCKFILE_NAME,
} from '../stores/json-lockfile-store';

/** Files that must not exist above the diagnostic workspace. */
export const PRIMITIVE_DIAGNOSTICS_PREFLIGHT_FILES: readonly string[] = [
  'ai-primitives-hub.yml',
  'ai-primitives-hub.yaml',
  LAYOUTS_CONFIG_FILE,
  LOCKFILE_NAME,
  LOCAL_LOCKFILE_NAME
];

/**
 * Walk up from `start` to the filesystem root and return the first listed
 * file found. `start` itself is checked first. Writes nothing.
 * @param fs - Filesystem (only `exists` is used).
 * @param start - Absolute directory to start from.
 * @param names - File names to look for, checked in order in each directory.
 * @returns The absolute path of the first hit, or undefined.
 */
export async function findAncestorFile(
  fs: Pick<FileSystem, 'exists'>,
  start: string,
  names: readonly string[]
): Promise<string | undefined> {
  let dir = start;
  while (true) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await fs.exists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
