/**
 * In-process PrimitiveDiagnosticsDriver adapter.
 *
 * Maps each semantic driver operation of `doctor diagnostics --primitives`
 * onto the real command classes, dispatched in-process with a captured
 * Context pinned to the sandbox cwd and the sandboxed env
 * (`buildDiagnosticEnv`). It builds argv and parses the JSON envelope only;
 * every rule lives in core and every orchestration step in app.
 * @module doctor/primitive-driver
 */
import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import type {
  DiagnosticSandbox,
  DriverCommandResult,
  PreparedSandbox,
  PrimitiveDiagnosticsDriver,
} from '@ai-primitives-hub/core';
import {
  XdgAppStorage,
} from '@ai-primitives-hub/infra';
import type {
  CommandClass,
  Context,
} from '../framework';
import {
  buildDiagnosticEnv,
  createSandboxDirs,
  dispatchDiagnosticCommand,
  initializeGitRepository,
  materializeBundleArchive,
} from './diagnostics';

/** Options of the in-process driver. */
export interface InProcessPrimitiveDriverOptions {
  /** Parent CLI context; fs and the inherited env come from it. */
  ctx: Context;
  /** Command classes registered for each dispatch. */
  commandClasses: CommandClass[];
}

/** Per-user variables `buildDiagnosticEnv` points into the sandbox home. */
const USER_DIR_VARS = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'TEMP',
  'TMP'
] as const;

/** Snapshot roots taken from the env, most specific first (port order). */
const ENV_ROOTS = [
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'TMPDIR'
] as const;

/** Maximum length of the stderr tail reported for unparseable output. */
const STDERR_LIMIT = 500;

interface Envelope {
  status?: unknown;
  data?: unknown;
  warnings?: unknown;
  errors?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const parseEnvelope = (stdout: string): Envelope | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return isRecord(parsed) && typeof parsed.status === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read one command's JSON envelope into a driver result.
 * Failure reasons: (a) envelope `errors[]`, else (b) `status: 'error'` with
 * `data.errors: string[]` (collection validate's file/schema failures), else (c) none.
 * @param exitCode Command exit code.
 * @param stdout Captured stdout.
 * @param stderr Captured stderr.
 * @returns Driver result.
 */
const toDriverResult = <T>(exitCode: number, stdout: string, stderr: string): DriverCommandResult<T> => {
  const envelope = parseEnvelope(stdout);
  if (envelope === undefined) {
    return { exitCode, warnings: [], errorMessages: [stderr.slice(0, STDERR_LIMIT)] };
  }
  const result: DriverCommandResult<T> = {
    exitCode,
    status: envelope.status as DriverCommandResult['status'],
    data: envelope.data as T,
    warnings: isStringArray(envelope.warnings) ? envelope.warnings : [],
    errorMessages: []
  };
  const errors = Array.isArray(envelope.errors) ? envelope.errors.filter((entry) => isRecord(entry)) : [];
  if (errors.length > 0) {
    if (typeof errors[0].code === 'string') {
      result.errorCode = errors[0].code;
    }
    result.errorMessages = errors.map((entry) => String(entry.message));
  } else if (envelope.status === 'error' && isRecord(envelope.data) && isStringArray(envelope.data.errors)) {
    result.errorMessages = [...envelope.data.errors];
  }
  return result;
};

/**
 * Create the driver that runs every operation through the real CLI commands.
 * @param options Parent context and command classes.
 * @returns The driver.
 */
export const createInProcessPrimitiveDriver = (
  options: InProcessPrimitiveDriverOptions
): PrimitiveDiagnosticsDriver => {
  const { ctx, commandClasses } = options;
  const envFor = (sandbox: DiagnosticSandbox): Record<string, string | undefined> =>
    buildDiagnosticEnv(ctx, sandbox.home);
  const run = async <T>(sandbox: DiagnosticSandbox, argv: string[]): Promise<DriverCommandResult<T>> => {
    const { exitCode, stdout, stderr } = await dispatchDiagnosticCommand(
      ctx,
      commandClasses,
      argv,
      sandbox.cwd,
      envFor(sandbox)
    );
    return toDriverResult<T>(exitCode, stdout, stderr);
  };

  return {
    prepareSandbox: async (sandbox): Promise<PreparedSandbox> => {
      await createSandboxDirs(ctx.fs, sandbox.home);
      const env = envFor(sandbox);
      const userDirs: Record<string, string> = {};
      for (const name of USER_DIR_VARS) {
        userDirs[name] = env[name] ?? '';
      }
      userDirs.userConfigRoot = resolveUserConfigPaths(env).root;
      return {
        ...sandbox,
        roots: [
          ...ENV_ROOTS.map((name) => ({ label: `$${name}`, path: userDirs[name] })),
          { label: '$HOME', path: sandbox.home },
          { label: '<workspace>', path: sandbox.cwd },
          { label: '<case>', path: sandbox.root }
        ],
        storage: new XdgAppStorage(env).getPaths(),
        userDirs
      };
    },
    // A git failure throws inside the executor, so it surfaces as a rejection.
    commitFixtureRepository: (sandbox, input): Promise<void> => new Promise((resolve) => {
      initializeGitRepository(sandbox.cwd, envFor(sandbox), input.remoteUrl, input.executableFiles);
      resolve();
    }),
    validateCollection: (sandbox, input) =>
      run(sandbox, ['collection', 'validate', '--collection-file', input.collectionFile, '-o', 'json']),
    buildBundle: (sandbox, input) =>
      run(sandbox, [
        'bundle', 'build',
        '--collection-file', input.collectionFile,
        '--version', input.version,
        '--out-dir', input.outDir,
        '-o', 'json'
      ]),
    materializeBundle: (input) => materializeBundleArchive(ctx.fs, input.zipPath, input.destination),
    addTarget: (sandbox, input) =>
      run(sandbox, ['target', 'add', input.name, '--type', input.type, '--scope', input.scope, '-o', 'json']),
    install: (sandbox, input) =>
      run(sandbox, ['install', input.bundleId, '--from', input.from, '--target', input.target, '-o', 'json']),
    uninstall: (sandbox, input) =>
      run(sandbox, ['uninstall', '--target', input.target, '--all', '-o', 'json'])
  };
};
