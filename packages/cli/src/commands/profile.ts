/**
 * `profile` commands.
 *
 * Subcommands:
 *   profile list [--hub <id>]
 *   profile show <profileId>
 *   profile activate <profileId> [--hub <id>] [--target <name>...]
 *   profile deactivate
 *   profile current
 *   profile create <profileId> --name <name>
 *   profile edit <profileId>
 *   profile publish <profileId> --hub <id>
 *
 * The activation lifecycle (verify the profile, enforce one active
 * profile, save activation state, set the hub `active` flag) is app's
 * `activateProfile`/`deactivateProfile` (`registry/profile-lifecycle.ts`),
 * shared with the VS Code extension. The CLI supplies the
 * `ProfileLifecycleSync` that writes the bundles.
 *
 * Activation writes bundle files to every configured target (optionally
 * filtered via `--target`) with the same primitives as `install`. Repository
 * and user targets record bundles in the install record, as `install` and
 * `uninstall` do; workspace targets keep the older user lockfile. Activation
 * state is tracked only via `ProfileActivationStore`.
 */
import * as path from 'node:path';
import {
  activateProfile,
  batchInstallProfile,
  type BatchInstallProfileResult,
  checksumFiles,
  cleanupOrphanedSource,
  deactivateProfile,
  emptyLockfile,
  githubRepoSlugForSource,
  type HubConfigStore,
  type HubManager,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileSourceEntry,
  type MigrationReport,
  type ProfileLifecycleDeps,
  readLockfile,
  type RecordSourceInput,
  removeBundleEntry,
  removeSupersededFiles,
  resolveUserConfigPaths,
  type TargetWriter,
  toLockfileSourceEntry,
  toRecordSource,
  upsertBundleEntry,
  upsertSource,
  writeBundleSafely,
  writeLockfile,
} from '@ai-primitives-hub/app';
import {
  type HttpClient,
  type HubProfile,
  type HubProfileBundle,
  isRecordError,
  type ProfileActivationState,
  type ProfileBundleSyncResult,
  type ProfileLifecycleSync,
  type RecordLevel,
  type RegistrySource,
  type Target,
  type TokenProvider,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  HubStore,
  isGitHubAppAuthEnabled,
  ProfileActivationStore,
} from '@ai-primitives-hub/infra';
import * as yaml from 'js-yaml';
import {
  Command,
  type Context,
  createHttpClientAndTokens,
  createHubManager,
  failWith,
  formatOutput,
  loadTargets,
  lockfilePathForTarget,
  Option,
  type OutputFormat,
  type PreparedRepositoryRecord,
  prepareRecordForTarget,
  prepareUninstallForTarget,
  recordRepositoryInstall,
  recordRepositoryUninstall,
  RegistryError,
  renderMigration,
  renderRecordLine,
  requireActiveHubOrFail,
  resolveEffectiveTarget,
  toCommandRecordError,
  usesInstallRecord,
} from '../framework';
import {
  createSourceAwareInstallDependencyCache,
  createWriterFactory,
  fetchFilesForSource,
  type SourceAwareInstallDependencyCache,
} from './install';
import {
  createWriterFactory as createUninstallWriterFactory,
  runUserScopeUninstall,
} from './uninstall';

/** A record file a profile command read or wrote for one target. */
export interface ProfileRecordFile {
  target: string;
  level: RecordLevel;
  /** Absolute path of the record file. */
  path: string;
}

/**
 * Re-wrap a record error under a profile command's name; the original error is used, since activation rolls back its files.
 * @param command - message prefix
 * @param error - any error
 */
const toProfileRecordError = (command: string, error: unknown): unknown => {
  if (!isRecordError(error)) {
    return error;
  }
  const original = isRecordError(error.cause) ? error.cause : error;
  return toCommandRecordError(command, original);
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The `Record: <level> <path>` lines, one per level, each file once.
 * @param records - record files per target
 */
const renderProfileRecordLines = (records: readonly ProfileRecordFile[]): string => {
  const byLevel = new Map<RecordLevel, string[]>();
  for (const record of records) {
    const paths = byLevel.get(record.level) ?? [];
    if (!paths.includes(record.path)) {
      paths.push(record.path);
    }
    byLevel.set(record.level, paths);
  }
  return [...byLevel].map(([level, paths]) => renderRecordLine({ level, records: paths })).join('');
};

/**
 * Bundle of HubManager + activation store + HTTP/token deps, as
 * returned by {@link buildHubMgr} and consumed by
 * {@link runProfileActivation}.
 */
export interface BuiltHubMgr {
  mgr: HubManager;
  activations: ProfileActivationStore;
  /** Hub config store (same directory as `mgr`'s), for app's profile lifecycle. */
  hubs: HubConfigStore;
  http: HttpClient;
  tokens: TokenProvider;
}

/**
 * Build HubManager and related instances.
 * @param ctx CLI context.
 * @param http HTTP client (optional test seam).
 * @param tokens Token provider (optional test seam).
 * @returns HubManager, activations store, HTTP client, and token provider.
 */
export const buildHubMgr = (ctx: Context, http?: HttpClient, tokens?: TokenProvider): BuiltHubMgr => {
  const [httpClient, tokenProvider] = createHttpClientAndTokens(http, ctx, tokens);
  const mgr = createHubManager({ ctx, http: httpClient, tokens: tokenProvider });
  // Activation state lives under `<hubsDir>/profile-activations/` — the same
  // base directory `HubStore` itself uses so `hub remove` can clean up any
  // activation files left behind for a removed hub (see infra's
  // `ProfileActivationStore` module doc).
  const hubsDir = resolveUserConfigPaths(ctx.env).hubs;
  return {
    mgr,
    activations: new ProfileActivationStore(hubsDir, ctx.fs),
    // `HubStore` keeps no cache, so this instance and the one inside `mgr`
    // always see the same files.
    hubs: new HubStore(hubsDir, ctx.fs),
    http: httpClient,
    tokens: tokenProvider
  };
};

/**
 * Resolve hub ID from options or active hub.
 * @param mgr Hub manager.
 * @param hubId Optional hub ID from options.
 * @returns Hub ID.
 */
const resolveHubId = async (mgr: HubManager, hubId?: string): Promise<string> => {
  if (hubId && typeof hubId === 'string') {
    return hubId;
  }
  const active = await mgr.getActiveHub();
  if (!active) {
    throw new RegistryError({
      code: 'HUB.NOT_FOUND',
      message: 'no active hub',
      hint: 'Run `ai-primitives-hub hub add` to import a hub, then `hub use <id>` to activate it.'
    });
  }
  return active.id;
};

/**
 * Context passed to profile command execute methods.
 */
interface ProfileCommandContext {
  ctx: Context;
  http?: HttpClient;
  tokens?: TokenProvider;
}

/**
 * Base class for profile commands with shared context.
 */
abstract class BaseProfileCommand extends Command {
  /**
   * Get the CLI context. This needs to be set by the CLI entry point.
   */
  public commandContext!: ProfileCommandContext;

  public output = Option.String('-o,--output');
  public hubId = Option.String('--hub');
}

/**
 * profile list - list profiles in a hub
 */
export class ProfileListCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'list']];
  public static readonly usage = Command.Usage({
    description: 'List profiles in a hub.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile list [options]

      Options:
        --hub <hub-id>           Hub ID to list profiles from
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub profile list
        ai-primitives-hub profile list --hub my-hub
    `
  });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);
    const mgr = built.mgr;

    let hubId: string;
    try {
      hubId = await resolveHubId(mgr, this.hubId);
    } catch (err) {
      if (err instanceof RegistryError) {
        return failWith(ctx, fmt, 'profile', err);
      }
      throw err;
    }

    const hubs = await mgr.listHubs();
    if (!hubs.some((h) => h.id === hubId)) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'HUB.NOT_FOUND',
        message: `profile list: hub "${hubId}" not found`,
        hint: 'Run `ai-primitives-hub hub list` to see available hubs.'
      }));
    }
    const all = await mgr.listSourcesAcrossAllHubs();
    const sourceCount = all.filter((s) => s.hubId === hubId).length;
    const active = await mgr.getActiveHub();
    const profiles = active?.id === hubId
      ? active.config.profiles.map((p) => ({
        id: p.id, name: p.name, bundles: p.bundles.length
      }))
      : [];
    formatOutput({
      ctx, command: 'profile.list', output: fmt, status: 'ok',
      data: { hubId, profiles, sourceCount },
      textRenderer: (d) => d.profiles.length === 0
        ? `No profiles in hub "${d.hubId}". Run \`ai-primitives-hub profile create <id> --name <name>\` to add one.\n`
        : d.profiles.map((p) => `${p.id}  ${p.name} (${String(p.bundles)} bundle${p.bundles === 1 ? '' : 's'})\n`).join('')
    });
    return 0;
  }
}

/**
 * profile show - show profile details
 */
export class ProfileShowCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'show']];
  public static readonly usage = Command.Usage({
    description: 'Show details of a profile.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile show <profile-id> [options]

      Options:
        --hub <hub-id>           Hub ID containing the profile
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub profile show my-profile
        ai-primitives-hub profile show my-profile --hub my-hub
    `
  });

  public profileId = Option.String({ required: false });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);
    const mgr = built.mgr;

    if (!this.profileId) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile show: <profileId> required'
      }));
    }

    let hubId: string;
    try {
      hubId = await resolveHubId(mgr, this.hubId);
    } catch (err) {
      if (err instanceof RegistryError) {
        return failWith(ctx, fmt, 'profile', err);
      }
      throw err;
    }

    const active = await requireActiveHubOrFail(mgr, hubId, 'profile.show', ctx, fmt);
    if (typeof active === 'number') {
      return active;
    }
    const profile = active.config.profiles.find((p) => p.id === this.profileId);
    if (profile === undefined) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'BUNDLE.NOT_FOUND',
        message: `profile show: "${this.profileId}" not in hub "${hubId}"`,
        hint: 'Run `ai-primitives-hub profile list` to see available profiles.'
      }));
    }
    formatOutput({
      ctx, command: 'profile.show', output: fmt, status: 'ok',
      data: { hubId, profile },
      textRenderer: (d) => `${d.profile.name} (${d.profile.id})\n`
        + `  Bundles: ${String(d.profile.bundles.length)}\n`
        + d.profile.bundles.map((b) => `    - ${b.id}@${b.version} (source: ${b.source})\n`).join('')
    });
    return 0;
  }
}

/**
 * profile current - show currently active profile
 */
export class ProfileCurrentCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'current']];
  public static readonly usage = Command.Usage({
    description: 'Show the currently active profile.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile current

      Examples:
        $ ai-primitives-hub profile current
    `
  });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);

    const allActive = await built.activations.listAll();
    const active = allActive[0];
    if (!active) {
      formatOutput({
        ctx, command: 'profile.current', output: fmt, status: 'ok',
        data: { active: null },
        textRenderer: () => 'No active profile.\n'
      });
      return 0;
    }
    formatOutput({
      ctx, command: 'profile.current', output: fmt, status: 'ok',
      data: { active: { hubId: active.hubId, profileId: active.profileId } },
      textRenderer: (d) => `Active profile: ${d.active.profileId} (hub: ${d.active.hubId})\n`
    });
    return 0;
  }
}

/**
 * Result of activating a single profile bundle against a single target.
 */
type ActivateBundleOutcome =
  | { ok: true; written: string[]; entry: LockfileBundleEntry; sourceEntry: LockfileSourceEntry; source: RecordSourceInput }
  | { ok: false; reason: string };

/**
 * Fetch, validate, and write one profile bundle into one target,
 * mirroring `install.ts`'s `performRemoteInstall` but sourced from an
 * already-resolved `RegistrySource` (from `HubManager.listSources`)
 * rather than a freshly-parsed bundle spec. Never throws.
 * @param bundleRef Bundle reference from the profile.
 * @param sources Sources configured on the profile's hub, keyed by source id.
 * @param target Target to write into.
 * @param writer Writer for this target (from `createWriterFactory`).
 * @param http HTTP client.
 * @param tokens Token provider.
 * @param ctx CLI context.
 * @param sourceAwareDependencyCache
 * @returns The written files and lockfile entries on success, or a failure reason.
 */
async function activateBundleForTarget(
  bundleRef: HubProfileBundle,
  sources: Record<string, RegistrySource>,
  target: Target,
  writer: TargetWriter,
  http: HttpClient,
  tokens: TokenProvider,
  ctx: Context,
  sourceAwareDependencyCache?: SourceAwareInstallDependencyCache
): Promise<ActivateBundleOutcome> {
  const src = sources[bundleRef.source];
  if (!src) {
    return { ok: false, reason: `source "${bundleRef.source}" not found in hub` };
  }
  // Same record source as `install`, so the source trust gate sees one source.
  const source = toRecordSource(src, src.id);
  // The fetch entry keeps every recorded field, Artifactory's index file and auth included.
  const sourceEntry: LockfileSourceEntry = toLockfileSourceEntry(source);
  // `fetchFilesForSource` only reads `.version`/`.sourceId` off this
  // parameter — the rest are dummy values to satisfy `LockfileBundleEntry`'s
  // shape without fabricating a fake install history.
  const probeEntry: LockfileBundleEntry = {
    version: bundleRef.version,
    sourceId: src.id,
    sourceType: src.type,
    installedAt: '',
    files: []
  };
  try {
    const files = await fetchFilesForSource(
      sourceEntry,
      bundleRef.id,
      probeEntry,
      http,
      tokens,
      ctx,
      false,
      sourceAwareDependencyCache
    );
    if (files === null) {
      return { ok: false, reason: 'failed to fetch bundle files' };
    }
    const manifest = validateManifest(files, {
      // Artifactory identity is already bound to the resolved index entry during fetch.
      expectedId: src.type === 'artifactory' ? undefined : bundleRef.id,
      expectedVersion: bundleRef.version === 'latest' ? undefined : bundleRef.version,
      // Hub profiles name GitHub bundles `{owner}-{repo}-{manifestId}`.
      sourceRepoSlug: githubRepoSlugForSource(src)
    });
    const { installableFiles: targetFiles, result } = await writeBundleSafely(writer, target, files, manifest);
    const entry: LockfileBundleEntry = {
      version: manifest.version,
      sourceId: src.id,
      sourceType: src.type,
      installedAt: new Date().toISOString(),
      files: checksumFiles(targetFiles, result.writtenBundlePaths ?? targetFiles.keys(), result.installedPaths)
    };
    if (target.scope === 'repository') {
      entry.commitMode = target.commitMode ?? 'commit';
    }
    return { ok: true, written: result.written, entry, sourceEntry, source };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** A profile bundle deactivate kept because its record entry is `unknown`. */
export interface ProfileUnknownBundle {
  bundleId: string;
  target: string;
  /** Record file holding the entry. */
  lockfile: string;
}

/** What {@link deactivateProfileBundles} did. */
export interface ProfileDeactivationReport {
  /** Record files an entry was removed from. */
  records: ProfileRecordFile[];
  migrations: MigrationReport[];
  /** Bundles whose only entry is `unknown`: entry and files kept. */
  unknown: ProfileUnknownBundle[];
  warnings: string[];
}

/**
 * Remove a profile's bundles from one repository or user target through the record uninstall path.
 * A bundle whose only entry is `unknown` is kept and reported, since its tool is not known.
 * @param ctx - CLI context
 * @param bundleIds - bundles the profile synced
 * @param target - effective repository or user target
 * @param report - report to fill in
 */
async function deactivateRecordTarget(
  ctx: Context,
  bundleIds: readonly string[],
  target: Target,
  report: ProfileDeactivationReport
): Promise<void> {
  const prepared = await prepareUninstallForTarget(ctx, target);
  if (prepared === undefined) {
    return;
  }
  if (prepared.migration !== undefined) {
    report.migrations.push(prepared.migration);
  }
  const files = new Set<string>();
  for (const bundleId of new Set(bundleIds)) {
    if (prepared.entries.has(bundleId)) {
      const recorded = await recordRepositoryUninstall(prepared, bundleId);
      files.add(recorded.lockfile);
      report.warnings.push(...recorded.warnings);
    } else if (prepared.loneUnknown?.has(bundleId) === true
      && !report.unknown.some((kept) => kept.bundleId === bundleId && kept.lockfile === prepared.location.path)) {
      report.unknown.push({ bundleId, target: target.name, lockfile: prepared.location.path });
    }
  }
  for (const file of files) {
    report.records.push({ target: target.name, level: prepared.location.level, path: file });
  }
}

/**
 * Remove every bundle in a profile activation state from every target, the inverse of the activate loop.
 * Best-effort: a target that fails becomes a warning.
 * @param ctx CLI context.
 * @param state Activation state recording which bundles were synced.
 * @param targets Targets to remove the profile's bundles from.
 */
async function deactivateProfileBundles(ctx: Context, state: ProfileActivationState, targets: Target[]): Promise<ProfileDeactivationReport> {
  const report: ProfileDeactivationReport = { records: [], migrations: [], unknown: [], warnings: [] };
  for (const configuredTarget of targets) {
    const target = resolveEffectiveTarget(ctx, configuredTarget);
    if (usesInstallRecord(target)) {
      try {
        await deactivateRecordTarget(ctx, state.syncedBundles, target, report);
      } catch (error) {
        report.warnings.push(`${target.name}: ${errorMessage(toProfileRecordError('profile deactivate', error))}`);
      }
      continue;
    }
    const lockPath = lockfilePathForTarget(ctx, target);
    const writer = createUninstallWriterFactory(ctx, {})(target);
    for (const bundleId of state.syncedBundles) {
      try {
        await runUserScopeUninstall(bundleId, lockPath, target, ctx, writer);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
  return report;
}

/**
 * Remove bundles (files and lockfile entries) from one target. Best
 * effort: a bundle missing from the target's lockfile is skipped.
 * @param ctx CLI context.
 * @param bundleIds Bundles to remove.
 * @param configuredTarget Target to remove them from.
 */
async function removeBundlesFromTarget(ctx: Context, bundleIds: string[], configuredTarget: Target): Promise<void> {
  const target = resolveEffectiveTarget(ctx, configuredTarget);
  if (target.scope === 'repository') {
    const pipeline = new UninstallPipeline({
      fs: ctx.fs,
      target,
      repositoryPath: target.rootPath ?? ctx.cwd(),
      writerFactory: createUninstallWriterFactory(ctx, {})
    });
    for (const bundleId of bundleIds) {
      try {
        await pipeline.run(bundleId);
      } catch {
        // Best-effort cleanup.
      }
    }
  } else {
    const lockPath = lockfilePathForTarget(ctx, target);
    const writer = createUninstallWriterFactory(ctx, {})(target);
    for (const bundleId of bundleIds) {
      try {
        await runUserScopeUninstall(bundleId, lockPath, target, ctx, writer);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

/**
 * Result of {@link runProfileActivation}.
 */
export interface ProfileActivationResult {
  state: ProfileActivationState;
  written: Record<string, string[]>;
  failures: { bundleId: string; target: string; reason: string }[];
  /** Install record files written. */
  records: ProfileRecordFile[];
  /** Migration reports of the levels migrated before the first write. */
  migrations: MigrationReport[];
  warnings: string[];
}

/**
 * Deactivate whatever profile(s) were previously active, then activate
 * `profile` through app's shared `activateProfile` lifecycle (the one the
 * VS Code extension uses), with a CLI sync that fetches and writes every
 * bundle to every target and updates each target's lockfile. The saved
 * activation state lists only bundles that were installed, at their
 * installed version. Shared by `ProfileActivateCommand` and `apply.ts`
 * (`apply` is, in effect, "re-activate whatever profile is currently
 * active").
 * @param ctx CLI context.
 * @param built HubManager + activation store + HTTP/token deps (from `buildHubMgr`).
 * @param hubId Hub the profile belongs to.
 * @param profile Profile to activate.
 * @param targets Targets to activate the profile on.
 * @returns The new activation state plus per-target written files and per-bundle failures.
 */
export async function runProfileActivation(
  ctx: Context,
  built: BuiltHubMgr,
  hubId: string,
  profile: HubProfile,
  targets: Target[]
): Promise<ProfileActivationResult> {
  const effectiveTargets = targets.map((target) => resolveEffectiveTarget(ctx, target));
  const lifecycle: ProfileLifecycleStores = { store: built.hubs, activationStore: built.activations };
  // The CLI's record of what is active is the activation store, not the hub
  // `active` flag that app's lifecycle scans (`hub sync` rewrites hub configs
  // and drops that flag). Deactivate every tracked profile first, including
  // this one when it is re-activated (`apply`), so bundles it no longer
  // lists are removed. Their migration reports and warnings join this output.
  const prior: ProfileDeactivationReport[] = [];
  for (const prev of await built.activations.listAll()) {
    prior.push(await deactivateTrackedProfile(ctx, lifecycle, prev, effectiveTargets));
  }

  const sync = createTargetProfileSync({
    ctx,
    built,
    lifecycle,
    profile,
    targets: effectiveTargets,
    sources: Object.fromEntries((await built.mgr.listSources(hubId)).map((s) => [s.id, s]))
  });
  const result = await activateProfile({ ...lifecycle, profileSync: sync }, hubId, profile.id, { installBundles: true });
  // app's lifecycle logs and swallows install errors; the CLI surfaces them.
  // It saved the activation state and hub `active` flag before installing,
  // so undo this activation first instead of leaving the profile active.
  if (sync.report.error !== undefined) {
    await rollbackProfileActivation(ctx, lifecycle, hubId, profile.id, effectiveTargets, sync.report);
    throw sync.report.error;
  }
  if (!result.success) {
    await rollbackProfileActivation(ctx, lifecycle, hubId, profile.id, effectiveTargets, sync.report);
    const missing = result.missingRequiredBundles ?? [];
    if (missing.length > 0) {
      throw requiredBundleMissingError('activate', hubId, profile.id, missing, sync.report.failures);
    }
    // e.g. the activation state could not be saved after the install.
    throw new RegistryError({
      code: 'HUB.ACTIVATION_FAILED',
      message: `profile activate: ${result.error ?? 'activation failed'}`,
      hint: 'Check that the hubs configuration directory is writable, then re-run the command.',
      context: { hubId, profileId: profile.id }
    });
  }
  const state = await built.activations.get(hubId, profile.id);
  if (state === null) {
    throw new Error(`profile activate: no activation state recorded for "${profile.id}"`);
  }
  return {
    state,
    written: sync.report.written,
    failures: sync.report.failures,
    records: sync.report.records,
    migrations: [...prior.flatMap((removed) => removed.migrations), ...sync.report.migrations],
    warnings: [
      ...prior.flatMap((removed) => [...removed.warnings, ...removed.unknown.map((kept) => unknownBundleWarning(kept))]),
      ...sync.report.warnings
    ]
  };
}

/**
 * The error `profile activate` and `profile install` report when a
 * `required: true` bundle was not installed.
 * @param verb Subcommand name, used in the message.
 * @param hubId Hub of the profile.
 * @param profileId Profile id.
 * @param missing Ids of the required bundles that were not installed.
 * @param failures Per-bundle/per-target install failures, for the reasons.
 * @param detail Optional sentence appended to the message.
 * @returns The error.
 */
function requiredBundleMissingError(
  verb: 'activate' | 'install',
  hubId: string,
  profileId: string,
  missing: string[],
  failures: TargetProfileSyncReport['failures'],
  detail?: string
): RegistryError {
  const reasons = failures
    .filter((f) => missing.includes(f.bundleId))
    .map((f) => `${f.bundleId} (${f.target}): ${f.reason}`);
  return new RegistryError({
    code: 'HUB.REQUIRED_BUNDLE_MISSING',
    message: `profile ${verb}: required bundles were not installed: ${missing.join(', ')}`
      + (reasons.length > 0 ? ` (${reasons.join('; ')})` : '')
      + (detail === undefined ? '' : `. ${detail}`),
    hint: 'Fix the install error of each required bundle (source configured, reachable, and authenticated), '
      + 'then re-run the command. Bundles a profile can do without should be marked `required: false` in the hub.',
    context: { hubId, profileId, missingRequiredBundles: missing }
  });
}

/** The stores app's profile lifecycle needs, without a registry sync. */
type ProfileLifecycleStores = Pick<ProfileLifecycleDeps, 'store' | 'activationStore'>;

/**
 * Remove a tracked profile's bundles from the targets, then clear its
 * activation state and hub `active` flag through app's lifecycle.
 * @param ctx CLI context.
 * @param lifecycle Hub config and activation stores.
 * @param state Activation state of the profile to deactivate.
 * @param targets Targets to remove the profile's bundles from.
 */
async function deactivateTrackedProfile(
  ctx: Context,
  lifecycle: ProfileLifecycleStores,
  state: ProfileActivationState,
  targets: Target[]
): Promise<ProfileDeactivationReport> {
  const report = await deactivateProfileBundles(ctx, state, targets);
  const result = await deactivateProfile(lifecycle, state.hubId, state.profileId);
  if (!result.success) {
    // The hub or profile no longer exists, so there is no flag to clear;
    // the activation state must still go.
    await lifecycle.activationStore.delete(state.hubId, state.profileId);
  }
  return report;
}

/**
 * Warning for a bundle kept because its record entry is `unknown`.
 * @param kept - the kept bundle
 */
const unknownBundleWarning = (kept: ProfileUnknownBundle): string =>
  `${kept.bundleId} (${kept.target}): kept, its entry in ${kept.lockfile} has tool unknown; `
  + `run \`ai-primitives-hub uninstall ${kept.bundleId}\` to remove the entry (its files are kept)`;

/**
 * Best-effort undo of a failed activation: deactivate the profile from
 * the state app's lifecycle saved (removes the bundles recorded in target
 * lockfiles, clears the activation state and hub `active` flag), then roll
 * back any file the sync wrote that no lockfile recorded. Never throws, so
 * the caller can rethrow the original failure.
 * @param ctx CLI context.
 * @param lifecycle Hub config and activation stores.
 * @param hubId Hub the profile belongs to.
 * @param profileId Profile being activated.
 * @param targets Targets the activation wrote to.
 * @param report The sync's report (absolute paths written per target).
 */
async function rollbackProfileActivation(
  ctx: Context,
  lifecycle: ProfileLifecycleStores,
  hubId: string,
  profileId: string,
  targets: Target[],
  report: TargetProfileSyncReport
): Promise<void> {
  try {
    const state = await lifecycle.activationStore.get(hubId, profileId);
    if (state !== null) {
      await deactivateTrackedProfile(ctx, lifecycle, state, targets);
    }
  } catch {
    // Best effort; the original failure is what the caller reports.
  }
  for (const target of targets) {
    const written = report.written[target.name] ?? [];
    const writer = createWriterFactory(ctx, {})(target);
    if (written.length === 0 || writer.rollback === undefined) {
      continue;
    }
    try {
      await writer.rollback(target, written);
    } catch {
      // Best effort.
    }
  }
}

/**
 * What the CLI's profile sync did, read back by {@link runProfileActivation}.
 */
interface TargetProfileSyncReport {
  written: Record<string, string[]>;
  failures: { bundleId: string; target: string; reason: string }[];
  records: ProfileRecordFile[];
  migrations: MigrationReport[];
  warnings: string[];
  /** Unexpected error (e.g. a record or lockfile I/O error) that app's lifecycle would otherwise swallow. */
  error?: Error;
}

interface TargetProfileSyncOptions {
  ctx: Context;
  built: BuiltHubMgr;
  lifecycle: ProfileLifecycleStores;
  profile: HubProfile;
  targets: Target[];
  sources: Record<string, RegistrySource>;
}

/**
 * The CLI's `ProfileLifecycleSync` for app's `activateProfile`: installs
 * a profile's bundles onto every selected target (updating each target's
 * lockfile) and removes a deactivated profile's bundles from them.
 * @param opts Context, hub deps, profile, targets, and the hub's sources.
 * @returns The sync, plus the report it fills in.
 */
function createTargetProfileSync(
  opts: TargetProfileSyncOptions
): ProfileLifecycleSync & { report: TargetProfileSyncReport } {
  const report: TargetProfileSyncReport = { written: {}, failures: [], records: [], migrations: [], warnings: [] };
  return {
    report,
    deactivateProfile: async (profileId) => {
      const states = (await opts.built.activations.listAll()).filter((s) => s.profileId === profileId);
      for (const state of states) {
        await deactivateTrackedProfile(opts.ctx, opts.lifecycle, state, opts.targets);
      }
    },
    installBundles: async (items) => {
      try {
        return await installProfileBundles(opts, items.map((item) => item.bundleId), report);
      } catch (err) {
        const error = toProfileRecordError('profile activate', err);
        report.error = error instanceof Error ? error : new Error(String(error));
        throw report.error;
      }
    }
  };
}

/**
 * Prepare the install record of every repository and user target before any bundle is written.
 * Refuses two targets of one tool at one level, since the record keeps one entry per bundle and tool.
 * @param ctx - CLI context
 * @param targets - effective targets
 * @returns The prepared record per target name; workspace targets have none.
 */
async function prepareProfileRecords(ctx: Context, targets: readonly Target[]): Promise<Map<string, PreparedRepositoryRecord>> {
  const prepared = new Map<string, PreparedRepositoryRecord>();
  const owners = new Map<string, string>();
  for (const target of targets) {
    const record = await prepareRecordForTarget(ctx, target);
    if (record === undefined) {
      continue;
    }
    const key = `${record.location.level}\u0000${record.location.root}\u0000${target.type}`;
    const owner = owners.get(key);
    if (owner !== undefined) {
      throw new RegistryError({
        code: 'USAGE.INVALID_FLAG',
        message: `profile activate: targets "${owner}" and "${target.name}" both record ${target.type} bundles in ${record.location.path}`,
        hint: 'The install record keeps one entry per bundle and tool at a level. Pick one of them with --target.',
        context: { targets: [owner, target.name], tool: target.type, record: record.location.path }
      });
    }
    owners.set(key, target.name);
    prepared.set(target.name, record);
  }
  return prepared;
}

/**
 * Write the named profile bundles to every target and record them, noting per-bundle/per-target failures.
 * @param opts Sync options.
 * @param bundleIds Bundle ids to install, in profile order.
 * @param report Report to fill in.
 * @returns The bundles installed on at least one target, with their installed version.
 */
async function installProfileBundles(
  opts: TargetProfileSyncOptions,
  bundleIds: string[],
  report: TargetProfileSyncReport
): Promise<ProfileBundleSyncResult> {
  const { ctx, built } = opts;
  const bundleRefs = bundleIds
    .map((id) => opts.profile.bundles.find((b) => b.id === id))
    .filter((b): b is HubProfileBundle => b !== undefined);
  const synced = new Map<string, string>();
  const sourceAwareDependencyCache = isGitHubAppAuthEnabled(ctx.env)
    ? createSourceAwareInstallDependencyCache(built.http, ctx)
    : undefined;
  const records = await prepareProfileRecords(ctx, opts.targets);
  for (const record of records.values()) {
    if (record.migration !== undefined) {
      report.migrations.push(record.migration);
    }
  }

  for (const target of opts.targets) {
    const writer = createWriterFactory(ctx, {})(target);
    const written: string[] = [];
    // Filled as bundles are written, so a failed activation can roll back
    // files no record or lockfile kept.
    report.written[target.name] = written;
    const record = records.get(target.name);
    const lockPath = lockfilePathForTarget(ctx, target);
    // Workspace targets keep the older user lockfile, as `install` does.
    let lock: Lockfile | undefined = record === undefined
      ? await readLockfile(lockPath, ctx.fs) ?? emptyLockfile('ai-primitives-hub-cli')
      : undefined;

    for (const bundleRef of bundleRefs) {
      const outcome = await activateBundleForTarget(
        bundleRef,
        opts.sources,
        target,
        writer,
        built.http,
        built.tokens,
        ctx,
        sourceAwareDependencyCache
      );
      if (!outcome.ok) {
        report.failures.push({ bundleId: bundleRef.id, target: target.name, reason: outcome.reason });
        continue;
      }
      written.push(...outcome.written);
      if (lock !== undefined) {
        lock = upsertSource(upsertBundleEntry(lock, bundleRef.id, outcome.entry), outcome.entry.sourceId, outcome.sourceEntry);
      } else if (record !== undefined) {
        const recorded = await recordRepositoryInstall(record, {
          bundleId: bundleRef.id,
          version: outcome.entry.version,
          tool: target.type,
          source: outcome.source,
          writtenPaths: outcome.written
        });
        if (!report.records.some((file) => file.target === target.name && file.path === recorded.lockfile)) {
          report.records.push({ target: target.name, level: record.location.level, path: recorded.lockfile });
        }
        report.warnings.push(...recorded.warnings);
      }
      synced.set(bundleRef.id, outcome.entry.version);
    }
    if (lock !== undefined) {
      await writeLockfile(lockPath, lock, ctx.fs);
    }
  }
  return { synced: [...synced].map(([bundleId, version]) => ({ bundleId, version })) };
}

/**
 * Resolve the hub, the profile, and the targets a `profile activate` or
 * `profile install` acts on, reporting a usage error when one is missing.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @param built HubManager + stores (from `buildHubMgr`).
 * @param verb Subcommand name, used in messages.
 * @param profileId `<profile-id>` argument.
 * @param hubIdOption `--hub` value.
 * @param targetsOption `--target` value (comma-separated names).
 * @returns The hub id, profile, and targets, or the exit code of the reported error.
 */
async function resolveProfileAndTargets(
  ctx: Context,
  fmt: OutputFormat,
  built: BuiltHubMgr,
  verb: 'activate' | 'install',
  profileId: string | undefined,
  hubIdOption: string | undefined,
  targetsOption: string | undefined
): Promise<number | { hubId: string; profile: HubProfile; targets: Target[] }> {
  if (!profileId) {
    return failWith(ctx, fmt, 'profile', new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: `profile ${verb}: <profileId> required`,
      hint: 'Run `ai-primitives-hub profile list` to see available profile IDs.'
    }));
  }

  let hubId: string;
  try {
    hubId = await resolveHubId(built.mgr, hubIdOption);
  } catch (err) {
    if (err instanceof RegistryError) {
      return failWith(ctx, fmt, 'profile', err);
    }
    throw err;
  }

  const active = await requireActiveHubOrFail(built.mgr, hubId, `profile.${verb}`, ctx, fmt);
  if (typeof active === 'number') {
    return active;
  }
  const profile = active.config.profiles.find((p) => p.id === profileId);
  if (profile === undefined) {
    return failWith(ctx, fmt, 'profile', new RegistryError({
      code: 'BUNDLE.NOT_FOUND',
      message: `profile ${verb}: "${profileId}" not in hub "${hubId}"`,
      hint: 'Run `ai-primitives-hub profile list` to see available profiles.'
    }));
  }

  let targets = await loadTargets(ctx);
  if (targetsOption) {
    const wanted = new Set(targetsOption.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    targets = targets.filter((t) => wanted.has(t.name));
  }
  if (targets.length === 0) {
    return failWith(ctx, fmt, 'profile', new RegistryError({
      code: 'USAGE.MISSING_FLAG',
      message: `profile ${verb}: no targets configured`,
      hint: 'Run `ai-primitives-hub target add <name> --type <type>` to configure a target.'
    }));
  }
  return { hubId, profile, targets };
}

/**
 * profile activate - activate a profile
 */
export class ProfileActivateCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'activate']];
  public static readonly usage = Command.Usage({
    description: 'Activate a profile on configured targets.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile activate <profile-id> [options]

      Options:
        --hub <hub-id>           Hub ID containing the profile
        --target <name>          Comma-separated target names to limit activation
        --dry-run                Preview changes without applying
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub profile activate default
        ai-primitives-hub profile activate default --target vscode
        ai-primitives-hub profile activate default --dry-run
    `
  });

  public profileId = Option.String({ required: false });
  public targets = Option.String('--target');
  public dryRun = Option.Boolean('--dry-run', false);

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);

    const resolved = await resolveProfileAndTargets(ctx, fmt, built, 'activate', this.profileId, this.hubId, this.targets);
    if (typeof resolved === 'number') {
      return resolved;
    }
    const { hubId, profile, targets } = resolved;

    if (this.dryRun) {
      formatOutput({
        ctx, command: 'profile.activate', output: fmt, status: 'ok',
        data: {
          dryRun: true,
          hubId,
          profileId: profile.id,
          profileName: profile.name,
          bundles: profile.bundles.map((b) => b.id),
          targets: targets.map((t) => t.name)
        },
        textRenderer: (d) => `[dry-run] Would activate profile "${d.profileId}" from hub "${d.hubId}":\n`
          + `  Bundles: ${d.bundles.join(', ')}\n`
          + `  Targets: ${d.targets.join(', ')}\n`
          + 'Run without --dry-run to apply.\n'
      });
      return 0;
    }

    let activation: ProfileActivationResult;
    try {
      activation = await runProfileActivation(ctx, built, hubId, profile, targets);
    } catch (err) {
      if (err instanceof RegistryError) {
        return failWith(ctx, fmt, 'profile', err);
      }
      throw err;
    }
    const { state, written, failures, records, migrations } = activation;
    const warnings = [...failures.map((f) => `${f.bundleId} (${f.target}): ${f.reason}`), ...activation.warnings];

    const status = failures.length === 0 ? 'ok' : 'warning';
    formatOutput({
      ctx, command: 'profile.activate', output: fmt, status,
      data: { hubId, profileId: profile.id, state, written, failures, records, ...(migrations.length > 0 ? { migrations } : {}) },
      warnings: warnings.length > 0 ? warnings : undefined,
      textRenderer: (d) => `Activated profile "${d.profileId}" from hub "${d.hubId}":\n`
        + `  Bundles: ${[...new Set(d.state.syncedBundles)].join(', ')}\n`
        + `  Targets: ${Object.keys(d.written).join(', ')}\n`
        + (d.failures.length > 0
          ? `  Failures:\n${d.failures.map((f) => `    - ${f.bundleId} (${f.target}): ${f.reason}\n`).join('')}`
          : '')
        + (d.migrations ?? []).map((migration) => renderMigration(migration)).join('')
        + renderProfileRecordLines(d.records)
    });
    return failures.length === 0 ? 0 : 1;
  }
}

/** Outcome of {@link runProfileInstall}. */
interface ProfileInstallRunResult {
  result: BatchInstallProfileResult;
  /** Per-bundle/per-target install failures. */
  failures: TargetProfileSyncReport['failures'];
}

/**
 * Install `profile`'s bundles onto every target as ordinary installs,
 * through app's shared `batchInstallProfile`, without activating the
 * profile: each target's lockfile records the bundles, no activation
 * state is saved, and active profiles stay active.
 *
 * Whether a bundle was installed before is read once, before anything is
 * written, from every lockfile the target uses (user targets share one;
 * a repository has a `commit` and a `local-only` one). Only bundles new
 * to a target count as added: undoing the batch removes the files this
 * command wrote for them and, once those are gone, their lockfile
 * entries. Files that cannot be removed stay tracked and are reported.
 * @param ctx CLI context.
 * @param built HubManager + HTTP/token deps (from `buildHubMgr`).
 * @param hubId Hub the profile belongs to.
 * @param profile Profile whose bundles to install.
 * @param targets Targets to install onto.
 * @returns The batch outcome plus per-target failures.
 */
async function runProfileInstall(
  ctx: Context,
  built: BuiltHubMgr,
  hubId: string,
  profile: HubProfile,
  targets: Target[]
): Promise<ProfileInstallRunResult> {
  const effectiveTargets = targets.map((target) => resolveEffectiveTarget(ctx, target));
  const sources: Record<string, RegistrySource> = Object.fromEntries((await built.mgr.listSources(hubId)).map((s) => [s.id, s]));
  const failures: TargetProfileSyncReport['failures'] = [];
  const sourceAwareDependencyCache = isGitHubAppAuthEnabled(ctx.env)
    ? createSourceAwareInstallDependencyCache(built.http, ctx)
    : undefined;

  // Lockfiles as they were before this command, by path.
  const lockfilesBefore = new Map<string, Lockfile | null>();
  const lockPathsOf = (target: Target): string[] => (target.scope === 'repository'
    ? (['commit', 'local-only'] as const).map((mode) => lockfilePathForTarget(ctx, target, mode))
    : [lockfilePathForTarget(ctx, target)]);
  for (const lockPath of effectiveTargets.flatMap((target) => lockPathsOf(target))) {
    if (!lockfilesBefore.has(lockPath)) {
      lockfilesBefore.set(lockPath, await readLockfile(lockPath, ctx.fs));
    }
  }
  const entryBefore = (target: Target, bundleId: string): LockfileBundleEntry | undefined =>
    lockPathsOf(target).map((lockPath) => lockfilesBefore.get(lockPath)?.bundles[bundleId]).find((e) => e !== undefined);

  // What this command added: files written for bundles new to a target, per
  // target and bundle, and the lockfile entries it created, per bundle and
  // lockfile, with the bundle's status for the targets using that lockfile
  // (also for bundles installed before through another lockfile).
  const addedFiles = new Map<string, Map<string, string[]>>();
  const createdEntries = new Map<string, Map<string, 'new' | 'updated' | 'unchanged'>>();
  const statusRank = { unchanged: 0, updated: 1, new: 2 } as const;
  // Each bundle's install outcome across targets (the strongest change wins).
  const installed = new Map<string, { version: string; status: keyof typeof statusRank }>();

  const removeAdded = async (bundleIds: string[]): Promise<void> => {
    const leftovers: string[] = [];
    // Lockfiles whose targets still hold files of a bundle, per bundle.
    const leftoverIn = new Map<string, Set<string>>();
    for (const target of effectiveTargets) {
      const writer = createWriterFactory(ctx, {})(target);
      for (const bundleId of bundleIds) {
        const written = addedFiles.get(target.name)?.get(bundleId) ?? [];
        try {
          await (writer.rollback === undefined
            ? Promise.all(written.map((file) => ctx.fs.remove(file)))
            : writer.rollback(target, written));
        } catch {
          // Checked file by file below.
        }
        for (const file of written) {
          if (await ctx.fs.exists(file)) {
            leftovers.push(file);
            leftoverIn.set(bundleId, (leftoverIn.get(bundleId) ?? new Set<string>()).add(lockfilePathForTarget(ctx, target)));
          }
        }
      }
    }
    // Drop the entries this command created, deciding per lockfile. Where the
    // bundle was new, its entry goes once its files there are gone (otherwise
    // it stays, so `uninstall` can still find them). Where it was installed
    // before, its files stay: the created entry goes only when nothing changed
    // (the earlier entry still describes the files); after an update it stays,
    // since it is the one describing the files on disk.
    const newBundles = new Set(bundleIds);
    const lockPaths = new Set([...createdEntries.values()].flatMap((byLock) => [...byLock.keys()]));
    for (const lockPath of lockPaths) {
      let lock = await readLockfile(lockPath, ctx.fs);
      if (lock === null) {
        continue;
      }
      for (const [bundleId, byLock] of createdEntries) {
        const entry = lock.bundles[bundleId];
        const status = byLock.get(lockPath);
        const drop = status === 'new'
          ? newBundles.has(bundleId) && !(leftoverIn.get(bundleId)?.has(lockPath) ?? false)
          : status === 'unchanged';
        if (entry !== undefined && drop) {
          lock = cleanupOrphanedSource(removeBundleEntry(lock, bundleId), entry.sourceId);
        }
      }
      await writeLockfile(lockPath, lock, ctx.fs);
    }
    if (leftovers.length > 0) {
      throw new Error(`could not remove ${leftovers.join(', ')}`);
    }
  };

  const result = await batchInstallProfile({
    installBundles: async (bundleRefs) => {
      try {
        for (const target of effectiveTargets) {
          const writer = createWriterFactory(ctx, {})(target);
          const lockPath = lockfilePathForTarget(ctx, target);
          let lock: Lockfile = await readLockfile(lockPath, ctx.fs) ?? emptyLockfile('ai-primitives-hub-cli');
          const superseded: { previous: LockfileBundleEntry['files']; next: LockfileBundleEntry['files'] }[] = [];
          for (const bundleRef of bundleRefs) {
            const outcome = await activateBundleForTarget(
              bundleRef, sources, target, writer, built.http, built.tokens, ctx, sourceAwareDependencyCache
            );
            if (!outcome.ok) {
              failures.push({ bundleId: bundleRef.id, target: target.name, reason: outcome.reason });
              continue;
            }
            const before = entryBefore(target, bundleRef.id);
            // Compare with this lockfile as it was before the command: user
            // targets share it, so an earlier target may already have rewritten the entry.
            const previousFiles = lockfilesBefore.get(lockPath)?.bundles[bundleRef.id]?.files;
            if (previousFiles !== undefined) {
              superseded.push({ previous: previousFiles, next: outcome.entry.files });
            }
            lock = upsertBundleEntry(lock, bundleRef.id, outcome.entry);
            lock = upsertSource(lock, outcome.entry.sourceId, outcome.sourceEntry);
            let status: keyof typeof statusRank;
            if (before === undefined) {
              status = 'new';
              const files = addedFiles.get(target.name) ?? new Map<string, string[]>();
              files.set(bundleRef.id, outcome.written);
              addedFiles.set(target.name, files);
            } else {
              status = before.version === outcome.entry.version && before.sourceId === outcome.entry.sourceId ? 'unchanged' : 'updated';
            }
            if (lockfilesBefore.get(lockPath)?.bundles[bundleRef.id] === undefined) {
              createdEntries.set(bundleRef.id, (createdEntries.get(bundleRef.id) ?? new Map<string, typeof status>()).set(lockPath, status));
            }
            const previous = installed.get(bundleRef.id);
            installed.set(bundleRef.id, {
              version: outcome.entry.version,
              status: previous !== undefined && statusRank[previous.status] > statusRank[status] ? previous.status : status
            });
          }
          await writeLockfile(lockPath, lock, ctx.fs);
          // Like `install`, drop files a replaced version no longer ships.
          for (const { previous, next } of superseded) {
            await removeSupersededFiles(writer, target, previous, next);
          }
        }
      } catch (err) {
        // e.g. lockfile I/O: undo what this command added, then report the
        // error, together with what could not be undone.
        const newBundles = [...new Set([...addedFiles.values()].flatMap((files) => [...files.keys()]))];
        const undoError = await removeAdded(newBundles).then(() => undefined, (e: unknown) => e);
        if (undoError === undefined) {
          throw err;
        }
        const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
        throw new Error(`${message(err)}; undoing this install also failed: ${message(undoError)}`, { cause: err });
      }
      return {
        installed: [...installed].map(([bundleId, v]) => ({ bundleId, ...v })),
        failed: bundleRefs
          .filter((b) => !installed.has(b.id))
          .map((b) => ({
            bundleId: b.id,
            reason: failures.filter((f) => f.bundleId === b.id).map((f) => `${f.target}: ${f.reason}`).join('; ')
          }))
      };
    },
    removeBundles: removeAdded
  }, profile.bundles);
  return { result, failures };
}

/**
 * profile install - install a profile's bundles without activating it
 */
export class ProfileInstallCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'install']];
  public static readonly usage = Command.Usage({
    description: 'Install a profile\'s bundles on configured targets without activating the profile.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile install <profile-id> [options]

      Installs every bundle of the profile as an ordinary install, recorded in
      each target's lockfile. The profile is not activated, active profiles stay
      active, and \`profile deactivate\` does not remove these bundles; use
      \`uninstall\` for that. When a required bundle cannot be installed, the
      bundles this command added are removed again and the command fails.

      Options:
        --hub <hub-id>           Hub ID containing the profile
        --target <name>          Comma-separated target names to limit the install
        --dry-run                Preview changes without applying
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub profile install default
        ai-primitives-hub profile install default --target vscode
        ai-primitives-hub profile install default --dry-run
    `
  });

  public profileId = Option.String({ required: false });
  public targets = Option.String('--target');
  public dryRun = Option.Boolean('--dry-run', false);

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);

    const resolved = await resolveProfileAndTargets(ctx, fmt, built, 'install', this.profileId, this.hubId, this.targets);
    if (typeof resolved === 'number') {
      return resolved;
    }
    const { hubId, profile, targets } = resolved;

    if (this.dryRun) {
      formatOutput({
        ctx, command: 'profile.install', output: fmt, status: 'ok',
        data: {
          dryRun: true,
          hubId,
          profileId: profile.id,
          profileName: profile.name,
          bundles: profile.bundles.map((b) => b.id),
          targets: targets.map((t) => t.name)
        },
        textRenderer: (d) => `[dry-run] Would install the bundles of profile "${d.profileId}" from hub "${d.hubId}":\n`
          + `  Bundles: ${d.bundles.join(', ')}\n`
          + `  Targets: ${d.targets.join(', ')}\n`
          + 'Run without --dry-run to apply.\n'
      });
      return 0;
    }

    let run: ProfileInstallRunResult;
    try {
      run = await runProfileInstall(ctx, built, hubId, profile, targets);
    } catch (err) {
      return failWith(ctx, fmt, 'profile', err instanceof RegistryError
        ? err
        : new RegistryError({
          code: 'FS.PROFILE_INSTALL_FAILED',
          message: `profile install: ${err instanceof Error ? err.message : String(err)}`,
          hint: 'Check that the targets and the lockfile are writable, remove any file named above, then re-run the command.',
          context: { hubId, profileId: profile.id }
        }));
    }
    const { result, failures } = run;
    if (!result.success) {
      return failWith(ctx, fmt, 'profile', requiredBundleMissingError(
        'install', hubId, profile.id, result.missingRequiredBundles ?? [], failures,
        result.removalError === undefined
          ? 'Bundles this command added were removed again'
          : `Removing the bundles this command added failed (${result.removalError}); remove those files manually`
      ));
    }

    const status = failures.length === 0 ? 'ok' : 'warning';
    formatOutput({
      ctx, command: 'profile.install', output: fmt, status,
      data: {
        hubId,
        profileId: profile.id,
        installed: result.installed,
        alreadyInstalled: result.alreadyInstalled,
        failures,
        targets: targets.map((t) => t.name)
      },
      warnings: failures.length > 0 ? failures.map((f) => `${f.bundleId} (${f.target}): ${f.reason}`) : undefined,
      textRenderer: (d) => `Installed the bundles of profile "${d.profileId}" from hub "${d.hubId}" (profile not activated):\n`
        + `  Installed: ${d.installed.map((b) => `${b.bundleId}@${b.version}`).join(', ') || 'none'}\n`
        + (d.alreadyInstalled.length > 0
          ? `  Already installed: ${d.alreadyInstalled.map((b) => `${b.bundleId}@${b.version}`).join(', ')}\n`
          : '')
        + `  Targets: ${d.targets.join(', ')}\n`
        + (d.failures.length > 0
          ? `  Failures:\n${d.failures.map((f) => `    - ${f.bundleId} (${f.target}): ${f.reason}\n`).join('')}`
          : '')
    });
    return failures.length === 0 ? 0 : 1;
  }
}

/**
 * profile deactivate - deactivate the active profile
 */
export class ProfileDeactivateCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'deactivate']];
  public static readonly usage = Command.Usage({
    description: 'Deactivate the currently active profile.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile deactivate [options]

      Options:
        --dry-run                Preview changes without applying
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub profile deactivate
        ai-primitives-hub profile deactivate --dry-run
    `
  });

  public dryRun = Option.Boolean('--dry-run', false);

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);

    const allActive = await built.activations.listAll();
    const cur = allActive[0];
    if (!cur) {
      formatOutput({
        ctx, command: 'profile.deactivate', output: fmt, status: 'ok',
        data: { deactivated: null },
        textRenderer: () => 'No active profile.\n'
      });
      return 0;
    }

    if (this.dryRun) {
      formatOutput({
        ctx, command: 'profile.deactivate', output: fmt, status: 'ok',
        data: {
          dryRun: true,
          deactivated: { hubId: cur.hubId, profileId: cur.profileId },
          bundles: cur.syncedBundles
        },
        textRenderer: (d) => `[dry-run] Would deactivate profile "${d.deactivated?.profileId}" from hub "${d.deactivated?.hubId}":\n`
          + `  Bundles: ${d.bundles.join(', ')}\n`
          + 'Run without --dry-run to apply.\n'
      });
      return 0;
    }

    const targets = await loadTargets(ctx);
    const removed = await deactivateTrackedProfile(ctx, { store: built.hubs, activationStore: built.activations }, cur, targets);
    const warnings = [...removed.warnings, ...removed.unknown.map((kept) => unknownBundleWarning(kept))];

    formatOutput({
      ctx, command: 'profile.deactivate', output: fmt, status: warnings.length === 0 ? 'ok' : 'warning',
      data: {
        deactivated: { hubId: cur.hubId, profileId: cur.profileId },
        records: removed.records,
        unknown: removed.unknown,
        ...(removed.migrations.length > 0 ? { migrations: removed.migrations } : {})
      },
      warnings: warnings.length > 0 ? warnings : undefined,
      textRenderer: (d) => `Deactivated profile "${d.deactivated.profileId}".\n`
        + d.unknown.map((kept) => `  kept ${kept.bundleId} (${kept.target}): tool unknown, files kept\n`).join('')
        + (d.migrations ?? []).map((migration) => renderMigration(migration)).join('')
        + renderProfileRecordLines(d.records)
    });
    return 0;
  }
}

/**
 * profile create - create a new local profile
 */
export class ProfileCreateCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new local profile in the default-local hub.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile create <profile-id> --name <name> [options]

      Examples:
        ai-primitives-hub profile create my-profile --name "My Profile" --description "A custom profile"
        ai-primitives-hub profile create dev-tools --name "Dev Tools" --bundles bundle1,bundle2

      Options:
        --name <name>           Profile display name (required)
        --description <text>   Profile description
        --bundles <list>        Comma-separated list of bundle IDs
        --hub <id>             Hub ID (defaults to default-local)
    `
  });

  public profileId = Option.String({ required: false });
  public name = Option.String('--name');
  public description = Option.String('--description');
  public bundles = Option.String('--bundles');

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);
    const mgr = built.mgr;

    if (!this.profileId) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile create: <profile-id> is required'
      }));
    }

    if (!this.name) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile create: --name is required'
      }));
    }

    const hubId = this.hubId ?? 'default-local';
    const bundleList = this.bundles ? this.bundles.split(',').map((b) => b.trim()) : [];

    const profileBundles: HubProfileBundle[] = bundleList.map((bundleId) => ({
      id: bundleId,
      version: 'latest',
      source: hubId,
      required: false
    }));

    const now = new Date().toISOString();
    const profile = await mgr.addProfile(hubId, {
      id: this.profileId,
      name: this.name,
      description: this.description ?? '',
      icon: '',
      active: false,
      createdAt: now,
      updatedAt: now,
      bundles: profileBundles
    });

    formatOutput({
      ctx, command: 'profile.create', output: fmt, status: 'ok',
      data: { hubId, profile: { id: profile.id, name: profile.name, bundles: profile.bundles.length } },
      textRenderer: (d) => `Created profile "${d.profile.id}" in hub "${d.hubId}" with ${String(d.profile.bundles)} bundle${d.profile.bundles === 1 ? '' : 's'}.\n`
    });
    return 0;
  }
}

const applyBundleRemovals = (bundles: HubProfileBundle[], spec: string): HubProfileBundle[] => {
  const result = [...bundles];
  for (const bundleId of spec.split(',').map((b) => b.trim())) {
    const idx = result.findIndex((b) => b.id === bundleId);
    if (idx !== -1) {
      result.splice(idx, 1);
    }
  }
  return result;
};

const applyBundleAdditions = (bundles: HubProfileBundle[], spec: string, hubId: string): HubProfileBundle[] => {
  const result = [...bundles];
  for (const bundleId of spec.split(',').map((b) => b.trim())) {
    if (!result.some((b) => b.id === bundleId)) {
      result.push({ id: bundleId, version: 'latest', source: hubId, required: false });
    }
  }
  return result;
};

/**
 * profile edit - edit an existing local profile
 */
export class ProfileEditCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'edit']];

  public static readonly usage = Command.Usage({
    description: 'Edit an existing local profile (add/remove bundles, change description).',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile edit <profile-id> [options]

      Examples:
        ai-primitives-hub profile edit my-profile --description "Updated description"
        ai-primitives-hub profile edit my-profile --add-bundles bundle1,bundle2
        ai-primitives-hub profile edit my-profile --remove-bundles bundle1,bundle2
        ai-primitives-hub profile edit my-profile --name "New Name"

      Options:
        --name <name>           New profile display name
        --description <text>   New profile description
        --add-bundles <list>    Comma-separated list of bundle IDs to add
        --remove-bundles <list> Comma-separated list of bundle IDs to remove
        --hub <id>             Hub ID (defaults to default-local)
    `
  });

  public profileId = Option.String({ required: false });
  public name = Option.String('--name');
  public description = Option.String('--description');
  public addBundles = Option.String('--add-bundles');
  public removeBundles = Option.String('--remove-bundles');

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);
    const mgr = built.mgr;

    if (!this.profileId) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile edit: <profile-id> is required'
      }));
    }

    const hubId = this.hubId ?? 'default-local';

    const hubs = await mgr.listHubs();
    const hub = hubs.find((h) => h.id === hubId);
    if (!hub) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: `profile edit: hub "${hubId}" not found`
      }));
    }

    const active = await mgr.getActiveHub();
    const profiles = active?.id === hubId ? active.config.profiles : [];
    const existingProfile = profiles.find((p) => p.id === this.profileId);

    if (!existingProfile) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: `profile edit: profile "${this.profileId}" not found in hub "${hubId}"`
      }));
    }

    let updatedBundles = [...existingProfile.bundles];
    if (this.removeBundles) {
      updatedBundles = applyBundleRemovals(updatedBundles, this.removeBundles);
    }
    if (this.addBundles) {
      updatedBundles = applyBundleAdditions(updatedBundles, this.addBundles, hubId);
    }

    const updatedProfile = await mgr.addProfile(hubId, {
      ...existingProfile,
      name: this.name ?? existingProfile.name,
      description: this.description ?? existingProfile.description,
      bundles: updatedBundles,
      updatedAt: new Date().toISOString()
    });

    formatOutput({
      ctx, command: 'profile.edit', output: fmt, status: 'ok',
      data: { hubId, profile: { id: updatedProfile.id, name: updatedProfile.name, bundles: updatedProfile.bundles.length } },
      textRenderer: (d) => `Updated profile "${d.profile.id}" in hub "${d.hubId}" with ${String(d.profile.bundles)} bundle${d.profile.bundles === 1 ? '' : 's'}.\n`
    });
    return 0;
  }
}

/**
 * Shape accepted from a `<profile-id>.profile.yml` file — looser than
 * `HubProfile` since hand-authored YAML won't set bookkeeping fields.
 */
interface ProfileYamlFile {
  id?: string;
  name?: string;
  description?: string;
  icon?: string;
  bundles?: HubProfileBundle[];
}

/**
 * profile publish - inject a profile into a hub's config
 */
export class ProfilePublishCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'publish']];

  public static readonly usage = Command.Usage({
    description: 'Publish a profile to a hub by injecting it into the hub\'s config.',
    category: 'Hub & Discovery',
    details: `
      Usage: ai-primitives-hub profile publish <profile-id> --hub <hub-id> [--file <path>]

      Examples:
        ai-primitives-hub profile publish my-profile --hub default-local
        ai-primitives-hub profile publish my-profile --hub default-local --file ./my-profile.yml

      Options:
        --hub <id>      Hub ID to publish to (required)
        --file <path>   Path to profile YAML file (defaults to <profile-id>.profile.yml)
    `
  });

  public profileId = Option.String({ required: false });
  public hubId = Option.String('--hub');
  public profileFile = Option.String('--file');

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);
    const mgr = built.mgr;

    if (!this.profileId) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile publish: <profile-id> is required',
        hint: 'Run `ai-primitives-hub profile publish <id> --hub <hub-id>`'
      }));
    }

    if (!this.hubId) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile publish: --hub <id> is required',
        hint: 'Run `ai-primitives-hub hub list` to see available hubs.'
      }));
    }

    const profilePath = this.profileFile ?? path.join(ctx.cwd(), `${this.profileId}.profile.yml`);
    if (!(await ctx.fs.exists(profilePath))) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'FS.NOT_FOUND',
        message: `Profile file not found: ${profilePath}`,
        hint: 'Export a profile first or provide --file <path>.'
      }));
    }

    const profileYaml = await ctx.fs.readFile(profilePath);
    const parsed = yaml.load(profileYaml) as ProfileYamlFile | undefined;
    if (!parsed || typeof parsed !== 'object') {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'PROFILE.INVALID_YAML',
        message: 'Profile YAML is invalid or empty'
      }));
    }

    const hubs = await mgr.listHubs();
    if (!hubs.some((h) => h.id === this.hubId)) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'HUB.NOT_FOUND',
        message: `Hub "${this.hubId}" not found`,
        hint: 'Run `ai-primitives-hub hub list` to see available hubs.'
      }));
    }

    const now = new Date().toISOString();
    await mgr.addProfile(this.hubId, {
      id: parsed.id ?? this.profileId,
      name: parsed.name ?? this.profileId,
      description: parsed.description ?? '',
      icon: parsed.icon ?? '',
      active: false,
      createdAt: now,
      updatedAt: now,
      bundles: parsed.bundles ?? []
    });

    formatOutput({
      ctx, command: 'profile.publish', output: fmt, status: 'ok',
      data: { profileId: this.profileId, hubId: this.hubId },
      textRenderer: (d) => `Published profile "${d.profileId}" to hub "${d.hubId}".\n`
    });
    return 0;
  }
}
