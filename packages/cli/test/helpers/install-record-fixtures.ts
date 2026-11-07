/** Fixtures for CLI tests that read the install record from a real temp git root. */
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import {
  type InstallRecord,
  RECORD_FILE_NAME,
} from '@ai-primitives-hub/core';

/**
 * Mark a folder as a git root: a `.git` folder holding `HEAD`.
 * @param dir - Folder to mark.
 */
export const initGitRoot = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, '.git'), { recursive: true });
  await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
};

/**
 * Path of a record file at a repository root.
 * @param dir - Repository root.
 * @param fileName - Defaults to the committed record.
 */
export const recordPathIn = (dir: string, fileName: string = RECORD_FILE_NAME): string => path.join(dir, fileName);

/**
 * Read and parse a record file at a repository root.
 * @param dir - Repository root.
 * @param fileName - Defaults to the committed record.
 */
export const readRecord = async (dir: string, fileName?: string): Promise<InstallRecord> =>
  JSON.parse(await readFile(recordPathIn(dir, fileName), 'utf8')) as InstallRecord;
