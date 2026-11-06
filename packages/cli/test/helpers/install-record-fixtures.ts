/** Fixtures for CLI tests that read the install record from a real temp git root. */
import {
  mkdir,
  readFile,
  rm,
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
 * Turn a git root into a linked worktree: `.git` becomes a file pointing at a
 * git dir under `main.git/worktrees/wt`, whose `commondir` holds `info/exclude`.
 * @param dir - Git root made by {@link initGitRoot}.
 * @returns The common git dir; its `info/exclude` is the worktree's exclude file.
 */
export const makeGitWorktree = async (dir: string): Promise<string> => {
  const commonDir = path.join(dir, 'main.git');
  const worktreeGitDir = path.join(commonDir, 'worktrees', 'wt');
  await mkdir(worktreeGitDir, { recursive: true });
  await writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n');
  await rm(path.join(dir, '.git'), { recursive: true, force: true });
  await writeFile(path.join(dir, '.git'), `gitdir: ${worktreeGitDir}\n`);
  return commonDir;
};

/**
 * The lines of a common git dir's `info/exclude`.
 * @param commonDir - Common git dir from {@link makeGitWorktree}.
 * @returns The file's lines.
 */
export const readExcludeLines = async (commonDir: string): Promise<string[]> =>
  (await readFile(path.join(commonDir, 'info', 'exclude'), 'utf8')).split('\n');

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
