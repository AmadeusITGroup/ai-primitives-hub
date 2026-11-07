/**
 * Run the CLI built from this checkout, isolated from the developer's
 * environment.
 *
 * The child gets no `GIT_*` variable (see {@link gitFixtureEnv}) and its
 * home, XDG and AppData directories point below a test-owned directory, so
 * neither the developer's user configuration nor their repository leaks
 * into the run.
 */
import {
  execFile,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  gitFixtureEnv,
} from './git-test-helpers';
import {
  workspaceRoot,
} from './workspace-pack-helpers';

/** Entry script of the built CLI. */
export const CLI_BIN = path.join(workspaceRoot, 'packages', 'cli', 'bin', 'ai-primitives-hub.js');
const CLI_DIST = path.join(workspaceRoot, 'packages', 'cli', 'dist', 'index.js');
const CLI_TIMEOUT_MS = 60_000;

/** Options of {@link runBuiltCli}. */
export interface RunBuiltCliOptions {
  /** Working directory of the CLI. */
  cwd: string;
  /** Test-owned directory used as the CLI's home; config, data, cache and AppData live below it. */
  home: string;
  /** Extra variables, applied last. */
  env?: NodeJS.ProcessEnv;
}

/** Outcome of {@link runBuiltCli}. */
export interface CliRunResult {
  /** Exit code (`null` when killed). */
  code: number | null;
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
}

/**
 * Environment of an isolated CLI run.
 * @param home - Test-owned home directory.
 * @param extra - Extra variables, applied last.
 * @returns The environment.
 */
export const isolatedCliEnv = (home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...gitFixtureEnv(),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  ...extra
});

/**
 * Run `ai-primitives-hub <args>` with the CLI built from this checkout.
 * @param args - CLI arguments.
 * @param options - Working directory, isolated home and extra variables.
 * @returns Exit code and output; a non-zero exit is not an error.
 * @throws {Error} when the packages are not built.
 */
export const runBuiltCli = (args: readonly string[], options: RunBuiltCliOptions): Promise<CliRunResult> => {
  if (!fs.existsSync(CLI_DIST)) {
    return Promise.reject(new Error('Build the packages first: pnpm -C packages -r build'));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI_BIN, ...args], {
      cwd: options.cwd,
      env: isolatedCliEnv(options.home, options.env),
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(new Error(`ai-primitives-hub ${args.join(' ')} did not run: ${error.message}\n${stderr}`));
        return;
      }
      resolve({ code: child.exitCode, stdout, stderr });
    });
    child.stdin?.end();
  });
};

/**
 * Run the built CLI and fail with its output unless it exits with 0.
 * @param args - CLI arguments.
 * @param options - See {@link runBuiltCli}.
 * @returns The run's output.
 */
export const runBuiltCliOk = async (args: readonly string[], options: RunBuiltCliOptions): Promise<CliRunResult> => {
  const result = await runBuiltCli(args, options);
  if (result.code !== 0) {
    throw new Error(`ai-primitives-hub ${args.join(' ')} exited with ${String(result.code)} in ${options.cwd}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
};
