/**
 * Doctor diagnostics runner.
 *
 * `doctor diagnostics` runs a self-contained end-to-end smoke test in a
 * temporary directory, exercising the same command sequence as the E2E user
 * flow script. It is fully idempotent and re-entrant: every run creates a
 * fresh temp workspace, and every run cleans up that workspace before exiting.
 *
 * The runner captures stdout/stderr and exit code for each step, so the
 * diagnostic report can show exactly what the system saw and produced.
 * @module doctor/diagnostics
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  CommandClass,
} from 'clipanion';
import {
  HubAddCommand,
  HubSyncCommand,
  HubUseCommand,
} from '../commands/hub';
import {
  IndexBuildCommand,
} from '../commands/index-build';
import {
  IndexSearchCommand,
} from '../commands/index-search';
import {
  InstallCommand,
} from '../commands/install';
import {
  ProfileActivateCommand,
  ProfileDeactivateCommand,
  ProfileListCommand,
} from '../commands/profile';
import {
  StatusCommand,
} from '../commands/status';
import {
  TargetAddCommand,
} from '../commands/target-add';
import {
  UninstallCommand,
} from '../commands/uninstall';
import type {
  CapturedOutputStream,
  Context,
  FsAbstraction,
} from '../framework';
import {
  runCli,
} from '../framework';

/** Public input options for the diagnostics runner. */
export interface DiagnosticsOptions {
  /** Parent CLI context — env, fs, and stdout/stderr are derived from it. */
  ctx: Context;
  /** Native clipanion command classes to register for the run. */
  commandClasses: CommandClass[];
  /** Print extra per-step progress to the parent stderr. */
  verbose?: boolean;
}

/** A single step in the diagnostic report. */
export interface DiagnosticStep {
  /** Human-readable step name. */
  name: string;
  /** Argument vector dispatched to the CLI. */
  argv: string[];
  /** Exit code returned by the CLI dispatcher. */
  exitCode: number;
  /** Captured stdout content. */
  stdout: string;
  /** Captured stderr content. */
  stderr: string;
  /** Free-form input context captured before the step (never secrets). */
  input?: Record<string, unknown>;
  /** Free-form output summary captured after the step. */
  output?: Record<string, unknown>;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/** Aggregate result from the diagnostics run. */
export interface DiagnosticsResult {
  /** True when every step exited 0. */
  ok: boolean;
  /** Absolute path of the temporary workspace used. */
  workspace: string;
  /** Per-step detailed log. */
  steps: DiagnosticStep[];
  /** Human-readable summary line. */
  summary: string;
}

const createCapturingStream = (): CapturedOutputStream => {
  let buffer = '';
  return {
    write: (chunk: string): void => {
      buffer += chunk;
    },
    captured: (): string => buffer
  };
};

/**
 * Build a child Context that shares the parent's real fs/net but redirects
 * stdout/stderr to a capture buffer and pins cwd/env to the diagnostic
 * workspace.
 * @param parent Parent production context.
 * @param cwd Workspace directory for this command.
 * @param env Environment bag for this command.
 * @returns A context suitable for `runCli`.
 */
interface StepContext extends Context {
  stdout: CapturedOutputStream;
  stderr: CapturedOutputStream;
}

const createStepContext = (
  parent: Context,
  cwd: string,
  env: Record<string, string | undefined>
): StepContext => {
  const stdout = createCapturingStream();
  const stderr = createCapturingStream();
  return {
    ...parent,
    stdout,
    stderr,
    cwd: (): string => cwd,
    env: Object.freeze(env) as Context['env']
  };
};

/**
 * Run a single command inside the diagnostic workspace and capture the
 * result. Optionally returns the captured output streams separately so the
 * caller can forward them to the parent.
 * @param opts Runner options.
 * @param workspace Diagnostic workspace directory.
 * @param name Step name for the report.
 * @param argv Command argument vector.
 * @param input Optional input context to record in the report.
 * @returns Step result.
 */
const runDiagnosticStep = async (
  opts: DiagnosticsOptions,
  workspace: string,
  name: string,
  argv: string[],
  input?: Record<string, unknown>
): Promise<DiagnosticStep> => {
  const env = buildDiagnosticEnv(opts.ctx, workspace);
  const stepCtx = createStepContext(opts.ctx, workspace, env);
  const started = Date.now();

  const exitCode = await runCli(argv, {
    ctx: stepCtx,
    name: 'prompt-registry',
    version: '1.0.0',
    commands: [],
    commandClasses: opts.commandClasses
  });

  const durationMs = Date.now() - started;

  if (opts.verbose && exitCode !== 0) {
    opts.ctx.stderr.write(
      `  [diagnostics] ${name} exited ${String(exitCode)}\n`
      + `    stdout: ${stepCtx.stdout.captured().slice(0, 500)}\n`
      + `    stderr: ${stepCtx.stderr.captured().slice(0, 500)}\n`
    );
  }

  return {
    name,
    argv,
    exitCode,
    stdout: stepCtx.stdout.captured(),
    stderr: stepCtx.stderr.captured(),
    input,
    durationMs
  };
};

/**
 * Resolve the base workspace path for this run. The directory is not created
 * here; callers create and clean it.
 * @returns Absolute path.
 */
const resolveWorkspacePath = (): string => {
  const tmp = os.tmpdir();
  const stamp = `${Date.now()}-${String(Math.random()).slice(2, 8)}`;
  return path.join(tmp, `prompt-registry-doctor-${stamp}`);
};

/**
 * Build an environment bag that isolates XDG config/cache inside the
 * workspace, so the diagnostic run never mutates the user's real
 * prompt-registry state.
 * @param parent Parent context.
 * @param workspace Diagnostic workspace.
 * @returns Environment bag.
 */
const buildDiagnosticEnv = (
  parent: Context,
  workspace: string
): Record<string, string | undefined> => {
  const base = parent.env as Record<string, string | undefined>;
  return {
    ...base,
    XDG_CONFIG_HOME: path.join(workspace, 'xdg'),
    XDG_CACHE_HOME: path.join(workspace, 'cache'),
    HOME: workspace,
    USERPROFILE: workspace
  };
};

/**
 * Prepare the temporary workspace with the synthetic bundle and local hub
 * configuration used by the diagnostic steps.
 * @param ctx Context with real fs.
 * @param workspace Workspace directory.
 * @returns Object describing the created fixtures.
 */
const prepareWorkspace = async (
  ctx: Context,
  workspace: string
): Promise<{
  bundleDir: string;
  hubDir: string;
  targetDir: string;
  hubId: string;
  bundleId: string;
  sourceId: string;
  profileId: string;
}> => {
  const fsPromises = ctx.fs;
  const bundleDir = path.join(workspace, 'bundle');
  const hubDir = path.join(workspace, 'hub');
  const targetDir = path.join(workspace, 'target');

  await fsPromises.mkdir(bundleDir, { recursive: true });
  await fsPromises.mkdir(hubDir, { recursive: true });
  await fsPromises.mkdir(targetDir, { recursive: true });
  await fsPromises.mkdir(path.join(bundleDir, 'prompts'), { recursive: true });
  await fsPromises.mkdir(path.join(bundleDir, 'skills', 'test-skill'), { recursive: true });

  await fsPromises.writeFile(
    path.join(bundleDir, 'deployment-manifest.yml'),
    DEPLOYMENT_MANIFEST
  );
  await fsPromises.writeFile(
    path.join(bundleDir, 'prompts', 'hello.prompt.md'),
    HELLO_PROMPT
  );
  await fsPromises.writeFile(
    path.join(bundleDir, 'skills', 'test-skill', 'SKILL.md'),
    TEST_SKILL
  );

  const hubConfig = HUB_CONFIG
    .replace(/\{\{BUNDLE_DIR\}\}/g, bundleDir)
    .replace(/\{\{BUNDLE_ID\}\}/g, 'local-foo')
    .replace(/\{\{SOURCE_ID\}\}/g, 'local-foo-src')
    .replace(/\{\{PROFILE_ID\}\}/g, 'backend');
  await fsPromises.writeFile(path.join(hubDir, 'hub-config.yml'), hubConfig);

  return {
    bundleDir,
    hubDir,
    targetDir,
    hubId: 'local-test-hub',
    bundleId: 'local-foo',
    sourceId: 'local-foo-src',
    profileId: 'backend'
  };
};

const DEPLOYMENT_MANIFEST = `id: local-foo
version: 1.0.0
name: Local Foo
items:
  - path: prompts/hello.prompt.md
    kind: prompt
  - path: skills/test-skill/SKILL.md
    kind: skill
`;

const HELLO_PROMPT = `# Hello Prompt

A diagnostic prompt.
`;

const TEST_SKILL = `# Test Skill

A diagnostic skill.
`;

const HUB_CONFIG = `version: 1.0.0
metadata:
  name: Local Test Hub
  description: Synthetic hub for diagnostic run
  maintainer: doctor
  updatedAt: '2026-01-01T00:00:00Z'
sources:
  - id: {{SOURCE_ID}}
    name: Local Foo Source
    type: local
    url: {{BUNDLE_DIR}}
    enabled: true
    priority: 0
    hubId: {{HUB_ID}}
profiles:
  - id: {{PROFILE_ID}}
    name: Backend Developer
    description: Diagnostic profile
    bundles:
      - id: {{BUNDLE_ID}}
        version: 1.0.0
        source: {{SOURCE_ID}}
        required: true
`;

/**
 * Verify that a file exists on disk and record the result.
 * @param fsAbstraction fs abstraction.
 * @param file File to check.
 * @returns true when present.
 */
const fileExists = async (fsAbstraction: FsAbstraction, file: string): Promise<boolean> => {
  try {
    return await fsAbstraction.exists(file);
  } catch {
    return false;
  }
};

/**
 * Run the full diagnostic suite.
 *
 * The workspace is created fresh, populated with fixtures, exercised, and
 * then removed. If a step fails, subsequent steps still run so the report
 * shows the full picture; `ok` is false if any step exited non-zero.
 * @param opts Runner options.
 * @returns Aggregate diagnostics result.
 */
export const runDiagnostics = async (
  opts: DiagnosticsOptions
): Promise<DiagnosticsResult> => {
  const workspace = resolveWorkspacePath();
  const fsAbstraction = opts.ctx.fs;
  const steps: DiagnosticStep[] = [];

  const runStep = async (
    name: string,
    argv: string[],
    input?: Record<string, unknown>
  ): Promise<DiagnosticStep> => {
    const step = await runDiagnosticStep(opts, workspace, name, argv, input);
    steps.push(step);
    return step;
  };

  try {
    // Clean up any leftover from a previous aborted run.
    await fsAbstraction.remove(workspace, { recursive: true });
    await fsAbstraction.mkdir(workspace, { recursive: true });

    const fixtures = await prepareWorkspace(opts.ctx, workspace);

    // Step 1: Create a target.
    await runStep('create-target', [
      'target', 'add', 'copilot', '--type', 'copilot-cli', '--path', fixtures.targetDir,
      '-o', 'json'
    ], { targetDir: fixtures.targetDir });

    // Step 2: Add a local hub.
    await runStep('add-hub', [
      'hub', 'add', '--type', 'local', '--location', fixtures.hubDir,
      '-o', 'json'
    ], { hubDir: fixtures.hubDir });

    // Step 3: Activate the hub.
    await runStep('use-hub', [
      'hub', 'use', fixtures.hubId,
      '-o', 'json'
    ], { hubId: fixtures.hubId });

    // Step 4: Sync the hub.
    await runStep('sync-hub', [
      'hub', 'sync', fixtures.hubId,
      '-o', 'json'
    ], { hubId: fixtures.hubId });

    // Step 5: List available profiles.
    await runStep('list-profiles', [
      'profile', 'list',
      '-o', 'json'
    ]);

    // Step 6: Activate a profile.
    await runStep('activate-profile', [
      'profile', 'activate', fixtures.profileId, '--target', 'copilot',
      '-o', 'json'
    ], { profileId: fixtures.profileId, targetDir: fixtures.targetDir });

    // Step 7: Verify resources were installed.
    const promptInstalled = await fileExists(
      fsAbstraction,
      path.join(fixtures.targetDir, 'prompts', 'hello.prompt.md')
    );
    const skillInstalled = await fileExists(
      fsAbstraction,
      path.join(fixtures.targetDir, 'skills', 'test-skill', 'SKILL.md')
    );
    await runStep('verify-installed', [
      'status', '-o', 'json'
    ], { promptInstalled, skillInstalled });

    // Step 8: Build a local primitive index.
    await runStep('build-index', [
      'index', 'build',
      '--root', fixtures.bundleDir,
      '--out', path.join(workspace, 'primitive-index.json'),
      '--source-id', fixtures.sourceId,
      '-o', 'json'
    ], { bundleDir: fixtures.bundleDir });

    // Step 9: Search the index.
    await runStep('search-index', [
      'index', 'search',
      '--query', 'hello',
      '--index', path.join(workspace, 'primitive-index.json'),
      '-o', 'json'
    ]);

    // Step 10: Deactivate the profile.
    await runStep('deactivate-profile', [
      'profile', 'deactivate',
      '-o', 'json'
    ]);

    // Step 11: Verify resources were removed.
    const promptRemoved = !(await fileExists(
      fsAbstraction,
      path.join(fixtures.targetDir, 'prompts', 'hello.prompt.md')
    ));
    const skillRemoved = !(await fileExists(
      fsAbstraction,
      path.join(fixtures.targetDir, 'skills', 'test-skill', 'SKILL.md')
    ));
    await runStep('verify-removed', [
      'status', '-o', 'json'
    ], { promptRemoved, skillRemoved });

    // Step 12: Direct bundle install.
    await runStep('install-bundle', [
      'install', fixtures.bundleId,
      '--from', fixtures.bundleDir,
      '--target', 'copilot',
      '-o', 'json'
    ], { bundleDir: fixtures.bundleDir });

    // Step 13: Uninstall all bundles for the target.
    await runStep('uninstall-bundle', [
      'uninstall', '--target', 'copilot', '--all',
      '-o', 'json'
    ]);

    // Step 14: Final status check.
    await runStep('final-status', [
      'status', '-o', 'json'
    ]);
  } catch (err) {
    // Record the unexpected error as a synthetic step so the report always
    // explains why the run stopped.
    steps.push({
      name: 'unexpected-error',
      argv: [],
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      input: { workspace },
      durationMs: 0
    });
  } finally {
    // Always remove the workspace, even when steps fail.
    try {
      await fsAbstraction.remove(workspace, { recursive: true });
    } catch {
      // Best-effort cleanup; do not mask the real failure.
    }
  }

  const failed = steps.filter((s) => s.exitCode !== 0);
  const ok = failed.length === 0;
  return {
    ok,
    workspace,
    steps,
    summary: ok
      ? `all ${steps.length} diagnostic steps passed`
      : `${failed.length} of ${steps.length} diagnostic steps failed`
  };
};

/**
 * Native clipanion command classes the diagnostic suite needs registered.
 * @returns Command class array suitable for `runCli` / `DiagnosticsOptions`.
 */
export const getDiagnosticCommandClasses = (): CommandClass[] => [
  StatusCommand,
  TargetAddCommand,
  HubAddCommand,
  HubUseCommand,
  HubSyncCommand,
  ProfileListCommand,
  ProfileActivateCommand,
  ProfileDeactivateCommand,
  IndexBuildCommand,
  IndexSearchCommand,
  InstallCommand,
  UninstallCommand
];
