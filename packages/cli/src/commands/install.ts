/**
 * `install` stub (environment-agnostic install preview).
 *
 * The install command is the primary deliverable for
 * environment-agnostic install. This ships the surface so the
 * migration guide can mention it; the body is filled in later.
 *
 * Final shape:
 *   prompt-registry install <bundle>            (imperative)
 *   prompt-registry install --lockfile <path>   (declarative from a lockfile)
 */
import * as path from 'node:path';
import {
  resolveUserConfigPaths,
} from '@prompt-registry/app';
import {
  FileTreeTargetWriter,
  type TargetWriter,
  TransformerRegistry,
} from '@prompt-registry/app';
import {
  type BundleResolver,
  type HttpClient,
  parseBundleSpec,
  type RegistrySource,
  Target,
  type TokenProvider,
  validateManifest,
} from '@prompt-registry/core';
import {
  ActiveHubStore,
  checksumFiles,
  defaultTokenProvider,
  GitHubBundleResolver,
  HttpsBundleDownloader,
  HubStore,
  NodeHttpClient,
  readLocalBundle,
  readTargets,
  SourceDispatcher,
  TargetStateStore,
  YauzlBundleExtractor,
} from '@prompt-registry/infra';
import {
  type LockfileEntry,
  type LockfileSource,
  readLockfile,
  type RepositoryCommitMode,
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
  upsertEntry,
  upsertSource,
  writeLockfile,
} from '@prompt-registry/infra';
import inquirer from 'inquirer';
import {
  Command,
  createHubManager,
  failWith,
  findProjectLockfile,
  loadTargets,
  Option,
  requireActiveHubOrFail,
} from '../framework';
import {
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  type OutputFormat,
  readTargetsSafely,
  RegistryError,
  resolveTarget,
  resolveTargetName,
  validateInputs,
} from '../framework';

/**
 * Extract repo slug from a GitHub URL.
 * @param url GitHub URL (e.g., "https://github.com/owner/repo" or "owner/repo").
 * @returns Repo slug (e.g., "owner/repo").
 */
function extractRepoSlug(url: string): string {
  if (url.startsWith('https://github.com/')) {
    return url.replace('https://github.com/', '');
  }
  return url;
}

/**
 * Install command options.
 */
export interface InstallOptions {
  output?: OutputFormat;
  /** Bundle id to install (imperative mode). */
  bundle?: string;
  /** Lockfile path (declarative mode). */
  lockfile?: string;
  /** Target name (resolved against `targets[]` in config). */
  target?: string;
  /**
   * Path to an already-built bundle directory. When set, the install
   * command bypasses resolve/download/extract and reads files from
   * the directory directly. Useful for dev workflows where the
   * user just ran `prompt-registry bundle build`.
   */
  from?: string;
  /** Dry-run: validate + plan the install but write nothing. */
  dryRun?: boolean;
  /**
   * Comma-separated allowlist of target names this run is permitted
   * to write to. Defense-in-depth for CI; refuses any --target outside
   * the set even if the target is configured. Spec sec 9.2.1.
   */
  allowTarget?: string;
  /**
   * Optional source slug for the remote install path. When `<bundle>` is given without
   * `--from`, this resolves the bundle via `GitHubBundleResolver`.
   * Format: `owner/repo`. If omitted, the bundleSpec must carry
   * a sourceId of the same form (e.g. `install owner/repo:foo`).
   */
  source?: string;
  /**
   * Interactive mode: prompts user to select bundles from a list.
   */
  interactive?: boolean;
  /**
   * Dependency-injection seam for tests. Production callers leave this
   * undefined; the install command then constructs a `NodeHttpClient`. Tests pass a
   * `RecordingHttpClient` to avoid real sockets.
   */
  http?: HttpClient;
  /**
   * Dependency-injection seam for tests. Production callers leave this
   * undefined; the install command then constructs an `defaultTokenProvider(ctx.env)`.
   */
  tokens?: TokenProvider;
  /**
   * Installation scope (user or repository).
   * Overrides target's scope if specified.
   */
  scope?: 'user' | 'repository';
  /**
   * Commit mode for repository scope.
   * Only applies when scope=repository.
   */
  commitMode?: RepositoryCommitMode;
  /**
   * Source configuration for resolver selection.
   * If provided, SourceDispatcher will select the appropriate resolver.
   */
  sourceConfig?: RegistrySource;
  /**
   * Verbose mode: show detailed progress and error messages.
   */
  verbose?: boolean;
}

/**
 * Command context for install/uninstall commands.
 */
interface CommandContext {
  ctx: Context;
  http?: HttpClient;
  tokens?: TokenProvider;
}

/**
 * Base class for install/uninstall commands.
 */
abstract class BaseInstallCommand extends Command {
  public commandContext: CommandContext = { ctx: null as any };
  public output?: OutputFormat;
}

/**
 * Native clipanion class command for install.
 */
export class InstallCommand extends BaseInstallCommand {
  public static readonly paths = [['install']];

  public static readonly usage = Command.Usage({
    description: 'Install bundles to a configured target.',
    category: 'Install & Manage',
    details: `
      Usage: prompt-registry install [options]

      Options:
        --from <path>           Path to an already-built bundle directory
        --lockfile <path>       Path to a lockfile for declarative installation
        --target <name>         Target name to install to
        --source <hub-id>       Hub ID to list bundles from (use with --interactive for selection)
        --interactive           Interactive mode: select bundles from a list
        --dry-run               Validate and plan without writing
        --scope <scope>         Installation scope (user or repository)
        --commit-mode <mode>    Commit mode for repository scope
        --verbose               Show detailed progress and error messages
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry install --from <path> --target my-vscode
        prompt-registry install --lockfile prompt-registry.lock.json --target my-vscode
        prompt-registry install --source amadeus-hub --interactive --target my-vscode
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public from = Option.String('--from');
  public lockfile = Option.String('--lockfile');
  public target = Option.String('--target');
  public source = Option.String('--source');
  public interactive = Option.Boolean('--interactive', false);
  public dryRun = Option.Boolean('--dry-run');
  public scope = Option.String('--scope');
  public commitMode = Option.String('--commit-mode');
  public verbose = Option.Boolean('--verbose', false);
  public bundle = Option.String({ required: false }); // Optional positional argument

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const http = this.commandContext.http ?? new NodeHttpClient();
    const tokens = this.commandContext.tokens ?? defaultTokenProvider(ctx.env);
    const fmt = (this.output ?? 'text');

    const opts: InstallOptions = {
      output: fmt,
      bundle: this.bundle,
      lockfile: this.lockfile,
      target: this.target,
      from: this.from,
      dryRun: this.dryRun,
      source: this.source,
      interactive: this.interactive,
      http,
      tokens,
      scope: this.scope as 'user' | 'repository' | undefined,
      commitMode: this.commitMode as RepositoryCommitMode | undefined,
      verbose: this.verbose
    };

    await detectInstallContext(opts, ctx);

    const { bundle: noBundle, lockfile: noLockfile } = validateInputs(opts, { flags: ['bundle', 'lockfile'] });
    if (noBundle && noLockfile && !opts.from && !opts.source) {
      return failWith(ctx, fmt, 'install', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'install: provide either <bundle-id> (imperative), --lockfile <path> (declarative), --from <path> (local directory), or --source <hub-id> (list bundles)',
        hint: 'Examples:\n'
          + '  prompt-registry install --from <path> --target my-vscode\n'
          + '  prompt-registry install --lockfile prompt-registry.lock.json\n'
          + '  prompt-registry install --source amadeus-hub --target my-vscode'
      }));
    }

    try {
      const targetName = await resolveTargetName(opts.target, 'install', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));
      checkAllowTarget(targetName, opts);
      const target = await resolveTarget(targetName, 'install', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));

      const mode = determineInstallMode(opts);
      if (mode === undefined) {
        return await performRemoteInstall(opts, target, ctx, fmt);
      }

      return await executeInstallMode(mode, opts, target, ctx, fmt);
    } catch (err) {
      if (err instanceof RegistryError) {
        return failWith(ctx, fmt, 'install', err);
      }
      throw err;
    }
  }
}

/**
 * Determine the installation mode based on options.
 * @param opts Install options.
 * @returns Installation mode.
 */
function determineInstallMode(opts: InstallOptions): 'local' | 'lockfile' | 'remote' | 'interactive' | 'list' | undefined {
  const { bundle: noBundle } = validateInputs(opts, { flags: ['bundle', 'lockfile'] });

  if (opts.source !== undefined && opts.source.length > 0 && noBundle) {
    return opts.interactive ? 'interactive' : 'list';
  }
  if (opts.from !== undefined && opts.from.length > 0) {
    return 'local';
  }
  if (opts.lockfile !== undefined && opts.lockfile.length > 0) {
    return 'lockfile';
  }
  return 'remote';
}

async function autoDetectHubSource(opts: InstallOptions, ctx: Context, userPaths: ReturnType<typeof resolveUserConfigPaths>): Promise<void> {
  if (!(await ctx.fs.exists(userPaths.root))) {
    return;
  }
  const activeStore = new ActiveHubStore(userPaths.activeHub, ctx.fs);
  const hubId = await activeStore.get();
  if (hubId === null) {
    return;
  }
  const store = new HubStore(userPaths.hubs, ctx.fs);
  if (await store.has(hubId)) {
    opts.source = hubId;
    opts.interactive = true;
  }
}

/**
 * Detect install context from the project environment.
 * Fills in `opts.lockfile`, `opts.source`, `opts.interactive`, and `opts.target`
 * when they can be inferred without user input.
 * @param opts Install options (mutated in-place).
 * @param ctx CLI context.
 */
async function detectInstallContext(opts: InstallOptions, ctx: Context): Promise<void> {
  const { bundle: noBundle, lockfile: noLockfile } = validateInputs(opts, { flags: ['bundle', 'lockfile'] });
  const noExplicitSource = !opts.source || opts.source.length === 0;
  const noMode = noBundle && noLockfile && !opts.from && noExplicitSource;

  const userPaths = resolveUserConfigPaths(ctx.env);

  if (noMode && !opts.interactive) {
    const found = await findProjectLockfile(ctx);
    if (found !== null) {
      opts.lockfile = found;
    }
  }

  if (noMode && (!opts.lockfile || opts.lockfile.length === 0)) {
    try {
      await autoDetectHubSource(opts, ctx, userPaths);
    } catch {
      // Ignore errors; proceed without auto-detected hub
    }
  }

  if (!opts.target || opts.target.length === 0) {
    const targets = await readTargetsSafely(
      loadTargets(ctx)
    );
    if (targets.length === 1) {
      opts.target = targets[0].name;
    }
  }
}

/**
 * Execute installation based on determined mode.
 * @param mode Installation mode.
 * @param opts Install options.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function executeInstallMode(
  mode: string,
  opts: InstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  switch (mode) {
    case 'interactive': {
      return await interactiveBundleSelection(opts, target, ctx, fmt);
    }
    case 'list': {
      return await listSourceBundles(opts, ctx, fmt);
    }
    case 'local': {
      return await performLocalInstall(opts, target, ctx, fmt);
    }
    case 'lockfile': {
      return await performLockfileInstall(opts, target, ctx, fmt);
    }
    default: {
      return await performRemoteInstall(opts, target, ctx, fmt);
    }
  }
}

/**
 * Create a writer factory that routes to the appropriate
 * writer based on target scope.
 * - user scope → FileTreeTargetWriter
 * - repository scope → RepositoryScopeWriter
 * @param ctx CLI context.
 * @param opts Install options.
 * @returns Writer factory function.
 */
const createWriterFactory = (
  ctx: Context,
  opts: InstallOptions
): (target: Target) => TargetWriter => {
  // Create transformer registry with built-in transformers
  const transformerRegistry = TransformerRegistry.withBuiltIns();

  return (target: Target): TargetWriter => {
    // Use CLI flags to override target scope if specified
    const scope = opts.scope ?? target.scope;
    const commitMode = opts.commitMode ?? target.commitMode ?? 'commit';
    const workspaceRoot = target.workspaceRoot ?? ctx.cwd();

    if (scope === 'repository') {
      const writer = new RepositoryScopeWriter({
        fs: ctx.fs,
        workspaceRoot,
        commitMode
      });
      return new RepositoryScopeWriterAdapter(writer);
    }
    // Default to FileTreeTargetWriter for user scope
    const transformer = transformerRegistry.getTransformer(target.type);
    return new FileTreeTargetWriter({
      fs: ctx.fs,
      env: ctx.env,
      transformer
    });
  };
};

/**
 * Validate install inputs.
 * @param opts Install options.
 * @returns Validation result.
 */

/**
 * List bundles from a hub source.
 * @param opts Install options.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function listSourceBundles(
  opts: InstallOptions,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  const hubId = opts.source as string;

  try {
    const mgr = createHubManager({ ctx });

    await mgr.syncHub(hubId);
    const active = await requireActiveHubOrFail(mgr, hubId, 'install', ctx, fmt);
    if (typeof active === 'number') {
      return active;
    }

    const bundles = active.config.profiles.flatMap((p: { bundles: { id: string; version: string; source: string }[] }) => p.bundles);
    formatOutput({
      ctx,
      command: 'install',
      output: fmt,
      status: 'ok',
      data: {
        hubId,
        bundles: bundles.map((b: { id: string; version: string; source: string }) => ({ id: b.id, version: b.version, source: b.source }))
      },
      textRenderer: (d) => `Available bundles in hub "${d.hubId}":\n`
        + d.bundles.map((b: { id: string; version: string; source: string }) => `  ${b.id}@${b.version} (source: ${b.source})`).join('\n')
        + '\n\nInstall with: prompt-registry install <bundle-id> --source <hub-id> --target <target>\n'
    });
    return 0;
  } catch (err) {
    if (err instanceof RegistryError) {
      return failWith(ctx, fmt, 'install', err);
    }
    return failWith(ctx, fmt, 'install', new RegistryError({
      code: 'HUB.LOAD_FAILED',
      message: `Failed to load hub "${hubId}": ${err instanceof Error ? err.message : String(err)}`,
      cause: err instanceof Error ? err : undefined
    }));
  }
}

function buildInstallError(err: unknown): RegistryError {
  return new RegistryError({
    code: 'INSTALL.ERROR',
    message: err instanceof Error ? err.message : String(err),
    hint: 'Check the hub configuration and try again.'
  });
}

/**
 * Interactive bundle selection and installation.
 * @param opts Install options.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function interactiveBundleSelection(
  opts: InstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  const hubId = opts.source as string;

  try {
    const mgr = createHubManager({ ctx });
    await mgr.syncHub(hubId);
    const active = await requireActiveHubOrFail(mgr, hubId, 'install', ctx, fmt);
    if (typeof active === 'number') {
      return active;
    }

    const sourceMap = buildSourceMap(active.config.sources);
    const bundles = deduplicateBundles(active.config.profiles);
    const bundleChoices = buildBundleChoices(bundles);
    const selectedBundles = await promptBundleSelection(bundleChoices, bundles);

    if (selectedBundles.length === 0) {
      return 0;
    }

    await previewInstallation(selectedBundles, target.name, ctx);
    const confirmed = await confirmInstallation(ctx);
    if (!confirmed) {
      return 0;
    }

    const installedCount = await installSelectedBundles(selectedBundles, sourceMap, opts, target, ctx, fmt);

    formatOutput({
      ctx,
      command: 'install',
      output: fmt,
      status: 'ok',
      data: { installed: installedCount, total: selectedBundles.length },
      textRenderer: (d) => `Installed ${d.installed}/${d.total} bundles\n`
    });
    return 0;
  } catch (err) {
    return failWith(ctx, fmt, 'install', buildInstallError(err));
  }
}

function buildSourceMap(sources: RegistrySource[]): Map<string, RegistrySource> {
  const sourceMap = new Map<string, RegistrySource>();
  for (const source of sources) {
    sourceMap.set(source.id, source);
    sourceMap.set(source.name, source);
  }
  return sourceMap;
}

function deduplicateBundles(profiles: { bundles: { id: string; version: string; source: string }[] }[]): { id: string; version: string; source: string }[] {
  const allBundles = profiles.flatMap((p) => p.bundles);
  const seenBundleKeys = new Set<string>();
  return allBundles.filter((b) => {
    const key = `${b.id}::${b.source}`;
    if (seenBundleKeys.has(key)) {
      return false;
    }
    seenBundleKeys.add(key);
    return true;
  });
}

function buildBundleChoices(bundles: { id: string; version: string; source: string }[]): { name: string; value: string; short: string }[] {
  return bundles.map((b) => ({
    name: `${b.id}@${b.version} (source: ${b.source})`,
    value: b.id,
    short: b.id
  }));
}

async function promptBundleSelection(
  bundleChoices: { name: string; value: string; short: string }[],
  bundles: { id: string }[]
): Promise<{ id: string; version: string; source: string }[]> {
  const answers = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedBundles',
      message: 'Select bundles to install:',
      choices: bundleChoices,
      validate: (input: string[]) => input.length > 0 || 'Please select at least one bundle'
    }
  ]);

  const selectedBundleIds = answers.selectedBundles as string[];
  return bundles.filter((b) => selectedBundleIds.includes(b.id)) as { id: string; version: string; source: string }[];
}

async function previewInstallation(bundles: { id: string; version: string; source: string }[], targetName: string, ctx: Context): Promise<void> {
  ctx.stdout.write(`\nPreview: Installing ${bundles.length} bundle${bundles.length === 1 ? '' : 's'} to target "${targetName}"\n`);
  for (const b of bundles) {
    ctx.stdout.write(`  - ${b.id}@${b.version} (source: ${b.source})\n`);
  }
}

async function confirmInstallation(ctx: Context): Promise<boolean> {
  const confirm = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'proceed',
      message: 'Proceed with installation?',
      default: true
    }
  ]);

  if (!confirm.proceed) {
    ctx.stdout.write('Installation cancelled.\n');
    return false;
  }
  return true;
}

async function installSelectedBundles(
  bundles: { id: string; version: string; source: string }[],
  sourceMap: Map<string, RegistrySource>,
  opts: InstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  let installedCount = 0;
  for (const bundle of bundles) {
    const source = sourceMap.get(bundle.source);
    if (!source) {
      ctx.stderr.write(`Failed to install ${bundle.id}@${bundle.version}: source "${bundle.source}" not found in hub\n`);
      continue;
    }
    const bundleOpts = { ...opts, bundle: bundle.id, source: source.url, sourceConfig: source };
    try {
      const result = await performRemoteInstall(bundleOpts, target, ctx, fmt);
      if (result === 0) {
        installedCount++;
      }
    } catch (err) {
      ctx.stderr.write(`Failed to install ${bundle.id}@${bundle.version}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return installedCount;
}

/**
 * Resolve target name from options or state.
 * @param opts Install options.
 * @param ctx CLI context.
 * @returns Resolved target name.
 */

/**
 * Check if target is in allowlist.
 * @param targetName Target name.
 * @param opts Install options.
 */
function checkAllowTarget(targetName: string, opts: InstallOptions): void {
  if (opts.allowTarget === undefined || opts.allowTarget.length === 0) {
    return;
  }
  const allowSet = new Set(
    opts.allowTarget.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  );
  if (!allowSet.has(targetName)) {
    throw new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: `install: target "${targetName}" is not in --allow-target=${opts.allowTarget}`,
      hint: 'Add it to --allow-target or unset the flag to allow any configured target.',
      context: { target: targetName, allowTarget: opts.allowTarget }
    });
  }
}

/**
 * Resolve target by name.
 * @param targetName Target name.
 * @param ctx CLI context.
 * @returns Target configuration.
 */

/**
 * Perform local install from directory.
 * @param opts Install options.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function performLocalInstall(
  opts: InstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  try {
    const files = await readLocalBundle(opts.from as string, ctx.fs);
    const manifest = validateManifest(files, {
      expectedId: opts.bundle ?? '',
      expectedVersion: undefined
    });
    if (opts.dryRun === true) {
      formatOutput({
        ctx,
        command: 'install',
        output: fmt,
        status: 'ok',
        data: {
          dryRun: true,
          target: target.name,
          bundle: { id: manifest.id, version: manifest.version },
          files: [...files.keys()]
        },
        textRenderer: (d) => `Dry run: would install ${d.bundle.id}@${d.bundle.version} `
          + `(${d.files.length} file${d.files.length === 1 ? '' : 's'}) into target "${d.target}".\n`
      });
      return 0;
    }
    const writerFactory = createWriterFactory(ctx, opts);
    const writer = writerFactory(target);
    const result = await writer.write(target, files);

    const lockPath = path.join(ctx.cwd(), 'prompt-registry.lock.json');
    const existing = await readLockfile(lockPath, ctx.fs);
    const checksums = checksumFiles(files);
    const localSourceId = `local-${path.basename(opts.from as string)}`;
    const entry: LockfileEntry = {
      target: target.name,
      sourceId: localSourceId,
      bundleId: manifest.id,
      bundleVersion: manifest.version,
      installedAt: new Date().toISOString(),
      files: [...files.keys()].filter((f) => f !== 'deployment-manifest.yml'),
      fileChecksums: checksums
    };
    const scope = opts.scope ?? target.scope;
    if (scope === 'repository') {
      entry.commitMode = opts.commitMode ?? target.commitMode ?? 'commit';
    }
    let nextLock = upsertEntry(existing, entry);
    nextLock = upsertSource(nextLock, localSourceId, {
      type: 'local',
      url: path.resolve(ctx.cwd(), opts.from as string)
    });
    await writeLockfile(lockPath, nextLock, ctx.fs);

    await updateTargetState(ctx, target.name, manifest.id, manifest.version);

    formatOutput({
      ctx,
      command: 'install',
      output: fmt,
      status: 'ok',
      data: {
        target: target.name,
        bundle: { id: manifest.id, version: manifest.version },
        written: result.written,
        skipped: result.skipped,
        lockfile: lockPath
      },
      textRenderer: (d) => `Installed ${d.bundle.id}@${d.bundle.version} into target "${d.target}" `
        + `(${d.written.length} written, ${d.skipped.length} skipped). `
        + `Updated ${d.lockfile}.\n`
    });
    return 0;
  } catch (cause) {
    const raw = (cause as { code?: string }).code;
    const code = raw !== undefined && /^(BUNDLE|FS|NETWORK|USAGE|CONFIG)\.[A-Z0-9_]+$/.test(raw)
      ? raw
      : 'INTERNAL.UNEXPECTED';
    throw new RegistryError({
      code,
      message: `install: ${(cause as Error).message}`,
      hint: 'Run `prompt-registry doctor` for environment diagnostics.',
      context: { from: opts.from },
      cause: cause instanceof Error ? cause : undefined
    });
  }
}

/**
 * Perform lockfile-based install.
 * @param opts Install options.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function performLockfileInstall(
  opts: InstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  const lockfile = opts.lockfile as string;
  const lockPath = path.isAbsolute(lockfile)
    ? lockfile
    : path.join(ctx.cwd(), lockfile);
  const lock = await readLockfile(lockPath, ctx.fs);
  const matching = lock.entries.filter((e) => e.target === target.name);
  const sources = lock.sources ?? {};
  const http = opts.http ?? new NodeHttpClient();
  const tokens = opts.tokens ?? defaultTokenProvider(ctx.env);
  const writerFactory = createWriterFactory(ctx, opts);
  const writer = writerFactory(target);

  const { replayed, failures } = await replayLockfileEntries({
    matching,
    sources,
    http,
    tokens,
    writer,
    target,
    ctx,
    verbose: opts.verbose ?? false
  });

  if (replayed.length > 0) {
    await updateTargetStateFromLockfile(ctx, target.name, matching, replayed);
  }

  const profileLink = lock.useProfile;
  const status = failures.length === 0 ? 'ok' : 'warning';
  formatOutput({
    ctx,
    command: 'install',
    output: fmt,
    status,
    data: {
      lockfile: lockPath,
      target: target.name,
      replayPlanned: matching.length,
      replayed,
      failures,
      useProfile: profileLink ?? null
    },
    warnings: failures.length > 0
      ? failures.map((f) => `${f.bundleId}: ${f.reason}`)
      : undefined,
    textRenderer: (d) => {
      let suffix: string;
      if (d.failures.length === 0) {
        suffix = '.\n';
      } else {
        const plural = d.failures.length === 1 ? '' : 's';
        suffix = `; ${d.failures.length} failure${plural}:\n`
          + d.failures.map((f) => `  - ${f.bundleId}: ${f.reason}\n`).join('');
      }
      return `Replay: ${d.replayed.length}/${d.replayPlanned} bundles installed `
        + `into target "${d.target}"` + suffix;
    }
  });
  return failures.length === 0 ? 0 : 1;
}

/**
 * Perform remote install from GitHub.
 * @param opts Install options.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @returns Exit code.
 */
async function performRemoteInstall(
  opts: InstallOptions,
  target: Target,
  ctx: Context,
  fmt: OutputFormat
): Promise<number> {
  try {
    const spec = parseBundleSpec(opts.bundle as string);
    const repoSlug = opts.source ?? spec.sourceId;
    if (repoSlug === undefined || repoSlug.length === 0) {
      throw new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'install: a remote install needs --source <owner/repo> (or `install owner/repo:<bundleId>`).',
        hint: 'Examples:\n'
          + '  prompt-registry install foo --source owner/repo --target my-vscode\n'
          + '  prompt-registry install owner/repo:foo --target my-vscode\n'
          + '  prompt-registry install foo --from <localDir> --target my-vscode'
      });
    }
    const http = opts.http ?? new NodeHttpClient();
    const tokens = opts.tokens ?? defaultTokenProvider(ctx.env);

    // Use SourceDispatcher to select the appropriate resolver based on source config
    let resolver: BundleResolver;
    if (opts.sourceConfig) {
      const dispatcher = new SourceDispatcher({ http, tokens, fs: ctx.fs });
      const selectedResolver = dispatcher.resolverFor(opts.sourceConfig);
      resolver = selectedResolver ?? new GitHubBundleResolver({ repoSlug, http, tokens });
    } else {
      // Default to GitHub resolver when no source config is provided
      resolver = new GitHubBundleResolver({ repoSlug, http, tokens });
    }

    const downloader = new HttpsBundleDownloader(http, tokens);
    const extractor = new YauzlBundleExtractor();

    const installable = await resolver.resolve(spec);
    if (installable === null) {
      throw new RegistryError({
        code: 'BUNDLE.NOT_FOUND',
        message: `install: ${spec.bundleId} not found at ${repoSlug}`,
        hint: 'Check the source slug and that a release with the requested version + asset (bundle.zip) exists.',
        context: { spec, repoSlug }
      });
    }
    const dl = await downloader.download(installable);
    const files = await extractor.extract(dl.bytes);
    const manifest = validateManifest(files, {
      expectedId: opts.sourceConfig === undefined ? spec.bundleId : undefined,
      expectedVersion: spec.bundleVersion === 'latest' ? undefined : spec.bundleVersion
    });
    if (opts.dryRun === true) {
      formatOutput({
        ctx,
        command: 'install',
        output: fmt,
        status: 'ok',
        data: {
          dryRun: true,
          target: target.name,
          bundle: { id: manifest.id, version: manifest.version },
          source: { type: 'github', repo: repoSlug, downloadUrl: installable.downloadUrl },
          sha256: dl.sha256,
          files: [...files.keys()]
        },
        textRenderer: (d) => `Dry run: would install ${d.bundle.id}@${d.bundle.version} `
          + `from ${d.source.repo} (${d.files.length} file${d.files.length === 1 ? '' : 's'}) `
          + `into target "${d.target}".\n`
      });
      return 0;
    }
    const transformerRegistry = TransformerRegistry.withBuiltIns();
    const transformer = transformerRegistry.getTransformer(target.type);
    const writer = new FileTreeTargetWriter({ fs: ctx.fs, env: ctx.env, transformer });
    const result = await writer.write(target, files);
    const lockPath = path.join(ctx.cwd(), 'prompt-registry.lock.json');
    const existing = await readLockfile(lockPath, ctx.fs);
    const checksums = checksumFiles(files);
    const entry: LockfileEntry = {
      target: target.name,
      sourceId: installable.ref.sourceId,
      bundleId: manifest.id,
      bundleVersion: manifest.version,
      sha256: dl.sha256,
      installedAt: new Date().toISOString(),
      files: [...files.keys()].filter((f) => f !== 'deployment-manifest.yml'),
      fileChecksums: checksums
    };
    let nextLock = upsertEntry(existing, entry);
    const collectionsPath = opts.sourceConfig?.config?.collectionsPath as string | undefined;
    nextLock = upsertSource(nextLock, installable.ref.sourceId, {
      type: 'github',
      url: `https://github.com/${repoSlug}`,
      ...(collectionsPath ? { collectionsPath } : {})
    });
    await writeLockfile(lockPath, nextLock, ctx.fs);

    formatOutput({
      ctx,
      command: 'install',
      output: fmt,
      status: 'ok',
      data: {
        target: target.name,
        bundle: { id: manifest.id, version: manifest.version },
        source: { type: 'github', repo: repoSlug, sourceId: installable.ref.sourceId },
        sha256: dl.sha256,
        written: result.written,
        skipped: result.skipped,
        lockfile: lockPath
      },
      textRenderer: (d) => `Installed ${d.bundle.id}@${d.bundle.version} from ${d.source.repo} `
        + `into target "${d.target}" (${d.written.length} written, ${d.skipped.length} skipped). `
        + `Updated ${d.lockfile}.\n`
    });
    return 0;
  } catch (cause) {
    const raw = (cause as { code?: string }).code;
    const code = raw !== undefined && /^(BUNDLE|FS|NETWORK|USAGE|CONFIG)\.[A-Z0-9_]+$/.test(raw)
      ? raw
      : 'NETWORK.DOWNLOAD_FAILED';
    throw new RegistryError({
      code,
      message: `install: ${(cause as Error).message}`,
      hint: 'Run `prompt-registry doctor` for environment diagnostics, or use `--from <localDir>` to install a pre-built bundle.',
      context: {
        mode: 'imperative-remote',
        bundle: opts.bundle,
        source: opts.source,
        target: opts.target
      },
      cause: cause instanceof Error ? cause : undefined
    });
  }
}

/**
 * Update target state with installed bundle.
 * @param ctx CLI context.
 * @param targetName Target name.
 * @param bundleId Bundle ID.
 * @param version Bundle version.
 */
async function updateTargetState(ctx: Context, targetName: string, bundleId: string, version: string): Promise<void> {
  const stateStore = new TargetStateStore({
    fs: ctx.fs,
    statePath: path.join(ctx.cwd(), '.prompt-registry', 'target-state.json')
  });
  const existingState = await stateStore.load(targetName);
  const newBundles = existingState?.lastInstalledBundles ?? [];
  const bundleIndex = newBundles.findIndex((b) => b.bundleId === bundleId);
  if (bundleIndex === -1) {
    newBundles.push({
      bundleId,
      version,
      installedAt: new Date().toISOString()
    });
  } else {
    newBundles[bundleIndex] = {
      bundleId,
      version,
      installedAt: new Date().toISOString()
    };
  }
  await stateStore.save({
    targetName,
    lastInstalledBundles: newBundles,
    lastUsedAt: new Date().toISOString()
  });
}

/**
 * Update target state from lockfile entries.
 * @param ctx CLI context.
 * @param targetName Target name.
 * @param matching Matching lockfile entries.
 * @param replayed Replay bundle IDs.
 */
async function updateTargetStateFromLockfile(ctx: Context, targetName: string, matching: LockfileEntry[], replayed: string[]): Promise<void> {
  const stateStore = new TargetStateStore({
    fs: ctx.fs,
    statePath: path.join(ctx.cwd(), '.prompt-registry', 'target-state.json')
  });
  const existingState = await stateStore.load(targetName);
  const newBundles = existingState?.lastInstalledBundles ?? [];
  for (const bundleId of replayed) {
    const entry = matching.find((e) => e.bundleId === bundleId);
    if (entry) {
      const bundleIndex = newBundles.findIndex((b) => b.bundleId === bundleId);
      if (bundleIndex === -1) {
        newBundles.push({
          bundleId: entry.bundleId,
          version: entry.bundleVersion,
          installedAt: entry.installedAt
        });
      } else {
        newBundles[bundleIndex] = {
          bundleId: entry.bundleId,
          version: entry.bundleVersion,
          installedAt: entry.installedAt
        };
      }
    }
  }
  await stateStore.save({
    targetName,
    lastInstalledBundles: newBundles,
    lastUsedAt: new Date().toISOString()
  });
}

/**
 * Install a single bundle given an explicit source configuration.
 * Shared by `install --interactive` and `index search --install`.
 * @param bundleId Bundle ID to install.
 * @param sourceConfig Source configuration (hub source).
 * @param target Target to write into.
 * @param ctx CLI context.
 * @param http HTTP client.
 * @param tokens Token provider.
 * @param fmt Output format.
 * @returns Exit code.
 */
export async function installBundleWithSource(
  bundleId: string,
  sourceConfig: RegistrySource,
  target: Target,
  ctx: Context,
  http: HttpClient,
  tokens: TokenProvider,
  fmt: OutputFormat = 'text'
): Promise<number> {
  const opts: InstallOptions = {
    bundle: bundleId,
    source: extractRepoSlug(sourceConfig.url),
    sourceConfig,
    http,
    tokens
  };
  return performRemoteInstall(opts, target, ctx, fmt);
}

/**
 * Build the `install` command (factory function for backward compatibility).
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createInstallCommand = (
  opts: InstallOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['install'],
    description: 'Install bundles to a configured target.',
    category: 'Install & Manage',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const fmt = opts.output ?? 'text';
      const { bundle: noBundle, lockfile: noLockfile } = validateInputs(opts, { flags: ['bundle', 'lockfile'] });
      if (noBundle && noLockfile) {
        return failWith(ctx, fmt, 'install', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'install: provide either <bundle-id> (imperative) or --lockfile <path> (declarative)',
          hint: 'Examples:\n'
            + '  prompt-registry install <bundle-id>\n'
            + '  prompt-registry install --lockfile prompt-registry.lock.json'
        }));
      }

      try {
        const targetName = await resolveTargetName(opts.target, 'install', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));
        checkAllowTarget(targetName, opts);
        const target = await resolveTarget(targetName, 'install', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));

        if (opts.from !== undefined && opts.from.length > 0) {
          return await performLocalInstall(opts, target, ctx, fmt);
        }

        if (opts.lockfile !== undefined && opts.lockfile.length > 0) {
          return await performLockfileInstall(opts, target, ctx, fmt);
        }

        return await performRemoteInstall(opts, target, ctx, fmt);
      } catch (err) {
        if (err instanceof RegistryError) {
          return failWith(ctx, fmt, 'install', err);
        }
        throw err;
      }
    }
  });

/**
 * Fail with error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 * @returns Exit code.
 */

/**
 * Replay lockfile entries for installation.
 * @param matching Matching lockfile entries.
 * @param sources Lockfile sources.
 * @param http HTTP client.
 * @param tokens Token provider.
 * @param writer Target writer.
 * @param target Target configuration.
 * @param ctx CLI context.
 * @param verbose
 * @returns Replay results.
 */
interface ReplayLockfileEntriesOptions {
  matching: LockfileEntry[];
  sources: Record<string, LockfileSource>;
  http: HttpClient;
  tokens: TokenProvider;
  writer: TargetWriter;
  target: Target;
  ctx: Context;
  verbose: boolean;
}

async function replayLockfileEntries(
  opts: ReplayLockfileEntriesOptions
): Promise<{ replayed: string[]; failures: { bundleId: string; reason: string }[] }> {
  const { matching, sources, http, tokens, writer, target, ctx, verbose } = opts;
  const replayed: string[] = [];
  const failures: { bundleId: string; reason: string }[] = [];

  if (verbose) {
    ctx.stdout.write(`[verbose] Planning to replay ${matching.length} bundles\n`);
  }

  for (const e of matching) {
    const result = await replaySingleEntry({
      entry: e,
      sources,
      http,
      tokens,
      writer,
      target,
      ctx,
      verbose
    });
    if (result.success) {
      replayed.push(e.bundleId);
    } else {
      failures.push({
        bundleId: e.bundleId,
        reason: result.reason
      });
    }
  }

  return { replayed, failures };
}

interface ReplaySingleEntryOptions {
  entry: LockfileEntry;
  sources: Record<string, LockfileSource>;
  http: HttpClient;
  tokens: TokenProvider;
  writer: TargetWriter;
  target: Target;
  ctx: Context;
  verbose: boolean;
}

// NOSONAR - Cognitive complexity is inherent to error handling logic for lockfile replay
// The function handles multiple failure modes (missing source, fetch failure, validation error, write error)
// and provides detailed verbose logging for each case. Helper functions have been extracted
// to reduce complexity where possible, but the remaining complexity is necessary for
// comprehensive error handling and user feedback.
async function replaySingleEntry(
  opts: ReplaySingleEntryOptions
): Promise<{ success: boolean; reason: string }> {
  const { entry, sources, http, tokens, writer, target, ctx, verbose } = opts;
  const src = sources[entry.sourceId];
  if (src === undefined) {
    return handleMissingSource(entry, verbose, ctx);
  }

  try {
    const files = await fetchFilesForSource(src, entry, http, tokens, ctx, verbose);
    if (files === null) {
      return handleFetchFailure(entry, src, verbose, ctx);
    }
    await validateAndWrite(files, entry, writer, target, ctx, verbose);
    return { success: true, reason: '' };
  } catch (cause) {
    return handleInstallError(entry, cause, verbose, ctx);
  }
}

async function validateAndWrite(
  files: Map<string, Buffer>,
  entry: LockfileEntry,
  writer: TargetWriter,
  target: Target,
  ctx: Context,
  verbose: boolean
): Promise<void> {
  validateManifest(files, {
    expectedId: entry.bundleId,
    expectedVersion: entry.bundleVersion
  });
  await writer.write(target, files);
  if (verbose) {
    ctx.stdout.write(`[verbose] Successfully installed ${entry.bundleId}\n`);
  }
}

function handleMissingSource(
  entry: LockfileEntry,
  verbose: boolean,
  ctx: Context
): { success: boolean; reason: string } {
  const reason = `source ${entry.sourceId} missing from lockfile.sources`;
  if (verbose) {
    ctx.stdout.write(`[verbose] Skipping ${entry.bundleId}: ${reason}\n`);
  }
  return { success: false, reason };
}

function handleFetchFailure(
  entry: LockfileEntry,
  src: LockfileSource,
  verbose: boolean,
  ctx: Context
): { success: boolean; reason: string } {
  const reason = `failed to fetch files from ${src.type} source`;
  if (verbose) {
    ctx.stdout.write(`[verbose] Skipping ${entry.bundleId}: ${reason}\n`);
  }
  return { success: false, reason };
}

function handleInstallError(
  entry: LockfileEntry,
  cause: unknown,
  verbose: boolean,
  ctx: Context
): { success: boolean; reason: string } {
  const reason = (cause as Error).message;
  if (verbose) {
    ctx.stdout.write(`[verbose] Failed to install ${entry.bundleId}: ${reason}\n`);
  }
  return { success: false, reason };
}

// NOSONAR - Cognitive complexity is inherent to handling multiple source types (local, github)
// Each source type has its own resolution, download, and validation logic with verbose logging.
// The complexity is necessary for comprehensive error handling and user feedback during bundle fetching.
async function fetchFilesForSource( // NOSONAR
  src: LockfileSource,
  entry: LockfileEntry,
  http: HttpClient,
  tokens: TokenProvider,
  ctx: Context,
  verbose: boolean
): Promise<Map<string, Buffer> | null> {
  if (src.type === 'local') {
    if (verbose) {
      ctx.stdout.write(`[verbose] Reading local bundle from ${src.url}\n`);
    }
    const files = await readLocalBundle(src.url, ctx.fs);
    return files as unknown as Map<string, Buffer>;
  }
  if (src.type === 'github') {
    // Check if this is an awesome-copilot source (detected by sourceId prefix)
    const isAwesomeCopilot = entry.sourceId.startsWith('awesome-copilot-');
    const repoSlug = src.url.replace(/^https?:\/\/github\.com\//, '');
    if (verbose) {
      ctx.stdout.write(`[verbose] Resolving ${entry.bundleId}@${entry.bundleVersion} from ${repoSlug} (${isAwesomeCopilot ? 'awesome-copilot' : 'github'})\n`);
    }

    if (isAwesomeCopilot) {
      // Use AwesomeCopilot resolver for awesome-copilot sources
      const { AwesomeCopilotBundleResolver } = await import('@prompt-registry/infra');
      const acResolver = new AwesomeCopilotBundleResolver({
        repoSlug,
        http,
        tokens,
        collectionsPath: src.collectionsPath
      });
      const acInstallable = await acResolver.resolve({
        bundleId: entry.bundleId,
        bundleVersion: entry.bundleVersion
      });
      if (acInstallable?.inlineBytes === undefined) {
        if (verbose) {
          ctx.stdout.write(`[verbose] AwesomeCopilot resolver returned null or no inline bytes for ${entry.bundleId}@${entry.bundleVersion}\n`);
        }
        return null;
      }
      if (verbose) {
        ctx.stdout.write(`[verbose] Using inline bundle from AwesomeCopilot resolver\n`);
      }
      const acFiles = await new YauzlBundleExtractor().extract(acInstallable.inlineBytes);
      return acFiles as unknown as Map<string, Buffer>;
    }

    // Use GitHub resolver for regular github sources
    const resolver = new GitHubBundleResolver({ repoSlug, http, tokens });
    const downloader = new HttpsBundleDownloader(http, tokens);
    const installable = await resolver.resolve({
      bundleId: entry.bundleId,
      bundleVersion: entry.bundleVersion
    });
    if (installable === null) {
      if (verbose) {
        ctx.stdout.write(`[verbose] Resolver returned null for ${entry.bundleId}@${entry.bundleVersion}\n`);
      }
      return null;
    }
    if (verbose) {
      ctx.stdout.write(`[verbose] Downloading from ${installable.downloadUrl}\n`);
    }
    const dl = await downloader.download(installable);
    if (entry.sha256 !== undefined && dl.sha256 !== entry.sha256) {
      if (verbose) {
        ctx.stdout.write(`[verbose] SHA256 mismatch: expected ${entry.sha256}, got ${dl.sha256}\n`);
      }
      return null;
    }
    if (verbose) {
      ctx.stdout.write(`[verbose] Extracting bundle\n`);
    }
    const files = await new YauzlBundleExtractor().extract(dl.bytes);
    return files as unknown as Map<string, Buffer>;
  }
  if (verbose) {
    ctx.stdout.write(`[verbose] Unsupported source type: ${src.type}\n`);
  }
  return null;
}
