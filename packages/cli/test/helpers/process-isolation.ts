/**
 * Process-level isolation hooks for doctor diagnostics tests.
 *
 * Registers `beforeEach`/`afterEach` hooks that give the test process a
 * fresh, throwaway HOME and temp dir with no XDG vars set, so every XDG
 * fallback (`os.homedir()`, `os.tmpdir()`) points into a sandbox the test
 * can inspect afterwards. `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP
 * on Windows. The original values are restored after each test.
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
} from 'vitest';

/** Every per-user variable the diagnostics sandbox roots. */
export const SANDBOX_VARS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'TEMP',
  'TMP'
] as const;

/** Directories of the current test's isolated process. */
export interface ProcessIsolation {
  /** Throwaway root holding `home` and `tmp`. */
  readonly sandbox: string;
  /** The process HOME / USERPROFILE during the test. */
  readonly processHome: string;
  /** The process TMPDIR / TEMP / TMP during the test. */
  readonly processTmp: string;
}

/**
 * List a directory tree, sorted.
 * @param root Directory.
 * @returns Relative entry paths.
 */
export const listTree = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { recursive: true });
  return entries.map(String).toSorted();
};

/**
 * Register the isolation hooks in the enclosing `describe`.
 * @returns Live view of the current test's directories.
 */
export const useProcessIsolation = (): ProcessIsolation => {
  const state = { sandbox: '', processHome: '', processTmp: '' };
  const saved: Partial<Record<string, string>> = {};

  beforeEach(async () => {
    state.sandbox = await mkdtemp(path.join(os.tmpdir(), 'cli-doctor-isolation-'));
    state.processHome = path.join(state.sandbox, 'home');
    state.processTmp = path.join(state.sandbox, 'tmp');
    await mkdir(state.processHome, { recursive: true });
    await mkdir(state.processTmp, { recursive: true });
    for (const name of SANDBOX_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    process.env.HOME = state.processHome;
    process.env.USERPROFILE = state.processHome;
    process.env.TMPDIR = state.processTmp;
    process.env.TEMP = state.processTmp;
    process.env.TMP = state.processTmp;
  });

  afterEach(async () => {
    for (const name of SANDBOX_VARS) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    await rm(state.sandbox, { recursive: true, force: true });
  });

  return {
    get sandbox(): string {
      return state.sandbox;
    },
    get processHome(): string {
      return state.processHome;
    },
    get processTmp(): string {
      return state.processTmp;
    }
  };
};
