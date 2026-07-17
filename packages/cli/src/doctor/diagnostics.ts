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
import {
  BundleManifestCommand,
} from '../commands/bundle-manifest';
import {
  CollectionListCommand,
} from '../commands/collection-list';
import {
  CollectionValidateCommand,
} from '../commands/collection-validate';
import {
  ConfigGetCommand,
} from '../commands/config-get';
import {
  ExplainCommand,
} from '../commands/explain';
import {
  HubAddCommand,
  HubCreateCommand,
  HubListCommand,
  HubRefreshCommand,
  HubSyncCommand,
  HubUseCommand,
} from '../commands/hub';
import {
  IndexBuildCommand,
} from '../commands/index-build';
import {
  IndexEvalCommand,
} from '../commands/index-eval';
import {
  IndexExportCommand,
} from '../commands/index-export';
import {
  IndexSearchCommand,
} from '../commands/index-search';
import {
  IndexShortlistAddCommand,
  IndexShortlistListCommand,
  IndexShortlistNewCommand,
  IndexShortlistRemoveCommand,
} from '../commands/index-shortlist';
import {
  IndexStatsCommand,
} from '../commands/index-stats';
import {
  InstallCommand,
} from '../commands/install';
import {
  PluginsListCommand,
} from '../commands/plugins-list';
import {
  ProfileActivateCommand,
  ProfileCurrentCommand,
  ProfileDeactivateCommand,
  ProfileListCommand,
  ProfileShowCommand,
} from '../commands/profile';
import {
  SourceAddCommand,
  SourceListCommand,
  SourceRemoveCommand,
} from '../commands/source';
import {
  StatusCommand,
} from '../commands/status';
import {
  TargetAddCommand,
} from '../commands/target-add';
import {
  TargetListCommand,
} from '../commands/target-list';
import {
  TargetTypesCommand,
} from '../commands/target-types';
import {
  UninstallCommand,
} from '../commands/uninstall';
import {
  UpdateCommand,
} from '../commands/update';
import {
  type CapturedOutputStream,
  type CommandClass,
  type Context,
  type FsAbstraction,
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
    name: 'ai-primitives-hub',
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
  return path.join(tmp, `ai-primitives-hub-doctor-${stamp}`);
};

/**
 * Build an environment bag that isolates XDG config/cache inside the
 * workspace, so the diagnostic run never mutates the user's real
 * ai-primitives-hub state.
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
  bundleSubDir: string;
  hubDir: string;
  hubConfigFile: string;
  targetDir: string;
  collectionsDir: string;
  goldFile: string;
  exportDir: string;
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
  const localFooDir = path.join(bundleDir, 'local-foo');
  await fsPromises.mkdir(path.join(localFooDir, 'prompts'), { recursive: true });
  await fsPromises.mkdir(path.join(localFooDir, 'skills', 'test-skill'), { recursive: true });

  await fsPromises.writeFile(
    path.join(localFooDir, 'deployment-manifest.yml'),
    DEPLOYMENT_MANIFEST
  );
  await fsPromises.writeFile(
    path.join(localFooDir, 'prompts', 'hello.prompt.md'),
    HELLO_PROMPT
  );
  await fsPromises.writeFile(
    path.join(localFooDir, 'skills', 'test-skill', 'SKILL.md'),
    TEST_SKILL
  );

  const hubConfig = HUB_CONFIG
    .replace(/\{\{BUNDLE_DIR\}\}/g, localFooDir)
    .replace(/\{\{BUNDLE_ID\}\}/g, 'local-foo')
    .replace(/\{\{SOURCE_ID\}\}/g, 'local-foo-src')
    .replace(/\{\{PROFILE_ID\}\}/g, 'backend')
    .replace(/\{\{HUB_ID\}\}/g, 'local-test-hub');
  await fsPromises.writeFile(path.join(hubDir, 'hub-config.yml'), hubConfig);

  const collectionsDir = path.join(workspace, 'collections');
  await fsPromises.mkdir(collectionsDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(collectionsDir, 'foo.collection.yml'),
    COLLECTION_YML
  );

  const goldFile = path.join(workspace, 'gold-queries.json');
  await fsPromises.writeFile(goldFile, GOLD_QUERIES);

  const exportDir = path.join(workspace, 'exports');
  await fsPromises.mkdir(exportDir, { recursive: true });

  return {
    bundleDir,
    bundleSubDir: localFooDir,
    hubDir,
    hubConfigFile: path.join(hubDir, 'hub-config.yml'),
    targetDir,
    collectionsDir,
    goldFile,
    exportDir,
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

const COLLECTION_YML = `id: foo
name: Foo Collection
description: Diagnostic collection for validation
items:
  - path: bundle/local-foo/prompts/hello.prompt.md
    kind: prompt
  - path: bundle/local-foo/skills/test-skill/SKILL.md
    kind: skill
`;

const GOLD_QUERIES = JSON.stringify({
  cases: [
    {
      id: 'case-1',
      query: { q: 'hello' },
      mustMatch: [{ bundleId: 'local-foo' }]
    }
  ]
});

/**
 * Extract the shortlist ID from a `shortlist new` JSON response.
 * Falls back to 'shortlist-1' if parsing fails.
 * @param stdout Captured stdout from the shortlist new command.
 * @returns Shortlist ID string.
 */
const extractShortlistId = (stdout: string): string => {
  try {
    const parsed = JSON.parse(stdout) as { data?: { shortlist?: { id?: string } } };
    return parsed.data?.shortlist?.id ?? 'shortlist-1';
  } catch {
    return 'shortlist-1';
  }
};

/**
 * Extract the first primitive ID from a search JSON response.
 * Falls back to 'local-foo/hello.prompt.md' if parsing fails.
 * @param stdout Captured stdout from the search command.
 * @returns Primitive ID string.
 */
const extractFirstPrimitiveId = (stdout: string): string => {
  try {
    const parsed = JSON.parse(stdout) as { data?: { hits?: { primitive?: { id?: string } }[] } };
    return parsed.data?.hits?.[0]?.primitive?.id ?? 'local-foo/hello.prompt.md';
  } catch {
    return 'local-foo/hello.prompt.md';
  }
};

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
      'hub', 'add', '--type', 'local', '--location', fixtures.hubConfigFile,
      '--id', fixtures.hubId,
      '-o', 'json'
    ], { hubConfigFile: fixtures.hubConfigFile, hubId: fixtures.hubId });

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

    // Step 6: Show profile details.
    await runStep('profile-show', [
      'profile', 'show', fixtures.profileId,
      '-o', 'json'
    ], { profileId: fixtures.profileId });

    // Step 7: Activate a profile.
    await runStep('activate-profile', [
      'profile', 'activate', fixtures.profileId, '--target', 'copilot',
      '-o', 'json'
    ], { profileId: fixtures.profileId, targetDir: fixtures.targetDir });

    // Step 8: Show currently active profile.
    await runStep('profile-current', [
      'profile', 'current',
      '-o', 'json'
    ]);

    // Step 9: Verify resources were installed.
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

    // Step 10: Build a local primitive index.
    const indexPath = path.join(workspace, 'primitive-index.json');
    await runStep('build-index', [
      'index', 'build',
      '--root', fixtures.bundleDir,
      '--out', indexPath,
      '--source-id', fixtures.sourceId,
      '-o', 'json'
    ], { bundleDir: fixtures.bundleDir });

    // Step 11: Search the index.
    const searchStep = await runStep('search-index', [
      'index', 'search',
      '--query', 'hello',
      '--index', indexPath,
      '-o', 'json'
    ]);

    // Step 12: Search the index filtered by kind.
    await runStep('search-index-kinds', [
      'index', 'search',
      '--query', 'hello',
      '--kinds', 'prompt',
      '--index', indexPath,
      '-o', 'json'
    ]);

    // Step 13: Show index statistics.
    await runStep('index-stats', [
      'index', 'stats',
      '--index', indexPath,
      '-o', 'json'
    ]);

    // Step 14: Create a shortlist.
    const shortlistStep = await runStep('shortlist-new', [
      'index', 'shortlist', 'new',
      '--name', 'Diagnostic Shortlist',
      '--index', indexPath,
      '-o', 'json'
    ]);

    // Step 15: Add a primitive to the shortlist.
    const shortlistId = extractShortlistId(shortlistStep.stdout);
    const primitiveId = extractFirstPrimitiveId(searchStep.stdout);
    await runStep('shortlist-add', [
      'index', 'shortlist', 'add',
      '--id', shortlistId,
      '--primitive', primitiveId,
      '--index', indexPath,
      '-o', 'json'
    ], { shortlistId, primitiveId });

    // Step 16: List shortlists.
    await runStep('shortlist-list', [
      'index', 'shortlist', 'list',
      '--index', indexPath,
      '-o', 'json'
    ]);

    // Step 17: Remove the primitive from the shortlist.
    await runStep('shortlist-remove', [
      'index', 'shortlist', 'remove',
      '--id', shortlistId,
      '--primitive', primitiveId,
      '--index', indexPath,
      '-o', 'json'
    ]);

    // Step 18: Export shortlist as a profile YAML.
    await runStep('index-export', [
      'index', 'export',
      '--shortlist', shortlistId,
      '--profile-id', 'exported-profile',
      '--out-dir', fixtures.exportDir,
      '--index', indexPath,
      '-o', 'json'
    ], { exportDir: fixtures.exportDir });

    // Step 19: Run pattern-based relevance eval.
    await runStep('index-eval', [
      'index', 'eval',
      '--gold', fixtures.goldFile,
      '--index', indexPath,
      '-o', 'json'
    ], { goldFile: fixtures.goldFile });

    // Step 20: Deactivate the profile.
    await runStep('deactivate-profile', [
      'profile', 'deactivate',
      '-o', 'json'
    ]);

    // Step 21: Verify resources were removed.
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

    // Step 22: Direct bundle install.
    await runStep('install-bundle', [
      'install', fixtures.bundleId,
      '--from', fixtures.bundleSubDir,
      '--target', 'copilot',
      '-o', 'json'
    ], { bundleSubDir: fixtures.bundleSubDir });

    // Step 23: Update dry-run (should report 0 updates).
    await runStep('update-dry-run', [
      'update', '--dry-run', '--no-hub-sync', '--target', 'copilot',
      '-o', 'json'
    ]);

    // Step 24: Uninstall all bundles for the target.
    await runStep('uninstall-bundle', [
      'uninstall', '--target', 'copilot', '--all',
      '-o', 'json'
    ]);

    // Step 25: List configured targets.
    await runStep('target-list', [
      'target', 'list',
      '-o', 'json'
    ]);

    // Step 26: List supported target types.
    await runStep('target-types', [
      'target', 'types',
      '-o', 'json'
    ]);

    // Step 27: List imported hubs.
    await runStep('hub-list', [
      'hub', 'list',
      '-o', 'json'
    ]);

    // Step 28: Refresh the active hub.
    await runStep('hub-refresh', [
      'hub', 'refresh',
      '-o', 'json'
    ]);

    // Step 29: Scaffold a hub-config.yml skeleton.
    await runStep('hub-create', [
      'hub', 'create', '--name', 'Diagnostic Hub',
      '--out', path.join(workspace, 'scaffolded-hub'),
      '-o', 'json'
    ]);

    // Step 30: Add a detached source.
    await runStep('source-add', [
      'source', 'add', '--type', 'local', '--url', fixtures.bundleSubDir,
      '--id', 'diag-source', '--name', 'Diagnostic Source',
      '-o', 'json'
    ], { bundleSubDir: fixtures.bundleSubDir });

    // Step 31: List sources across all hubs.
    await runStep('source-list', [
      'source', 'list',
      '-o', 'json'
    ]);

    // Step 32: Remove the detached source.
    await runStep('source-remove', [
      'source', 'remove', 'diag-source',
      '-o', 'json'
    ]);

    // Step 33: List collections (from collections/ dir in workspace).
    await runStep('collection-list', [
      'collection', 'list',
      '-o', 'json'
    ], { collectionsDir: fixtures.collectionsDir });

    // Step 34: Validate collections.
    await runStep('collection-validate', [
      'collection', 'validate',
      '-o', 'json'
    ]);

    // Step 35: Generate a deployment manifest from the collection.
    await runStep('bundle-manifest', [
      'bundle', 'manifest',
      '--version', '1.0.0',
      '--collection-file', 'collections/foo.collection.yml',
      '--out-file', path.join(workspace, 'generated-manifest.yml'),
      '-o', 'json'
    ]);

    // Step 36: Explain an error code.
    await runStep('explain', [
      'explain', 'INDEX.NOT_FOUND',
      '-o', 'json'
    ]);

    // Step 37: List CLI plugins.
    await runStep('plugins-list', [
      'plugins', 'list',
      '-o', 'json'
    ]);

    // Step 38: Read a config value.
    await runStep('config-get', [
      'config', 'get', 'output.json.indent',
      '-o', 'json'
    ]);

    // Step 39: Final status check.
    await runStep('final-status', [
      'status', '-o', 'json'
    ]);

    // Step 40: Search alias as top-level command.
    await runStep('search-alias', [
      'search', '--query', 'hello',
      '--index', indexPath,
      '-o', 'json'
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
  TargetListCommand,
  TargetTypesCommand,
  HubAddCommand,
  HubUseCommand,
  HubSyncCommand,
  HubListCommand,
  HubRefreshCommand,
  HubCreateCommand,
  ProfileListCommand,
  ProfileShowCommand,
  ProfileCurrentCommand,
  ProfileActivateCommand,
  ProfileDeactivateCommand,
  IndexBuildCommand,
  IndexSearchCommand,
  IndexStatsCommand,
  IndexShortlistNewCommand,
  IndexShortlistAddCommand,
  IndexShortlistRemoveCommand,
  IndexShortlistListCommand,
  IndexExportCommand,
  IndexEvalCommand,
  InstallCommand,
  UninstallCommand,
  UpdateCommand,
  SourceAddCommand,
  SourceListCommand,
  SourceRemoveCommand,
  CollectionListCommand,
  CollectionValidateCommand,
  BundleManifestCommand,
  ExplainCommand,
  PluginsListCommand,
  ConfigGetCommand
];
