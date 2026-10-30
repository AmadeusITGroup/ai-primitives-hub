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
  mapToolToTarget,
  readLockfile,
  type RecordInstallResult,
  removeSupersededFiles,
  resolveRecordSource,
  resolveUserConfigPaths,
  type TargetMapping,
  type TargetWriter,
  TransformerRegistry,
  upsertBundleEntry,
  upsertSource,
  writeBundleSafely,
  writeLockfile,
} from '@ai-primitives-hub/app';
import type {
  ExtractedFiles,
  GitHubApi,
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HttpClient,
  HubSourceSpec,
  Installable,
  RecordLevel,
  RecordLocation,
  RegistrySource,
  SourceType,
  Target,
  TokenProvider,
  ToolEntry,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import {
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  ActiveHubStore,
  AnonymousCredentialProvider,
  ArtifactoryBundleDownloader,
  ArtifactoryEnvCredentialProvider,
  ArtifactoryHttpClient,
  createGitHubSourceAuthRuntime,
  defaultTokenProvider,
  FileSystemLayoutConfigLoader,
  GitHubApiClient,
  HttpsBundleDownloader,
  isGitHubAppAuthEnabled,
  NodeHttpClient,
  parseGitHubRepositoryTarget,
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
  CLI_RECORD_GENERATED_BY,
  Command,
  configuredSources,
  type Context,
  createHubManager,
  failWith,
  findProjectLockfile,
  formatOutput,
  loadInquirer,
  loadTargets,
  lockfilePathForTarget,
  Option,
  type OutputFormat,
  type PreparedRecordSelection,
  prepareRecordSelection,
  readTargetsSafely,
  recordOutputFields,
  RegistryError,
  renderRecordLine,
  resolveEffectiveTarget,
  resolveTarget,
  resolveTargetName,
  toLockfileBundleEntry,
  toLockfileSourceEntry,
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
  artifactoryClient?: ArtifactoryHttpClient;
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

function renderDryRunOutput(d: { checked: number; updates: UpdateEntry[]; failures?: string[] }): string {
  const failureCount = d.failures?.length ?? 0;
  const lines = d.updates.length > 0
    ? [`Available updates (${String(d.updates.length)}):`, ...d.updates.map((update) => `  ${update.bundleId}: ${update.from} → ${update.to}`)]
    : [];
  if (failureCount > 0) {
    if (lines.length === 0) {
      return `Update check is incomplete. ${String(failureCount)} bundle${failureCount === 1 ? '' : 's'} could not be checked. Review the reported failures.\n`;
    }
    lines.push('', `Update check is incomplete. ${String(failureCount)} bundle${failureCount === 1 ? '' : 's'} could not be checked. Review the reported failures.`);
    return lines.join('\n') + '\n';
  }
  if (lines.length === 0) {
    return `All bundles are up to date. (checked ${String(d.checked)})\n`;
  }
  lines.push('', 'Re-run without --dry-run to apply.');
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
      const targetName = await resolveTargetName(opts.target, 'update', ctx, () => loadTargets(ctx));
      const configuredTarget = await resolveTarget(targetName, 'update', ctx, () => loadTargets(ctx));
      const target = resolveEffectiveTarget(ctx, configuredTarget, opts);

      // Select the record first: every selected file is loaded and checked
      // before anything is fetched or written (W5 step 1, NFR4.8).
      const prepared = await prepareRecordSelection(ctx, { command: 'update', lockfile: this.lockfile, scope: opts.scope }, target);
      if (prepared.selection.level === 'repository' && prepared.selection.locations.length > 0) {
        const rows = await prepared.service.listEntries(prepared.selection.locations);
        if (rows.length > 0) {
          if (!this.noHubSync) {
            await syncActiveHub(ctx);
          }
          return await updateFromRecord({
            ctx, fmt, http, tokens, prepared,
            explicit: this.target !== undefined && this.target.length > 0 ? target : undefined,
            dryRun: this.dryRun,
            interactive: this.interactive
          });
        }
      }

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
      const { candidates, skipped, failures: discoveryFailures } = await findUpdateCandidates(remoteBundleIds, lock, ctx, http, tokens);

      if (this.dryRun) {
        return renderDryRun(ctx, fmt, lockPath, bundleIds.length, skipped.length, candidates, discoveryFailures);
      }

      const toInstall = await selectUpdatesInteractively(this.interactive, candidates);
      if (toInstall.length === 0) {
        return renderNoUpdates(ctx, fmt, bundleIds.length, skipped.length, discoveryFailures);
      }

      const { updatedCount, updateResults, failures: updateFailures } = await applyUpdates(toInstall, target, scope, commitMode, lockPath, ctx, http, tokens);
      const failures = [...discoveryFailures, ...updateFailures];

      formatOutput({
        ctx, command: 'update', output: fmt, status: failures.length > 0 ? 'warning' : 'ok',
        data: { lockfile: lockPath, target: target.name, checked: bundleIds.length, updated: updatedCount, skipped: skipped.length, updates: updateResults, failures },
        warnings: failures,
        textRenderer: failures.length > 0
          ? (data) => {
            const lines = data.updates.length > 0
              ? [`Updated ${String(data.updates.length)} bundle${data.updates.length === 1 ? '' : 's'}:`, ...data.updates.map((update) => `  ${update.bundleId}: ${update.from} → ${update.to}`)]
              : ['No bundles were updated.'];
            const failureSummary = data.failures.length === 1
              ? '1 update check or installation failed.'
              : `${String(data.failures.length)} update checks or installations failed.`;
            lines.push('', failureSummary, 'Review the reported failures.');
            return lines.join('\n') + '\n';
          }
          : renderUpdateOutput
      });
      return failures.length > 0 ? 1 : 0;
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
  return type === 'github' || type === 'awesome-copilot' || type === 'skills' || type === 'artifactory';
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
      collectionsPath: src.collectionsPath,
      ...(src.type === 'artifactory' ? { indexFile: src.indexFile, authMode: src.authMode, credentialRef: src.credentialRef } : {})
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
): Promise<{ candidates: UpdateCandidate[]; skipped: string[]; failures: string[] }> {
  const candidates: UpdateCandidate[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
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
      let artifactoryClient: ArtifactoryHttpClient | undefined;
      if (src.type === 'artifactory') {
        const credentials = src.authMode === 'bearer' && src.credentialRef !== undefined
          ? new ArtifactoryEnvCredentialProvider(ctx.env, src.credentialRef, src.url)
          : new AnonymousCredentialProvider();
        artifactoryClient = new ArtifactoryHttpClient(http, credentials, src.url);
        resolverDispatcher = new SourceDispatcher({
          githubApi, fs: ctx.fs, http,
          artifactoryCredentialProvider: () => credentials
        });
      } else if (sourceAware && src.type !== 'artifactory') {
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
          downloadTokens: dependencies?.downloadTokens,
          artifactoryClient
        });
      }
    } catch (error) {
      if (sourceAware && error instanceof Error && error.message.startsWith('GitHub source preflight failed')) {
        throw error;
      }
      skipped.push(bundleId);
      failures.push(`Failed to check updates for ${bundleId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { candidates, skipped, failures };
}

function renderDryRun(
  ctx: Context,
  fmt: OutputFormat,
  lockPath: string,
  checked: number,
  skippedCount: number,
  candidates: UpdateCandidate[],
  failures: string[]
): number {
  formatOutput({
    ctx, command: 'update', output: fmt, status: failures.length > 0 ? 'warning' : 'ok',
    data: {
      dryRun: true, lockfile: lockPath,
      checked, updated: 0, skipped: skippedCount,
      updates: candidates.map((c) => ({ bundleId: c.bundleId, from: c.from, to: c.to })),
      failures
    },
    warnings: failures,
    textRenderer: renderDryRunOutput
  });
  return failures.length > 0 ? 1 : 0;
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

function renderNoUpdates(ctx: Context, fmt: OutputFormat, checked: number, skippedCount: number, failures: string[]): number {
  formatOutput({
    ctx, command: 'update', output: fmt, status: failures.length > 0 ? 'warning' : 'ok',
    data: { checked, updated: 0, skipped: skippedCount, updates: [], failures },
    warnings: failures,
    textRenderer: () => failures.length > 0
      ? `Update check is incomplete. ${String(failures.length)} bundle(s) could not be checked. Review the reported failures.\n`
      : `All bundles are up to date. (checked ${String(checked)})\n`
  });
  return failures.length > 0 ? 1 : 0;
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
): Promise<{ updatedCount: number; updateResults: UpdateEntry[]; failures: string[] }> {
  let updatedCount = 0;
  const updateResults: UpdateEntry[] = [];
  const failures: string[] = [];

  for (const candidate of toInstall) {
    try {
      await applyUpdate(candidate, target, scope, commitMode, lockPath, ctx, http, tokens);
      updateResults.push({ bundleId: candidate.bundleId, from: candidate.from, to: candidate.to });
      updatedCount++;
    } catch (err) {
      const failure = `Failed to update ${candidate.bundleId}: ${err instanceof Error ? err.message : String(err)}`;
      failures.push(failure);
    }
  }

  return { updatedCount, updateResults, failures };
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
  const { dl, files, manifest } = await downloadCandidate(candidate, http, tokens);
  const isArtifactory = candidate.source.type === 'artifactory';

  const writer = writerFor(ctx, target, scope, commitMode);
  const { installableFiles: targetFiles, result } = await writeBundleSafely(writer, target, files, manifest);

  const entry: LockfileBundleEntry = {
    version: manifest.version,
    sourceId: candidate.entry.sourceId,
    sourceType: candidate.entry.sourceType,
    checksum: dl.sha256,
    installedAt: new Date().toISOString(),
    files: checksumFiles(targetFiles, result.writtenBundlePaths ?? targetFiles.keys(), result.installedPaths)
  };
  if (scope === 'repository') {
    entry.commitMode = commitMode;
  }

  const lock = await readLockfile(lockPath, ctx.fs);
  if (lock === null) {
    return;
  }
  const lockKey = isArtifactory ? candidate.installable.ref.bundleId : manifest.id;
  const previousFiles = lock.bundles[lockKey]?.files;
  let nextLock = upsertBundleEntry(lock, lockKey, entry);
  nextLock = upsertSource(nextLock, candidate.entry.sourceId, candidate.source);
  await writeLockfile(lockPath, nextLock, ctx.fs);
  await removeSupersededFiles(writer, target, previousFiles, entry.files);
  await saveTargetState(ctx, target, lockKey, manifest.version);
}

/**
 * Download, extract and validate a candidate's new version.
 * @param candidate Update candidate, carrying the source it was looked up from.
 * @param http HTTP client.
 * @param tokens Fallback GitHub token provider.
 * @returns The download, its extracted files and the validated manifest.
 */
async function downloadCandidate(
  candidate: UpdateCandidate,
  http: HttpClient,
  tokens: TokenProvider
): Promise<{ dl: { bytes: Uint8Array; sha256: string }; files: ExtractedFiles; manifest: ValidatedManifest }> {
  const downloader = candidate.source.type === 'artifactory' && candidate.artifactoryClient !== undefined
    ? new ArtifactoryBundleDownloader(candidate.artifactoryClient)
    : new HttpsBundleDownloader(
      http,
      candidate.downloadTokens ?? tokens,
      candidate.repositoryTarget,
      candidate.authenticationCategory
    );
  const extractor = new ZipBundleExtractor();

  const dl = await downloader.download(candidate.installable);
  const files = await extractor.extract(dl.bytes);
  const isArtifactory = candidate.source.type === 'artifactory';
  const manifest = validateManifest(files, { expectedId: undefined, expectedVersion: isArtifactory ? candidate.installable.ref.bundleVersion : undefined });
  return { dl, files, manifest };
}

/**
 * Record a bundle's new version in the target's last-installed state.
 * @param ctx CLI context.
 * @param target Target the bundle was written to.
 * @param bundleId Bundle id.
 * @param version New version.
 */
async function saveTargetState(ctx: Context, target: Target, bundleId: string, version: string): Promise<void> {
  const stateStore = new TargetStateStore({ fs: ctx.fs, statePath: path.join(ctx.cwd(), '.ai-primitives-hub', 'target-state.json') });
  const existingState = await stateStore.load(target.name);
  const bundles = existingState?.lastInstalledBundles ?? [];
  const idx = bundles.findIndex((b) => b.bundleId === bundleId);
  const bundleState = { bundleId, version, installedAt: new Date().toISOString() };
  if (idx === -1) {
    bundles.push(bundleState);
  } else {
    bundles[idx] = bundleState;
  }
  await stateStore.save({ targetName: target.name, lastInstalledBundles: bundles, lastUsedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Repository install record (format 3.0.0) — workflow W5.
// ---------------------------------------------------------------------------

/** One (bundle, tool) entry to update, with its mapped target and decided source. */
interface RecordPlanItem {
  bundleId: string;
  tool: string;
  /** The file that holds the entry (BR6.5). */
  location: RecordLocation;
  entry: ToolEntry;
  sourceId: string;
  /** Source decided by the trust gate, in the legacy lockfile shape (NFR4.11). */
  source: LockfileSourceEntry;
  /** Mapped target, made effective (BR6.4). */
  target: Target;
}

/** A (bundle, tool) entry that was not updated, and why. */
interface SkippedRecordEntry {
  bundleId: string;
  tool: string;
  reason: string;
}

/** Inputs of {@link updateFromRecord}. */
interface RecordUpdateRun {
  ctx: Context;
  fmt: OutputFormat;
  http: HttpClient;
  tokens: TokenProvider;
  prepared: PreparedRecordSelection;
  /** The target named by `--target`; only it narrows the plan to one tool (BR6.1). */
  explicit?: Target;
  dryRun: boolean;
  interactive: boolean;
}

/** What {@link updateFromRecord} reports. */
interface RecordUpdateData {
  dryRun?: true;
  level: RecordLevel;
  records: string[];
  checked: number;
  updated: number;
  updates: { bundleId: string; tool: string; from: string; to: string }[];
  alsoUpdated: { bundleId: string; tool: string }[];
  skipped: SkippedRecordEntry[];
  failures: string[];
}

const entryKey = (bundleId: string, tool: string): string => `${bundleId}\u0000${tool}`;

/**
 * A one-bundle legacy lockfile for `findUpdateCandidates`, built from the
 * record entry and the decided source only, so the record's own url and
 * credentials never reach the lookup unless the configured source matched.
 * @param item Plan item.
 */
const lookupLockfile = (item: RecordPlanItem): Lockfile => ({
  $schema: '',
  version: '2.0.0',
  generatedAt: '',
  generatedBy: CLI_RECORD_GENERATED_BY,
  bundles: { [item.bundleId]: toLockfileBundleEntry(item.entry) },
  sources: { [item.sourceId]: item.source }
});

/**
 * Write a downloaded bundle with a target's own writer.
 * @param ctx CLI context.
 * @param target Effective target.
 * @param files Extracted bundle files.
 * @param manifest Validated manifest.
 * @returns The writer's `written` list (absolute paths).
 */
async function writeForTarget(ctx: Context, target: Target, files: ExtractedFiles, manifest: ValidatedManifest): Promise<string[]> {
  const writer = writerFor(ctx, target, target.scope, target.commitMode ?? 'commit');
  const { result } = await writeBundleSafely(writer, target, files, manifest);
  return [...result.written];
}

/**
 * Build the update plan from the selected record (W5 steps 2–3): every
 * (bundle, tool) entry at the level except `unknown`, narrowed to one tool
 * only by an explicit `--target`. Each tool is mapped to a configured target
 * and each source goes through the trust gate here, before any lookup or
 * download and also under `--dry-run` (NFR4.10, NFR4.11).
 * @param run Update inputs.
 * @param mapTool Cached tool-to-target mapping.
 * @returns The plan items, the skipped entries and the mapping notes.
 */
async function planRecordUpdates(
  run: RecordUpdateRun,
  mapTool: (tool: string) => Promise<TargetMapping>
): Promise<{ items: RecordPlanItem[]; skipped: SkippedRecordEntry[]; notes: string[] }> {
  const { ctx, prepared, explicit } = run;
  const { selection, store, service, fs } = prepared;
  const configured = await configuredSources(ctx);
  const items: RecordPlanItem[] = [];
  const skipped: SkippedRecordEntry[] = [];
  const notes = new Set<string>();
  for (const row of await service.listEntries(selection.locations)) {
    if (row.needsReinstall || (explicit !== undefined && row.tool !== explicit.type)) {
      continue;
    }
    const { bundleId, tool } = row;
    const mapping = await mapTool(tool);
    if ('skip' in mapping) {
      skipped.push({ bundleId, tool, reason: mapping.skip });
      continue;
    }
    if (mapping.note !== undefined) {
      notes.add(mapping.note);
    }
    const location = selection.locations.find((candidate) => candidate.path === row.record);
    if (location === undefined) {
      continue;
    }
    const { record } = await store.load(location);
    const entry = record.bundles[bundleId].tools[tool];
    const fromRecord = Object.hasOwn(record.sources, entry.sourceId) ? record.sources[entry.sourceId] : undefined;
    if (fromRecord === undefined) {
      skipped.push({ bundleId, tool, reason: `source ${entry.sourceId} is not in the record` });
      continue;
    }
    const decision = await resolveRecordSource(entry.sourceId, fromRecord, configured, selection.root, fs);
    if ('skip' in decision) {
      skipped.push({ bundleId, tool, reason: decision.skip });
      continue;
    }
    items.push({
      bundleId,
      tool,
      location,
      entry,
      sourceId: entry.sourceId,
      source: toLockfileSourceEntry(decision.use),
      target: resolveEffectiveTarget(ctx, mapping.target)
    });
  }
  return { items, skipped, notes: [...notes] };
}

/**
 * Apply one update (W5 steps 4–5): write with the mapped target's writer,
 * re-record the entry under its key in the file that holds it, then run each
 * synced sibling's own writer at the new version and re-record it with
 * `syncSiblings: false`. Superseded files are not deleted here; the caller
 * deletes them after every save.
 * @param run Update inputs.
 * @param item Plan item.
 * @param candidate Its update candidate, looked up from the decided source.
 * @param siblingTargets Mapped targets of the bundle's other tools.
 * @returns The record changes and the siblings synced or left out of date.
 */
async function applyRecordUpdate(
  run: RecordUpdateRun,
  item: RecordPlanItem,
  candidate: UpdateCandidate,
  siblingTargets: ReadonlyMap<string, Target>
): Promise<{ version: string; changes: RecordInstallResult[]; synced: string[]; outOfDate: { tool: string; version: string }[] }> {
  const { ctx, http, tokens, prepared } = run;
  const { files, manifest } = await downloadCandidate(candidate, http, tokens);
  const source = { sourceId: item.sourceId, ...item.source };
  const record = async (tool: string, location: RecordLocation, target: Target, syncSiblings: false | ((sibling: string) => boolean)) =>
    prepared.service.recordInstall({
      location,
      bundleId: item.bundleId,
      version: manifest.version,
      tool,
      source,
      sourceType: item.source.type,
      writtenPaths: await writeForTarget(ctx, target, files, manifest),
      workspaceRoot: target.rootPath ?? ctx.cwd(),
      syncSiblings
    });
  const change = await record(item.tool, item.location, item.target, (sibling) => siblingTargets.has(sibling));
  const changes = [change];
  const synced: string[] = [];
  const outOfDate: { tool: string; version: string }[] = [];
  for (const sibling of change.siblings) {
    const siblingTarget = siblingTargets.get(sibling.tool);
    if (!sibling.synced || siblingTarget === undefined) {
      outOfDate.push({ tool: sibling.tool, version: sibling.version });
      continue;
    }
    changes.push(await record(sibling.tool, sibling.location, siblingTarget, false));
    synced.push(sibling.tool);
  }
  await saveTargetState(ctx, item.target, item.bundleId, manifest.version);
  return { version: manifest.version, changes, synced, outOfDate };
}

/**
 * Text output of the repository record update.
 * @param d Output data.
 */
function renderRecordUpdateOutput(d: RecordUpdateData & { recordLine: string }): string {
  const lines: string[] = [];
  const updateLines = d.updates.map((u) => `  ${u.bundleId} (${u.tool}): ${u.from} → ${u.to}`);
  if (d.dryRun === true) {
    lines.push(...(updateLines.length > 0 ? [`Available updates (${String(updateLines.length)}):`, ...updateLines] : []));
  } else if (updateLines.length > 0) {
    lines.push(`Updated ${String(updateLines.length)} entr${updateLines.length === 1 ? 'y' : 'ies'}:`, ...updateLines);
  }
  if (lines.length === 0 && d.failures.length === 0) {
    lines.push(`All bundles are up to date. (checked ${String(d.checked)})`);
  }
  lines.push(...d.alsoUpdated.map((a) => `Also updated ${a.bundleId} for ${a.tool}.`),
    ...d.skipped.map((s) => `Skipped ${s.bundleId} (${s.tool}): ${s.reason}`));
  if (d.failures.length > 0) {
    lines.push(`${String(d.failures.length)} update check${d.failures.length === 1 ? '' : 's'} or installation${d.failures.length === 1 ? '' : 's'} failed. Review the reported failures.`);
  }
  if (d.dryRun === true && updateLines.length > 0) {
    lines.push('Re-run without --dry-run to apply.');
  }
  return lines.join('\n') + '\n' + d.recordLine;
}

/**
 * Update the bundles of the selected repository record (W5; BR6.1, BR6.4,
 * BR6.5, BR8.1–BR8.3, NFR4.8–NFR4.11). Every entry is gated, mapped and
 * looked up from its decided source before anything is downloaded.
 * @param run Update inputs.
 * @returns Exit code: 1 when a lookup or an update failed, else 0.
 */
async function updateFromRecord(run: RecordUpdateRun): Promise<number> {
  const { ctx, fmt, http, tokens, prepared, explicit } = run;
  const { selection, service, fs } = prepared;
  const targets = await readTargetsSafely(loadTargets(ctx));
  const mappings = new Map<string, TargetMapping>();
  const mapTool = async (tool: string): Promise<TargetMapping> => {
    let mapping = mappings.get(tool);
    if (mapping === undefined) {
      mapping = await mapToolToTarget({ fs, tool, level: selection.level, gitRoot: selection.root, targets, explicit, cwd: ctx.cwd() });
      mappings.set(tool, mapping);
    }
    return mapping;
  };

  const { items, skipped, notes } = await planRecordUpdates(run, mapTool);
  const checked = items.length + skipped.length;
  const failures: string[] = [];
  const found: { item: RecordPlanItem; candidate: UpdateCandidate }[] = [];
  for (const item of items.filter((planned) => isRemoteSource(planned.source.type))) {
    const lookup = await findUpdateCandidates([item.bundleId], lookupLockfile(item), ctx, http, tokens);
    failures.push(...lookup.failures);
    found.push(...lookup.candidates.map((candidate) => ({ item, candidate })));
  }

  const data: RecordUpdateData = {
    ...await recordOutputFields(selection, fs),
    checked,
    updated: 0,
    updates: [],
    alsoUpdated: [],
    skipped,
    failures
  };
  const warnings = [...notes];
  if (run.dryRun) {
    data.dryRun = true;
    data.updates = found.map(({ item, candidate }) => ({ bundleId: item.bundleId, tool: item.tool, from: candidate.from, to: candidate.to }));
  } else {
    const chosen = new Set(await selectUpdatesInteractively(run.interactive, found.map(({ candidate }) => candidate)));
    const rows = await service.listEntries(selection.locations);
    const done = new Set<string>();
    const changes: RecordInstallResult[] = [];
    for (const { item, candidate } of found.filter((pair) => chosen.has(pair.candidate))) {
      if (done.has(entryKey(item.bundleId, item.tool))) {
        continue;
      }
      const siblingTargets = new Map<string, Target>();
      for (const row of rows.filter((other) => other.bundleId === item.bundleId && other.tool !== item.tool && !other.needsReinstall)) {
        const mapping = await mapTool(row.tool);
        if ('target' in mapping) {
          siblingTargets.set(row.tool, resolveEffectiveTarget(ctx, mapping.target));
        }
      }
      try {
        const applied = await applyRecordUpdate(run, item, candidate, siblingTargets);
        changes.push(...applied.changes);
        done.add(entryKey(item.bundleId, item.tool));
        data.updates.push({ bundleId: item.bundleId, tool: item.tool, from: candidate.from, to: applied.version });
        for (const tool of applied.synced) {
          done.add(entryKey(item.bundleId, tool));
          data.alsoUpdated.push({ bundleId: item.bundleId, tool });
        }
        for (const stale of applied.outOfDate) {
          const mapping = await mapTool(stale.tool);
          const why = 'skip' in mapping ? mapping.skip : 'not updated';
          const existing = skipped.find((s) => s.bundleId === item.bundleId && s.tool === stale.tool);
          const reason = `out of date (still ${stale.version}): ${existing?.reason ?? why}`;
          if (existing === undefined) {
            skipped.push({ bundleId: item.bundleId, tool: stale.tool, reason });
          } else {
            existing.reason = reason;
          }
        }
      } catch (error) {
        failures.push(`Failed to update ${item.bundleId} for ${item.tool}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Superseded files go only after every save, keeping any file another entry lists (FR3.2, NFR4.9).
    for (const change of changes) {
      const removal = await service.deleteSuperseded(change);
      warnings.push(...change.warnings, ...removal.warnings);
    }
    data.updated = data.updates.length;
  }

  formatOutput({
    ctx,
    command: 'update',
    output: fmt,
    status: failures.length > 0 || skipped.length > 0 ? 'warning' : 'ok',
    data,
    warnings: [...warnings, ...failures],
    textRenderer: (d) => renderRecordUpdateOutput({ ...d, recordLine: renderRecordLine({ level: d.level, records: d.records }) })
  });
  return failures.length > 0 ? 1 : 0;
}
