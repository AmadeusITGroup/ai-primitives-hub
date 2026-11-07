/**
 * `update` command — checks installed bundles for newer versions and upgrades them.
 *
 * The install record (format 3.0.0) exists at repository level
 * (`ai-primitives-hub.lock.json` / `ai-primitives-hub.local.lock.json` at the
 * git root) and at user level (the shared `ai-primitives-hub.user.lock.json`),
 * keyed by bundle and tool. `update` selects one level (`--lockfile`, then
 * `--scope`, then the target's scope or the default rule) and updates every
 * (bundle, tool) entry there, each through the configured target mapped to
 * its tool; `--target` narrows the run to that target's tool (BR6.1, BR6.4).
 * With zero or several targets and no `--target`, the record alone decides
 * (BR23.3); when it holds no entry, `--target` is required (BR23.2).
 *
 * Bundles listed only in an older 2.0.0 file (`prompt-registry.*`, or the
 * CLI's old user lockfile) are updated with the code below, on that file,
 * through one resolved target (BR10.1).
 */
import * as path from 'node:path';
import {
  checksumFiles,
  FileTreeTargetWriter,
  githubRepoSlugForSource,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileSourceEntry,
  type MigrationReport,
  planRecordEntries,
  readLockfile,
  recordIdentityOf,
  type RecordInstallResult,
  recordKeyForVersion,
  removeSupersededFiles,
  resolveUserConfigPaths,
  type TargetMapping,
  type TargetWriter,
  toLockfileBundleEntry,
  toLockfileSourceEntry,
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
  RepositoryExclusion,
  SourceType,
  Target,
  TokenProvider,
  ToolEntry,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import {
  IMPORTED_USER_LOCKFILE_FIELD,
  isRecordError,
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
  GitHubApiClient,
  HttpsBundleDownloader,
  isGitHubAppAuthEnabled,
  NodeHttpClient,
  parseGitHubRepositoryTarget,
  type RepositoryCommitMode,
  RepositoryScopeWriter,
  RepositoryScopeWriterAdapter,
  SourceDispatcher,
  StaticTokenProvider,
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
import {
  CLI_RECORD_GENERATED_BY,
  Command,
  configuredSources,
  type Context,
  createHubManager,
  createLayoutLoader,
  failWith,
  findProjectLockfile,
  finishRecordRun,
  formatOutput,
  inferTargetName,
  loadInquirer,
  loadTargets,
  lockfilePathForTarget,
  migrateDecision,
  Option,
  type OutputFormat,
  type PreparedRecordSelection,
  prepareOldFileOnly,
  prepareRecordDecision,
  readTargetsSafely,
  type RecordDecision,
  recordOutputFields,
  recordPlannedInstall,
  type RecordSelectionInput,
  RegistryError,
  renderMigration,
  renderRecordLine,
  resolveCommandTarget,
  resolveEffectiveTarget,
  type TargetOverrides,
  tokensForRecordSource,
  writerEnv,
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

      Reads the install record, checks each remote bundle against its upstream
      source, and installs available upgrades.

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
      // BR23.3: with zero or several targets and no --target, the record
      // decides. Its level is chosen read-only first, so a run the record does
      // not decide fails below before anything is migrated, written or fetched
      // (NFR4.27).
      const input = { command: 'update', lockfile: this.lockfile, scope: opts.scope };
      const run: RecordUpdateBase = {
        ctx, fmt, http, tokens, overrides: opts, dryRun: this.dryRun, interactive: this.interactive, noHubSync: this.noHubSync
      };
      const targetName = await inferTargetName(ctx, opts.target);
      if (targetName === undefined) {
        const decided = await runRecordUpdate(run, await prepareRecordWithoutTarget(ctx, input, this.dryRun));
        if (decided !== undefined) {
          return decided;
        }
      }

      const target = await resolveCommandTarget(ctx, 'update', targetName, opts);

      // Select the record first, so a bad record stops before anything is fetched or written; a dry run never migrates.
      const decision = await prepareRecordDecision(ctx, input, { write: this.dryRun !== true, target });
      const recorded = await runRecordUpdate(run, decision, this.target !== undefined && this.target.length > 0 ? target : undefined);
      if (recorded !== undefined) {
        return recorded;
      }
      // Once the user record imported the old user lockfile, an empty record never falls back to that file;
      // a workspace-scope target and an explicit --lockfile still use it.
      const prepared = decision?.prepared;
      if (prepared !== undefined && prepared.selection.level === 'user' && prepared.selection.locations.length > 0
        && target.scope === 'user' && !(this.lockfile?.length)
        && (await prepared.store.load(prepared.selection.locations[0])).record[IMPORTED_USER_LOCKFILE_FIELD] !== undefined) {
        return failWith(ctx, fmt, 'update', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'update: nothing is installed at the user level',
          hint: 'Install a bundle first; the old user lockfile was imported and is no longer read.'
        }));
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
      const { candidates, skipped, failures: discoveryFailures } = await findUpdateCandidates(remoteBundleIds(lock, bundleIds), lock, ctx, http, tokens);

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
 * Fills in `opts.lockfile` when it can be inferred; the target is inferred
 * later (`inferTargetName`, BR23.2).
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
}

function isRemoteSource(type: string): boolean {
  return type === 'github' || type === 'awesome-copilot' || type === 'skills' || type === 'artifactory';
}

const remoteBundleIds = (lock: Lockfile, bundleIds: readonly string[]): string[] => bundleIds.filter((bundleId) => {
  const src = lock.sources[lock.bundles[bundleId].sourceId];
  return src !== undefined && isRemoteSource(src.type);
});

/**
 * The record `update` acts on when no target is inferred (zero or several
 * configured, no `--target`; BR23.3). The level is chosen read-only first
 * (`--lockfile`, then `--scope`, then the default rule) and only its 3.0.0
 * entries decide; bundles that only an older store lists do not. When they
 * decide, a real run migrates the level before anything is fetched
 * ({@link migrateDecision}, BR18.1); a dry run keeps the read-only selection.
 * @param ctx CLI context.
 * @param input Command name and the typed `--lockfile` / `--scope`.
 * @param dryRun `true` for `--dry-run`.
 * @returns The decision to update, or `undefined` when the record does not decide (the caller then needs a target).
 * @throws {RegistryError} A `RECORD.*` error naming the file.
 */
async function prepareRecordWithoutTarget(
  ctx: Context,
  input: Omit<RecordSelectionInput, 'write'>,
  dryRun: boolean
): Promise<RecordDecision | undefined> {
  const decision = await prepareRecordDecision(ctx, input);
  return decision.rows.length === 0 ? undefined : migrateDecision(ctx, decision, { dryRun });
}

/** What every record-driven update run shares, whatever its target. */
type RecordUpdateBase = Omit<RecordUpdateRun, 'prepared' | 'explicit'> & { noHubSync: boolean };

/**
 * Update from the record when its entries decide: sync the active hub unless
 * `--no-hub-sync`, then {@link updateFromRecord} (W5). One path for the run
 * with no inferred target (BR23.3) and the targeted one.
 * @param run Context, clients, overrides and flags of the update.
 * @param decision The selected record and its entries; none when the record does not decide.
 * @param explicit The target named by `--target`; only it narrows the plan to one tool (BR6.1).
 * @returns Exit code, or `undefined` when the selected record has no entry (the caller then uses the old store).
 */
async function runRecordUpdate(
  run: RecordUpdateBase,
  decision: RecordDecision | undefined,
  explicit?: Target
): Promise<number | undefined> {
  if (decision === undefined || decision.rows.length === 0) {
    return undefined;
  }
  const { noHubSync, ...base } = run;
  if (!noHubSync) {
    await syncActiveHub(base.ctx);
  }
  return updateFromRecord({ ...base, ...(explicit === undefined ? {} : { explicit }), prepared: decision.prepared });
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
  tokens: TokenProvider,
  anonymous = false
): Promise<{ candidates: UpdateCandidate[]; skipped: string[]; failures: string[] }> {
  const candidates: UpdateCandidate[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  // A source taken from the record runs without credentials.
  const sourceAware = !anonymous && isGitHubAppAuthEnabled(ctx.env);
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
 * @param exclusion Where a local-only write lists its files; `<workspace>/.git/info/exclude` by default.
 * @returns A TargetWriter.
 */
function writerFor(ctx: Context, target: Target, scope: string, commitMode: RepositoryCommitMode, exclusion?: RepositoryExclusion): TargetWriter {
  const effectiveScope = scope as Target['scope'];
  if (effectiveScope === 'repository' && new Set(['vscode', 'vscode-insiders', 'copilot-cli']).has(target.type)) {
    const writer = new RepositoryScopeWriter({
      fs: ctx.fs,
      workspaceRoot: target.rootPath ?? ctx.cwd(),
      commitMode,
      exclusion
    });
    return new RepositoryScopeWriterAdapter(writer);
  }
  const transformer = TransformerRegistry.withBuiltIns().getTransformer(target.type);
  const layoutLoader = createLayoutLoader(ctx);
  return new FileTreeTargetWriter({ fs: ctx.fs, env: writerEnv(ctx.env, effectiveScope), transformer, layoutLoader });
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
}

async function downloadCandidate(
  candidate: UpdateCandidate,
  http: HttpClient,
  tokens: TokenProvider,
  expect?: { bundleId: string; source: LockfileSourceEntry }
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
  // A record update checks the archive is the recorded bundle at the candidate version, as replay does.
  const manifest = validateManifest(files, expect === undefined
    ? { expectedId: undefined, expectedVersion: isArtifactory ? candidate.installable.ref.bundleVersion : undefined }
    : {
      expectedId: isArtifactory ? undefined : expect.bundleId,
      expectedVersion: candidate.installable.ref.bundleVersion,
      sourceRepoSlug: githubRepoSlugForSource(expect.source)
    });
  return { dl, files, manifest };
}

// ---------------------------------------------------------------------------
// Repository install record update.
// ---------------------------------------------------------------------------

/** One (bundle, tool) entry to update, with its mapped target and decided source. */
interface RecordPlanItem {
  bundleId: string;
  tool: string;
  /** The file that holds the entry. */
  location: RecordLocation;
  entry: ToolEntry;
  sourceId: string;
  /** Source decided by the trust gate, in the legacy lockfile shape. */
  source: LockfileSourceEntry;
  /** Mapped target, made effective. */
  target: Target;
  /** `true` when no configured source matched, so the source came from the record. */
  fromRecord: boolean;
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
  /** The target named by `--target`; only it narrows the plan to one tool. */
  explicit?: Target;
  /** `--scope` / `--commit-mode`, applied to the target inferred for old-file-only bundles (BR10.1). */
  overrides: TargetOverrides;
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
  /** Bundles only in the old `prompt-registry.*` file, handled with the old code. */
  oldFile?: OldFileUpdate;
  /** What the migration run before the update did. */
  migration?: MigrationReport;
}

/** What {@link updateOldFileOnly} reports for the old `prompt-registry.*` file. */
interface OldFileUpdate {
  lockfile: string;
  checked: number;
  updated: number;
  updates: UpdateEntry[];
  /** Old-file-only bundles that could not be looked up or are not remote. */
  skipped: number;
  failures: string[];
}

/**
 * Key of a (bundle, tool) entry that matches the entry at any version of a versioned id.
 * @param bundleId Recorded key.
 * @param version Version recorded for it.
 * @param tool Tool key.
 */
const entryKey = (bundleId: string, version: string, tool: string): string => `${recordIdentityOf(bundleId, version)}\u0000${tool}`;

/**
 * A one-bundle legacy lockfile for `findUpdateCandidates`, built only from the entry and the decided source.
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

async function writeForTarget(
  ctx: Context,
  target: Target,
  files: ExtractedFiles,
  manifest: ValidatedManifest,
  exclusion?: RepositoryExclusion
): Promise<string[]> {
  const writer = writerFor(ctx, target, target.scope, target.commitMode ?? 'commit', exclusion);
  const { result } = await writeBundleSafely(writer, target, files, manifest);
  return [...result.written];
}

/**
 * Build the update plan, mapping and gating every entry before any lookup, also under `--dry-run`.
 * @param run Update inputs.
 */
async function planRecordUpdates(
  run: RecordUpdateRun
): Promise<{ items: RecordPlanItem[]; skipped: SkippedRecordEntry[]; notes: string[]; mapTool: (tool: string) => Promise<TargetMapping> }> {
  const { ctx, prepared, explicit } = run;
  const { selection, store, service, fs } = prepared;
  const plan = await planRecordEntries({
    service,
    store,
    fs,
    selection,
    targets: await readTargetsSafely(loadTargets(ctx)),
    configured: await configuredSources(ctx),
    explicit,
    cwd: ctx.cwd(),
    holdingFile: 'listed'
  });
  return {
    items: plan.items.map((item) => ({
      bundleId: item.bundleId,
      tool: item.tool,
      location: item.location,
      entry: item.entry,
      sourceId: item.entry.sourceId,
      source: toLockfileSourceEntry(item.source),
      target: resolveEffectiveTarget(ctx, item.target),
      fromRecord: item.fromRecordOnly
    })),
    skipped: [
      ...plan.skipped,
      // An entry whose tool is unknown cannot be updated in place.
      ...plan.needsReinstall.map((row) => ({
        bundleId: row.bundleId, tool: row.tool, reason: `needs reinstall (tool unknown, still ${row.version}): install it for a tool`
      }))
    ],
    notes: plan.notes,
    mapTool: plan.mapTool
  };
}

/**
 * Apply one update and run each synced sibling's own writer at the new version; deletes nothing.
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
): Promise<{
  version: string;
  changes: RecordInstallResult[];
  synced: string[];
  outOfDate: { tool: string; version: string }[];
  failed: { tool: string; reason: string }[];
}> {
  const { ctx, http, prepared } = run;
  // A versioned id moves to the new version's key; the record then drops the old one.
  const bundleId = recordKeyForVersion(item.bundleId, item.entry.version, candidate.to);
  const { files, manifest } = await downloadCandidate(
    candidate, http, tokensForRecordSource(run.tokens, item.fromRecord), { bundleId, source: item.source }
  );
  const record = async (tool: string, location: RecordLocation, target: Target, syncSiblings: false | ((sibling: string) => boolean)) =>
    recordPlannedInstall(
      prepared.service, { ...item, bundleId, tool, location, sourceType: item.source.type }, target, ctx, manifest.version,
      await writeForTarget(ctx, target, files, manifest, prepared.exclusion), syncSiblings
    );
  const change = await record(item.tool, item.location, item.target, (sibling) => siblingTargets.has(sibling));
  const changes = [change];
  const synced: string[] = [];
  const outOfDate: { tool: string; version: string }[] = [];
  const failed: { tool: string; reason: string }[] = [];
  for (const sibling of change.siblings) {
    const siblingTarget = siblingTargets.get(sibling.tool);
    if (!sibling.synced || siblingTarget === undefined) {
      outOfDate.push({ tool: sibling.tool, version: sibling.version });
      continue;
    }
    // A failed sibling is reported; the changes already made are still finished by the caller.
    try {
      changes.push(await record(sibling.tool, sibling.location, siblingTarget, false));
      synced.push(sibling.tool);
    } catch (error) {
      if (isRecordError(error)) {
        throw error;
      }
      failed.push({ tool: sibling.tool, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { version: manifest.version, changes, synced, outOfDate, failed };
}

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
  if (d.oldFile !== undefined) {
    const old = d.oldFile;
    const verb = d.dryRun === true ? 'available' : 'updated';
    lines.push(`Old file ${old.lockfile}: ${String(old.updates.length)} of ${String(old.checked)} bundle${old.checked === 1 ? '' : 's'} ${verb}.`,
      ...old.updates.map((u) => `  ${u.bundleId}: ${u.from} → ${u.to}`));
  }
  if (d.failures.length > 0) {
    lines.push(`${String(d.failures.length)} update check${d.failures.length === 1 ? '' : 's'} or installation${d.failures.length === 1 ? '' : 's'} failed. Review the reported failures.`);
  }
  if (d.dryRun === true && updateLines.length > 0) {
    lines.push('Re-run without --dry-run to apply.');
  }
  return lines.join('\n') + '\n' + renderMigration(d.migration) + d.recordLine;
}

/**
 * Update every tool entry of the selected repository record.
 * @param run Update inputs.
 * @returns Exit code.
 */
async function updateFromRecord(run: RecordUpdateRun): Promise<number> {
  const { ctx, fmt, http, prepared } = run;
  const { selection, service, fs } = prepared;
  const { items, skipped, notes, mapTool } = await planRecordUpdates(run);
  const checked = items.length + skipped.length;
  const failures: string[] = [];
  const found: { item: RecordPlanItem; candidate: UpdateCandidate }[] = [];
  for (const item of items.filter((planned) => isRemoteSource(planned.source.type))) {
    const lookup = await findUpdateCandidates([item.bundleId], lookupLockfile(item), ctx, http, tokensForRecordSource(run.tokens, item.fromRecord), item.fromRecord);
    failures.push(...lookup.failures);
    found.push(...lookup.candidates.map((candidate) => ({ item, candidate })));
    // A lookup that found no installable release is reported, not taken as up to date.
    if (lookup.skipped.includes(item.bundleId) && lookup.failures.length === 0) {
      skipped.push({ bundleId: item.bundleId, tool: item.tool, reason: `no installable release found at ${item.source.url}` });
    }
  }

  const data: RecordUpdateData = {
    ...await recordOutputFields(selection, fs),
    checked,
    updated: 0,
    updates: [],
    alsoUpdated: [],
    skipped,
    failures,
    ...(prepared.migration === undefined ? {} : { migration: prepared.migration })
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
      const key = entryKey(item.bundleId, item.entry.version, item.tool);
      if (done.has(key)) {
        continue;
      }
      const identity = recordIdentityOf(item.bundleId, item.entry.version);
      const siblingTargets = new Map<string, Target>();
      const sameBundle = (other: { bundleId: string; version: string }): boolean => other.bundleId === item.bundleId || recordIdentityOf(other.bundleId, other.version) === identity;
      for (const row of rows.filter((other) => sameBundle(other) && other.tool !== item.tool && !other.needsReinstall)) {
        const mapping = await mapTool(row.tool);
        if ('target' in mapping) {
          siblingTargets.set(row.tool, resolveEffectiveTarget(ctx, mapping.target));
        }
      }
      try {
        const applied = await applyRecordUpdate(run, item, candidate, siblingTargets);
        changes.push(...applied.changes);
        done.add(key);
        data.updates.push({ bundleId: item.bundleId, tool: item.tool, from: candidate.from, to: applied.version });
        for (const tool of applied.synced) {
          done.add(entryKey(item.bundleId, item.entry.version, tool));
          data.alsoUpdated.push({ bundleId: item.bundleId, tool });
        }
        for (const sibling of applied.failed) {
          failures.push(`Failed to update ${item.bundleId} for ${sibling.tool}: ${sibling.reason}`);
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
    warnings.push(...await finishRecordRun(service, changes));
    data.updated = data.updates.length;
  }

  // Bundles only in the old file are updated with the old code; the record wins for the others.
  const oldFile = await updateOldFileOnly(run);
  if (oldFile !== undefined) {
    data.oldFile = oldFile;
    failures.push(...oldFile.failures);
  }

  // Exit 1 when every planned entry was skipped.
  const nothingProcessed = checked > 0 && items.length === 0 && (oldFile === undefined || oldFile.checked === oldFile.skipped);
  formatOutput({
    ctx,
    command: 'update',
    output: fmt,
    status: failures.length > 0 || skipped.length > 0 ? 'warning' : 'ok',
    data,
    warnings: [...warnings, ...failures],
    textRenderer: (d) => renderRecordUpdateOutput({ ...d, recordLine: renderRecordLine({ level: d.level, records: d.records }) })
  });
  return failures.length > 0 || nothingProcessed ? 1 : 0;
}

/**
 * Update the bundles only the old `prompt-registry.*` file has, with the old code and on that file.
 * They go to the `--target` or only configured target, with the overrides applied, else fail per bundle.
 * @param run Update inputs.
 * @returns `undefined` when there is no old-file-only bundle.
 */
async function updateOldFileOnly(run: RecordUpdateRun): Promise<OldFileUpdate | undefined> {
  const { ctx, http, tokens } = run;
  const old = await prepareOldFileOnly(ctx, run.prepared, { command: 'update', target: run.explicit, overrides: run.overrides });
  if (old === undefined) {
    return undefined;
  }
  const { lockPath, lock, bundleIds } = old;
  if ('reason' in old) {
    return {
      lockfile: lockPath, checked: bundleIds.length, updated: 0, updates: [], skipped: 0,
      failures: bundleIds.map((bundleId) => `Failed to update ${bundleId}: ${old.reason}`)
    };
  }
  const { target } = old;
  const { candidates, skipped, failures } = await findUpdateCandidates(remoteBundleIds(lock, bundleIds), lock, ctx, http, tokens);
  const checkedOnly: OldFileUpdate = {
    lockfile: lockPath,
    checked: bundleIds.length,
    updated: 0,
    updates: candidates.map((c) => ({ bundleId: c.bundleId, from: c.from, to: c.to })),
    skipped: skipped.length,
    failures
  };
  if (run.dryRun) {
    return checkedOnly;
  }
  const toInstall = await selectUpdatesInteractively(run.interactive, candidates);
  const applied = await applyUpdates(toInstall, target, target.scope, target.commitMode ?? 'commit', lockPath, ctx, http, tokens);
  return { ...checkedOnly, updated: applied.updatedCount, updates: applied.updateResults, failures: [...failures, ...applied.failures] };
}
