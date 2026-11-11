/** Fixtures for CLI tests that run commands in a temp workspace and read the repository or user install record. */
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import {
  emptyLockfile,
  type LockfileSourceEntry,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from '@ai-primitives-hub/app';
import {
  type InstallRecord,
  RECORD_FILE_NAME,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import {
  runCommand,
  type RunCommandOptions,
  type RunCommandResult,
} from '../../src/framework';

/** Runs one command line in a test workspace. */
export type RunInWorkspace = (argv: string[]) => Promise<Pick<RunCommandResult, 'exitCode' | 'stdout'>>;

/**
 * A test workspace environment with home and XDG folders inside it, so the real user config is never touched.
 * @param workspace - Workspace folder.
 * @param extra - More variables.
 */
export const workspaceEnv = (workspace: string, extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: workspace,
  USERPROFILE: workspace,
  XDG_CONFIG_HOME: path.join(workspace, 'xdg-config'),
  XDG_CACHE_HOME: path.join(workspace, 'xdg-cache'),
  ...extra
});

/**
 * A runner for command lines in a workspace, on the real filesystem.
 * @param workspace - Returns the workspace folder; read on every run.
 * @param commandClasses - Commands to register.
 * @param env - More environment variables.
 */
export const makeRun = (
  workspace: () => string,
  commandClasses: NonNullable<RunCommandOptions['commandClasses']>,
  env: Record<string, string> = {}
): ((argv: string[]) => Promise<RunCommandResult>) => (argv) => runCommand(argv, {
  commandClasses,
  context: { cwd: workspace(), fs: new NodeFileSystem(), env: workspaceEnv(workspace(), env) }
});

/**
 * Run a command line that must succeed.
 * @param run - Runner.
 * @param argv - Command line.
 * @throws {Error} With the output, when the command exits non-zero.
 */
const runOk = async (run: RunInWorkspace, argv: string[]): Promise<void> => {
  const result = await run(argv);
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stdout}`);
  }
};

/**
 * Add repository-scope targets and, given a bundle folder, install it with each in order.
 * @param run - Runner with `target add` (and `install` when installing).
 * @param workspace - Workspace folder, the targets' root.
 * @param targets - Target name and type pairs.
 * @param install - Bundle to install with each target, in the order given.
 * @param install.bundleDir - Local bundle folder (`install --from`).
 * @param install.bundleId - Bundle id; `local-foo` by default.
 */
export const addRepositoryTargets = async (
  run: RunInWorkspace,
  workspace: string,
  targets: readonly (readonly [name: string, type: string])[],
  install?: { bundleDir: string; bundleId?: string }
): Promise<void> => {
  for (const [name, type] of targets) {
    await runOk(run, ['target', 'add', name, '--type', type, '--scope', 'repository', '--workspace-root', workspace, '-o', 'json']);
  }
  if (install !== undefined) {
    for (const [name] of targets) {
      await runOk(run, ['install', install.bundleId ?? 'local-foo', '--from', install.bundleDir, '--target', name, '-o', 'json']);
    }
  }
};

/**
 * Mark a folder as a git root: a `.git` folder holding `HEAD`.
 * @param dir - Folder to mark.
 */
export const initGitRoot = async (dir: string): Promise<void> => {
  await mkdir(path.join(dir, '.git'), { recursive: true });
  await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
};

/**
 * Turn a git root into a linked worktree whose common git dir holds `info/exclude`.
 * @param dir - Git root made by {@link initGitRoot}.
 * @returns The common git dir.
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
export const readRecord = <T = InstallRecord>(dir: string, fileName?: string): Promise<T> =>
  readInstallRecord<T>(recordPathIn(dir, fileName));

/**
 * Read and parse a record file at any path, e.g. the shared user record.
 * @param file - Absolute record path.
 */
export const readInstallRecord = async <T = InstallRecord>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, 'utf8')) as T;

/**
 * Path of the shared user record for an environment.
 * @param env - Environment with the XDG and home folders.
 */
export const userRecordPath = (env: Record<string, string | undefined>): string =>
  new XdgAppStorage(env).getPaths().userRecord;

/**
 * Write a record file at a repository root, as a test edits it.
 * @param dir - Repository root.
 * @param record - Record content.
 * @param fileName - Record file name; the committed record by default.
 */
export const writeRecord = (dir: string, record: unknown, fileName?: string): Promise<void> =>
  writeFile(recordPathIn(dir, fileName), JSON.stringify(record, null, 2) + '\n');

/** One bundle entry {@link writeOldLockfile} writes. */
export interface OldLockfileEntry {
  version: string;
  /** Paths the entry lists, each with a zero checksum; none by default. */
  files?: readonly string[];
  /** `old-src` by default. */
  sourceId?: string;
  /** `local` by default. */
  sourceType?: string;
}

/**
 * Write an old 2.0.0 lockfile; the files it lists are not written.
 * @param file - Absolute lockfile path.
 * @param bundles - Bundle id → entry.
 * @param sources - The lockfile's `sources`; none by default.
 * @returns The text written, for byte-identical checks.
 */
export const writeOldLockfile = async (
  file: string,
  bundles: Record<string, OldLockfileEntry>,
  sources: Record<string, LockfileSourceEntry> = {}
): Promise<string> => {
  let lock = emptyLockfile('test');
  for (const [bundleId, entry] of Object.entries(bundles)) {
    lock = upsertBundleEntry(lock, bundleId, {
      version: entry.version,
      sourceId: entry.sourceId ?? 'old-src',
      sourceType: entry.sourceType ?? 'local',
      installedAt: '2026-10-01T00:00:00.000Z',
      files: (entry.files ?? []).map((recorded) => ({ path: recorded, checksum: '0'.repeat(64) }))
    });
  }
  for (const [sourceId, source] of Object.entries(sources)) {
    lock = upsertSource(lock, sourceId, source);
  }
  await writeLockfile(file, lock, new NodeFileSystem());
  return readFile(file, 'utf8');
};
