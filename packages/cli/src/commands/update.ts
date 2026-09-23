/**
 * `update` command — checks installed bundles for newer versions and upgrades them.
 *
 * Reference's version keys each lockfile entry by its own `target` field and
 * resolves a target per-entry. Our `LockfileBundleEntry` has no `target`
 * field (see `app/stores/json-lockfile-store.ts`'s module doc — repository
 * scope always writes to `.github/`, invariant of target), so `update`
 * instead resolves a single target for the whole run — same
 * flag/auto-detect pattern as `install`/`uninstall` — and updates every
 * bundle tracked by that target's lockfile.
 */
import * as path from 'node:path';
import {
  checksumFiles,
  FileTreeTargetWriter,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileSourceEntry,
  readLockfile,
  resolveUserConfigPaths,
  type TargetWriter,
  TransformerRegistry,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
  writeTargetSafely,
} from '@ai-primitives-hub/app';
import type {
  GitHubApi,
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HttpClient,
  HubSourceSpec,
  Installable,
  RegistrySource,
  SourceType,
  Target,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  getInstallableBundleFiles,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  ActiveHubStore,
  createGitHubSourceAuthRuntime,
  defaultTokenProvider,
  FileSystemLayoutConfigLoader,
  GitHubApiClient,
  HttpsBundleDownloader,
  isGitHubAppAuthEnabled,
  NodeHttpClient,
  parseGitHubRepositoryTarget,
  readTargets,
  type RepositoryCommitMode,
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
  resolveUserConfigDir,
  SourceDispatcher,
  StaticTokenProvider,
  TargetStateStore,
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
import {
  Command,
  createHubManager,
  failWith,
  findProjectLockfile,
  loadInquirer,
  loadTargets,
  lockfilePathForTarget,
  Option,
  resolveEffectiveTarget,
} from '../framework';
import {
  type Context,
  formatOutput,
  type OutputFormat,
  readTargetsSafely,
  RegistryError,
  resolveTarget,
  resolveTargetName,
} from '../framework';

/**
 * Return true when `candidate` is a strictly higher semver than `installed`.
 * Strips leading `v` from either value before comparing.
 * @param candidate Resolved latest version.
 * @param installed Currently installed version.
 */
export const isNewerVersion = (candidate: string, installed: string): boolean => {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map((p) => Number.parseInt(p.split('-')[0], 10) || 0);
  const c = parse(candidate);
  const i = parse(installed);
  for (let idx = 0; idx < Math.max(c.length, i.length); idx++) {
    const cv = c[idx] ?? 0;
    const iv = i[idx] ?? 0;
    if (cv > iv) {
      return true;
    }
    if (cv < iv) {
      return false;
    }
  }
  return false;
};

interface UpdateCandidate {
  bundleId: string;
  entry: LockfileBundleEntry;
  source: LockfileSourceEntry;
  from: string;
  to: string;
  installable: Installable;
  repositoryTarget?: GitHubRepositoryTarget;
  authenticationCategory?: Exclude<GitHubSourceAuthCategory, 'unresolved'>;
  downloadTokens?: TokenProvider;
}

interface UpdateContext {
  ctx: Context;
  http?: HttpClient;
  tokens?: TokenProvider;
}

abstract class BaseUpdateCommand extends Command {
  public commandContext: UpdateContext = { ctx: null as unknown as Context };
}

type UpdateEntry = { bundleId: string; from: string; to: string };

function renderDryRunOutput(d: { checked: number; updates: UpdateEntry[] }): string {
  if (d.updates.length === 0) {
    return `All bundles are up to date. (checked ${String(d.checked)})
`;
  }
  const lines = [`Available updates (${String(d.updates.length)}):`];
  for (const u of d.updates) {
    lines.push(`  ${u.bundleId}: ${u.from} → ${u.to}`);
  }
  lines.push('\nRe-run without --dry-run to apply.');
  return lines.join('\n') + '\n';
}

function renderUpdateOutput(d: { updated: number; checked: number; updates: UpdateEntry[] }): string {
  if (d.updated === 0) {
    return `All bundles are up to date. (checked ${String(d.checked)})
`;
  }
  const lines = [`Updated ${String(d.updated)} bundle${d.updated === 1 ? '' : 's'}:`];
  for (const u of d.updates) {
    lines.push(`  ${u.bundleId}: ${u.from} → ${u.to}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Update command options.
 */
export interface UpdateOptions {
  output?: OutputFormat;
  lockfile?: string;
  target?: string;
  dryRun?: boolean;
  interactive?: boolean;
  noHubSync?: boolean;
  scope?: 'user' | 'repository';
  commitMode?: RepositoryCommitMode;
}

export class UpdateCommand extends BaseUpdateCommand {
  public static readonly paths = [['update']];

  public static readonly usage = Command.Usage({
    description: 'Check for newer versions of installed bundles and upgrade them.',
    category: 'Install & Manage',
    details: `
      Usage: ai-primitives-hub update [options]

      Reads the lockfile, checks each remote bundle against its upstream source,
      and installs available upgrades.

      Options:
        --lockfile <path>       Path to a lockfile
        --target <name>         Target name to update
        --dry-run               Check for updates without applying
        --interactive           Interactive mode: select which updates to apply
        --no-hub-sync           Skip syncing hub before checking updates
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub update
        ai-primitives-hub update --target my-vscode
        ai-primitives-hub update --dry-run
        ai-primitives-hub update --interactive
    `
  });

  public output = Option.String('-o,--output');
  public lockfile = Option.String('--lockfile');
  public target = Option.String('--target');
  public dryRun = Option.Boolean('--dry-run', false);
  public interactive = Option.Boolean('--interactive', false);
  public noHubSync = Option.Boolean('--no-hub-sync', false);
  public scope = Option.String('--scope');
  public commitMode = Option.String('--commit-mode');

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const http = this.commandContext.http ?? new NodeHttpClient();
    const tokens = this.commandContext.tokens ?? defaultTokenProvider(ctx.env);
    const fmt: OutputFormat = (this.output ?? 'text') as OutputFormat;

    const opts: UpdateOptions = {
      output: fmt,
      lockfile: this.lockfile,
      target: this.target,
      dryRun: this.dryRun,
      interactive: this.interactive,
      noHubSync: this.noHubSync,
      scope: this.scope as 'user' | 'repository' | undefined,
      commitMode: this.commitMode as RepositoryCommitMode | undefined
    };

    await detectUpdateContext(opts, ctx);

    try {
      const targetName = await resolveTargetName(opts.target, 'update', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));
      const configuredTarget = await resolveTarget(targetName, 'update', ctx, () => readTargets({ cwd: ctx.cwd(), fs: ctx.fs }));
      const target = resolveEffectiveTarget(ctx, configuredTarget, opts);

      const commitMode = target.commitMode ?? 'commit';
      const scope = target.scope;
      const lockPath = opts.lockfile !== undefined && opts.lockfile.length > 0
        ? (path.isAbsolute(opts.lockfile) ? opts.lockfile : path.join(ctx.cwd(), opts.lockfile))
        : lockfilePathForTarget(ctx, target, commitMode);

      const lock = await readLockfile(lockPath, ctx.fs);
      if (lock === null) {
        return failWith(ctx, fmt, 'update', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'update: no lockfile found',
          hint: 'Run `ai-primitives-hub install` first, or pass --lockfile <path>.'
        }));
      }

      if (!this.noHubSync) {
        await syncActiveHub(ctx);
      }

      const bundleIds = Object.keys(lock.bundles);
      const remoteBundleIds = bundleIds.filter((id) => {
        const src = lock.sources[lock.bundles[id].sourceId];
        return src !== undefined && isRemoteSource(src.type);
      });
      const { candidates, skipped } = await findUpdateCandidates(remoteBundleIds, lock, ctx, http, tokens);

      if (this.dryRun) {
        return renderDryRun(ctx, fmt, lockPath, bundleIds.length, skipped.length, candidates);
      }

      const toInstall = await selectUpdatesInteractively(this.interactive, candidates);
      if (toInstall.length === 0) {
        return renderNoUpdates(ctx, fmt, bundleIds.length, skipped.length);
      }

      const { updatedCount, updateResults } = await applyUpdates(toInstall, target, scope, commitMode, lockPath, ctx, http, tokens);

      formatOutput({
        ctx, command: 'update', output: fmt, status: 'ok',
        data: { lockfile: lockPath, target: target.name, checked: bundleIds.length, updated: updatedCount, skipped: skipped.length, updates: updateResults },
        textRenderer: renderUpdateOutput
      });
      return 0;
    } catch (err) {
      if (err instanceof RegistryError) {
        return failWith(ctx, fmt, 'update', err);
      }
      throw err;
    }
  }
}

/**
 * Detect update context from the project environment (symmetric with install/uninstall).
 * Fills in `opts.target` when it can be inferred.
 * @param opts Update options (mutated in-place).
 * @param ctx CLI context.
 */
async function detectUpdateContext(opts: UpdateOptions, ctx: Context): Promise<void> {
  if (!opts.lockfile || opts.lockfile.length === 0) {
    const found = await findProjectLockfile(ctx);
    if (found !== null) {
      opts.lockfile = found;
    }
  }
  if (!opts.target || opts.target.length === 0) {
    const targets = await readTargetsSafely(loadTargets(ctx));
    if (targets.length === 1) {
      opts.target = targets[0].name;
    }
  }
}

function isRemoteSource(type: string): boolean {
  return type === 'github' || type === 'awesome-copilot' || type === 'skills';
}

/**
 * Build a `RegistrySource`-shaped object from a lockfile source entry,
 * for `SourceDispatcher.resolverFor` — the dispatcher only reads
 * `type`/`url`/`config`, so the remaining `RegistrySource` fields are
 * filled with harmless placeholders.
 * @param sourceId Source id (the `lock.sources` key).
 * @param src Lockfile source entry.
 * @returns Synthetic RegistrySource.
 */
function toRegistrySource(sourceId: string, src: LockfileSourceEntry): RegistrySource {
  return {
    id: sourceId,
    name: sourceId,
    type: src.type as SourceType,
    url: src.url,
    enabled: true,
    priority: 0,
    config: {
      branch: src.branch,
      collectionsPath: src.collectionsPath
    }
  };
}

function toHarvestSourceSpec(sourceId: string, src: LockfileSourceEntry): HubSourceSpec {
  const target = parseGitHubRepositoryTarget(src.url);
  const type = src.type === 'awesome-copilot' ? 'awesome-copilot' : 'github';
  return {
    id: sourceId,
    name: sourceId,
    type,
    url: src.url,
    owner: target.owner,
    repo: target.repository,
    branch: src.branch ?? 'main',
    ...(type === 'awesome-copilot'
      ? { collectionsPath: src.collectionsPath ?? 'collections' }
      : {}),
    rawConfig: {
      branch: src.branch,
      collectionsPath: src.collectionsPath
    }
  };
}

interface SourceAwareUpdateDependencies {
  githubApi: GitHubApi;
  repositoryTarget: GitHubRepositoryTarget;
  authenticationCategory: Exclude<GitHubSourceAuthCategory, 'unresolved'>;
  downloadTokens: TokenProvider;
}

async function sourceAwareUpdateDependencies(
  sourceId: string,
  src: LockfileSourceEntry,
  ctx: Context,
  http: HttpClient
): Promise<SourceAwareUpdateDependencies> {
  const runtime = createGitHubSourceAuthRuntime({ env: ctx.env, http });
  const report = await runtime.preflight([toHarvestSourceSpec(sourceId, src)], {
    includeReleases: src.type === 'github',
    onLog: (message) => ctx.stderr.write(`[github preflight] ${message}\n`)
  });
  const decision = report.results[0];
  if (!report.valid || decision === undefined || decision.category === 'unresolved' || decision.target === undefined) {
    throw new Error(`GitHub source preflight failed for ${sourceId}: ${decision?.errorCode ?? 'GH_SOURCE_PREFLIGHT_UNRESOLVED'}`);
  }
  return {
    githubApi: runtime.clientFor(decision.target, decision.category),
    repositoryTarget: decision.target,
    authenticationCategory: decision.category,
    downloadTokens: runtime.tokenProviderFor(decision.category) ?? new StaticTokenProvider('')
  };
}

async function findUpdateCandidates(
  bundleIds: string[],
  lock: Lockfile,
  ctx: Context,
  http: HttpClient,
  tokens: TokenProvider
): Promise<{ candidates: UpdateCandidate[]; skipped: string[] }> {
  const candidates: UpdateCandidate[] = [];
  const skipped: string[] = [];
  const sourceAware = isGitHubAppAuthEnabled(ctx.env);
  const githubApi = new GitHubApiClient(http, { tokenProvider: tokens });
  const dispatcher = new SourceDispatcher({ githubApi, fs: ctx.fs });
  const sourceDependencies = new Map<string, SourceAwareUpdateDependencies>();

  for (const bundleId of bundleIds) {
    const entry = lock.bundles[bundleId];
    const src = lock.sources[entry.sourceId];
    try {
      let resolverDispatcher = dispatcher;
      let dependencies: SourceAwareUpdateDependencies | undefined;
      if (sourceAware) {
        dependencies = sourceDependencies.get(entry.sourceId);
        if (dependencies === undefined) {
          dependencies = await sourceAwareUpdateDependencies(entry.sourceId, src, ctx, http);
          sourceDependencies.set(entry.sourceId, dependencies);
        }
        resolverDispatcher = new SourceDispatcher({ githubApi: dependencies.githubApi, fs: ctx.fs });
      }
      const resolver = resolverDispatcher.resolverFor(toRegistrySource(entry.sourceId, src));
      if (resolver === null) {
        skipped.push(bundleId);
        continue;
      }
      const installable = await resolver.resolve({ bundleId, bundleVersion: 'latest' });
      if (installable === null) {
        skipped.push(bundleId);
        continue;
      }
      const latestVersion = installable.ref.bundleVersion;
      if (isNewerVersion(latestVersion, entry.version)) {
        candidates.push({
          bundleId,
          entry,
          source: src,
          from: entry.version,
          to: latestVersion,
          installable,
          repositoryTarget: dependencies?.repositoryTarget,
          authenticationCategory: dependencies?.authenticationCategory,
          downloadTokens: dependencies?.downloadTokens
        });
      }
    } catch (error) {
      if (sourceAware && error instanceof Error && error.message.startsWith('GitHub source preflight failed')) {
        throw error;
      }
      skipped.push(bundleId);
    }
  }

  return { candidates, skipped };
}

function renderDryRun(
  ctx: Context,
  fmt: OutputFormat,
  lockPath: string,
  checked: number,
  skippedCount: number,
  candidates: UpdateCandidate[]
): number {
  formatOutput({
    ctx, command: 'update', output: fmt, status: 'ok',
    data: {
      dryRun: true, lockfile: lockPath,
      checked, updated: 0, skipped: skippedCount,
      updates: candidates.map((c) => ({ bundleId: c.bundleId, from: c.from, to: c.to }))
    },
    textRenderer: renderDryRunOutput
  });
  return 0;
}

async function selectUpdatesInteractively(interactive: boolean, candidates: UpdateCandidate[]): Promise<UpdateCandidate[]> {
  if (!interactive || candidates.length === 0) {
    return candidates;
  }
  const inquirer = await loadInquirer();
  const answers = await (inquirer.prompt as (q: unknown) => Promise<{ selected: UpdateCandidate[] }>)([{
    type: 'checkbox',
    name: 'selected',
    message: 'Select bundles to update:',
    choices: candidates.map((c) => ({
      name: `${c.bundleId}: ${c.from} → ${c.to}`,
      value: c,
      checked: true
    }))
  }]);
  return answers.selected;
}

function renderNoUpdates(ctx: Context, fmt: OutputFormat, checked: number, skippedCount: number): number {
  formatOutput({
    ctx, command: 'update', output: fmt, status: 'ok',
    data: { checked, updated: 0, skipped: skippedCount, updates: [] },
    textRenderer: () => `All bundles are up to date. (checked ${String(checked)})\n`
  });
  return 0;
}

/**
 * Build a scope-aware target writer, matching install/uninstall's own
 * `createWriterFactory`.
 * @param ctx CLI context.
 * @param target Target being updated.
 * @param scope Effective scope (may override `target.scope`).
 * @param commitMode Effective commit mode (repository scope only).
 * @returns A TargetWriter.
 */
function writerFor(ctx: Context, target: Target, scope: string, commitMode: RepositoryCommitMode): TargetWriter {
  const effectiveScope = scope as Target['scope'];
  if (effectiveScope === 'repository' && new Set(['vscode', 'vscode-insiders', 'copilot-cli']).has(target.type)) {
    const writer = new RepositoryScopeWriter({
      fs: ctx.fs,
      workspaceRoot: target.rootPath ?? ctx.cwd(),
      commitMode
    });
    return new RepositoryScopeWriterAdapter(writer);
  }
  const transformer = TransformerRegistry.withBuiltIns().getTransformer(target.type);
  const layoutLoader = new FileSystemLayoutConfigLoader({
    cwd: ctx.cwd(),
    fs: ctx.fs,
    userConfigDir: resolveUserConfigDir(ctx.env)
  });
  return new FileTreeTargetWriter({ fs: ctx.fs, env: ctx.env, transformer, layoutLoader });
}

async function applyUpdates(
  toInstall: UpdateCandidate[],
  target: Target,
  scope: string,
  commitMode: RepositoryCommitMode,
  lockPath: string,
  ctx: Context,
  http: HttpClient,
  tokens: TokenProvider
): Promise<{ updatedCount: number; updateResults: UpdateEntry[] }> {
  let updatedCount = 0;
  const updateResults: UpdateEntry[] = [];

  for (const candidate of toInstall) {
    try {
      await applyUpdate(candidate, target, scope, commitMode, lockPath, ctx, http, tokens);
      updateResults.push({ bundleId: candidate.bundleId, from: candidate.from, to: candidate.to });
      updatedCount++;
    } catch (err) {
      ctx.stderr.write(`Failed to update ${candidate.bundleId}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return { updatedCount, updateResults };
}

async function syncActiveHub(ctx: Context): Promise<void> {
  try {
    const userPaths = resolveUserConfigPaths(ctx.env);
    if (!(await ctx.fs.exists(userPaths.root))) {
      return;
    }
    const activeStore = new ActiveHubStore(userPaths.activeHub, ctx.fs);
    const hubId = await activeStore.get();
    if (hubId === null) {
      return;
    }
    const mgr = createHubManager({ ctx });
    await mgr.syncHub(hubId);
  } catch {
    // Hub sync failure is non-fatal.
  }
}

async function applyUpdate(
  candidate: UpdateCandidate,
  target: Target,
  scope: string,
  commitMode: RepositoryCommitMode,
  lockPath: string,
  ctx: Context,
  http: HttpClient,
  tokens: TokenProvider
): Promise<void> {
  const downloader = new HttpsBundleDownloader(
    http,
    candidate.downloadTokens ?? tokens,
    candidate.repositoryTarget,
    candidate.authenticationCategory
  );
  const extractor = new ZipBundleExtractor();

  const dl = await downloader.download(candidate.installable);
  const files = await extractor.extract(dl.bytes);
  const manifest = validateManifest(files, { expectedId: undefined, expectedVersion: undefined });

  const writer = writerFor(ctx, target, scope, commitMode);
  const targetFiles = getInstallableBundleFiles(files, manifest);
  const result = await writeTargetSafely(writer, target, targetFiles);

  const entry: LockfileBundleEntry = {
    version: manifest.version,
    sourceId: candidate.entry.sourceId,
    sourceType: candidate.entry.sourceType,
    checksum: dl.sha256,
    installedAt: new Date().toISOString(),
    files: checksumFiles(targetFiles, result.writtenBundlePaths ?? targetFiles.keys())
  };
  if (scope === 'repository') {
    entry.commitMode = commitMode;
  }

  const lock = await readLockfile(lockPath, ctx.fs);
  if (lock === null) {
    return;
  }
  let nextLock = upsertBundleEntry(lock, manifest.id, entry);
  nextLock = upsertSource(nextLock, candidate.entry.sourceId, candidate.source);
  await writeLockfile(lockPath, nextLock, ctx.fs);

  const stateStore = new TargetStateStore({ fs: ctx.fs, statePath: path.join(ctx.cwd(), '.ai-primitives-hub', 'target-state.json') });
  const existingState = await stateStore.load(target.name);
  const bundles = existingState?.lastInstalledBundles ?? [];
  const idx = bundles.findIndex((b) => b.bundleId === manifest.id);
  const bundleState = { bundleId: manifest.id, version: manifest.version, installedAt: new Date().toISOString() };
  if (idx === -1) {
    bundles.push(bundleState);
  } else {
    bundles[idx] = bundleState;
  }
  await stateStore.save({ targetName: target.name, lastInstalledBundles: bundles, lastUsedAt: new Date().toISOString() });
}
