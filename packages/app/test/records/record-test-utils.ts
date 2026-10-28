/**
 * Shared helpers for the install-record tests: real temp folders, git
 * folders, fixtures and symlink support detection.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RegistryError,
} from '@ai-primitives-hub/core';
import {
  expect,
} from 'vitest';

/**
 * Create a temp folder under the OS temp dir, not realpath'd (on macOS it sits
 * under `/var`, a symlink to `/private/var`).
 * @param prefix - Folder name prefix.
 * @returns The folder and a cleanup function.
 */
export const createTempDir = (prefix: string): [string, () => void] => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return [dir, () => fs.rmSync(dir, { recursive: true, force: true })];
};

/**
 * Turn a folder into a minimal git repository (`.git/HEAD`).
 * @param dir - Folder.
 * @returns The `.git` folder.
 */
export const makeGitDir = (dir: string): string => {
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  return gitDir;
};

/**
 * Text of a fixture under `test/records/fixtures/`.
 * @param name - Fixture file name.
 */
export const fixtureText = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/**
 * Whether this machine can create symlinks (Windows without the privilege cannot).
 * @param dir - Writable folder to probe in.
 */
export const canSymlink = (dir: string): boolean => {
  const link = path.join(dir, `.symlink-probe-${process.pid}`);
  try {
    fs.symlinkSync(dir, link, 'junction');
    fs.unlinkSync(link);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether this machine can create file symlinks (on Windows they need a privilege; `EPERM` otherwise).
 * @param dir - Writable folder to probe in.
 */
export const canSymlinkFile = (dir: string): boolean => {
  const link = path.join(dir, `.file-symlink-probe-${process.pid}`);
  try {
    fs.symlinkSync(path.join(dir, 'missing-target'), link, 'file');
    fs.unlinkSync(link);
    return true;
  } catch {
    return false;
  }
};

/**
 * Create a folder symlink (a junction on Windows).
 * @param target - Existing folder.
 * @param link - Link path.
 */
export const symlinkDir = (target: string, link: string): void => {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
};

/**
 * Await a promise that must reject with a `RegistryError` of `code`.
 * @param promise - Operation under test.
 * @param code - Expected `RECORD.*` code.
 * @returns The error.
 */
export const expectRecordError = async (promise: Promise<unknown>, code: string): Promise<RegistryError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe(code);
    return error as RegistryError;
  }
  throw new Error(`expected ${code}`);
};
