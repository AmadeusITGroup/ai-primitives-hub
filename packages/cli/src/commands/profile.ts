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
 * Activation writes bundle files to every configured target (optionally
 * filtered via `--target`), reusing the same fetch/write primitives as
 * `install.ts` (`fetchFilesForSource`, `createWriterFactory`) and the same
 * removal primitives as `uninstall.ts` (`runUserScopeUninstall`,
 * `UninstallPipeline`) for deactivation. Unlike the reference branch, there
 * is no per-entry `target` field or `useProfile` field on the lockfile
 * (see `stores/json-lockfile-store.ts`'s module doc) — activation state
 * (which hub/profile is active, and which bundles it synced) is tracked
 * exclusively via `ProfileActivationStore`, and each target's own lockfile
 * (resolved via `lockfilePathForTarget`) is updated per bundle exactly as
 * a direct `install` would.
 */
import * as path from 'node:path';
import {
  checksumFiles,
  emptyLockfile,
  type HubManager,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileSourceEntry,
  readLockfile,
  resolveUserConfigPaths,
  type TargetWriter,
  UninstallPipeline,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from '@ai-primitives-hub/app';
import {
  type HttpClient,
  type HubProfile,
  type HubProfileBundle,
  type ProfileActivationState,
  type RegistrySource,
  type Target,
  type TokenProvider,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  ProfileActivationStore,
} from '@ai-primitives-hub/infra';
import * as yaml from 'js-yaml';
import {
  Command,
  createHttpClientAndTokens,
  createHubManager,
  failWith,
  loadTargets,
  lockfilePathForTarget,
  Option,
  requireActiveHubOrFail,
} from '../framework';
import {
  type Context,
  formatOutput,
  type OutputFormat,
  RegistryError,
} from '../framework';
import {
  createWriterFactory,
  fetchFilesForSource,
} from './install';
import {
  createWriterFactory as createUninstallWriterFactory,
  runUserScopeUninstall,
} from './uninstall';

/**
 * Bundle of HubManager + activation store + HTTP/token deps, as
 * returned by {@link buildHubMgr} and consumed by
 * {@link runProfileActivation}.
 */
export interface BuiltHubMgr {
  mgr: HubManager;
  activations: ProfileActivationStore;
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
  | { ok: true; written: string[]; entry: LockfileBundleEntry; sourceEntry: LockfileSourceEntry }
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
 * @returns The written files and lockfile entries on success, or a failure reason.
 */
async function activateBundleForTarget(
  bundleRef: HubProfileBundle,
  sources: Record<string, RegistrySource>,
  target: Target,
  writer: TargetWriter,
  http: HttpClient,
  tokens: TokenProvider,
  ctx: Context
): Promise<ActivateBundleOutcome> {
  const src = sources[bundleRef.source];
  if (!src) {
    return { ok: false, reason: `source "${bundleRef.source}" not found in hub` };
  }
  const sourceEntry: LockfileSourceEntry = {
    type: src.type,
    url: src.url,
    ...(src.config?.branch ? { branch: src.config.branch } : {}),
    ...(src.config?.collectionsPath ? { collectionsPath: src.config.collectionsPath } : {})
  };
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
    const files = await fetchFilesForSource(sourceEntry, bundleRef.id, probeEntry, http, tokens, ctx, false);
    if (files === null) {
      return { ok: false, reason: 'failed to fetch bundle files' };
    }
    const manifest = validateManifest(files, {
      expectedId: bundleRef.id,
      expectedVersion: bundleRef.version === 'latest' ? undefined : bundleRef.version
    });
    const result = await writer.write(target, files);
    const entry: LockfileBundleEntry = {
      version: manifest.version,
      sourceId: src.id,
      sourceType: src.type,
      installedAt: new Date().toISOString(),
      files: checksumFiles(files)
    };
    if (target.scope === 'repository') {
      entry.commitMode = target.commitMode ?? 'commit';
    }
    return { ok: true, written: result.written, entry, sourceEntry };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove every bundle recorded in a profile activation state from every
 * given target — the inverse of the activate loop below. Mirrors
 * `uninstall.ts`'s `performBundleUninstall` scope routing (repository
 * scope via `UninstallPipeline`, everything else via
 * `runUserScopeUninstall`), looped over every synced bundle. Best-effort:
 * a bundle missing from a given target's lockfile is silently skipped
 * (it was never written there).
 * @param ctx CLI context.
 * @param state Activation state recording which bundles were synced.
 * @param targets Targets to remove the profile's bundles from.
 */
async function deactivateProfileBundles(ctx: Context, state: ProfileActivationState, targets: Target[]): Promise<void> {
  for (const target of targets) {
    if (target.scope === 'repository') {
      const pipeline = new UninstallPipeline({
        fs: ctx.fs,
        target,
        repositoryPath: target.rootPath ?? ctx.cwd(),
        writerFactory: createUninstallWriterFactory(ctx, {})
      });
      for (const bundleId of state.syncedBundles) {
        try {
          await pipeline.run(bundleId);
        } catch {
          // Best-effort cleanup.
        }
      }
    } else {
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
  }
}

/**
 * Result of {@link runProfileActivation}.
 */
export interface ProfileActivationResult {
  state: ProfileActivationState;
  written: Record<string, string[]>;
  failures: { bundleId: string; target: string; reason: string }[];
}

/**
 * Deactivate whatever profile(s) were previously active, then fetch and
 * write every bundle in `profile` to every target, updating each
 * target's lockfile and the shared `ProfileActivationStore`. Shared by
 * `ProfileActivateCommand` and `apply.ts` (`apply` is, in effect,
 * "re-activate whatever profile is currently active").
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
  // Enforce a single globally-active profile: deactivate whatever was
  // previously active (if anything) before installing the new one.
  const previouslyActive = await built.activations.listAll();
  for (const prev of previouslyActive) {
    await deactivateProfileBundles(ctx, prev, targets);
    await built.activations.delete(prev.hubId, prev.profileId);
    const prevActiveHub = await built.mgr.getActiveHub();
    if (prevActiveHub?.id === prev.hubId) {
      const prevProfile = prevActiveHub.config.profiles.find((p) => p.id === prev.profileId);
      if (prevProfile) {
        await built.mgr.addProfile(prev.hubId, { ...prevProfile, active: false, updatedAt: new Date().toISOString() });
      }
    }
  }

  const sources = Object.fromEntries((await built.mgr.listSources(hubId)).map((s) => [s.id, s]));
  const syncedBundles: string[] = [];
  const syncedBundleVersions: Record<string, string> = {};
  const failures: { bundleId: string; target: string; reason: string }[] = [];
  const writtenByTarget: Record<string, string[]> = {};

  for (const target of targets) {
    const writer = createWriterFactory(ctx, {})(target);
    const written: string[] = [];
    const lockPath = lockfilePathForTarget(ctx, target);
    let lock: Lockfile = await readLockfile(lockPath, ctx.fs) ?? emptyLockfile('ai-primitives-hub-cli');

    for (const bundleRef of profile.bundles) {
      const outcome = await activateBundleForTarget(bundleRef, sources, target, writer, built.http, built.tokens, ctx);
      if (!outcome.ok) {
        failures.push({ bundleId: bundleRef.id, target: target.name, reason: outcome.reason });
        continue;
      }
      written.push(...outcome.written);
      lock = upsertBundleEntry(lock, bundleRef.id, outcome.entry);
      lock = upsertSource(lock, outcome.entry.sourceId, outcome.sourceEntry);
      syncedBundleVersions[bundleRef.id] = outcome.entry.version;
      if (!syncedBundles.includes(bundleRef.id)) {
        syncedBundles.push(bundleRef.id);
      }
    }
    await writeLockfile(lockPath, lock, ctx.fs);
    writtenByTarget[target.name] = written;
  }

  const state: ProfileActivationState = {
    hubId,
    profileId: profile.id,
    activatedAt: new Date().toISOString(),
    syncedBundles,
    syncedBundleVersions
  };
  await built.activations.save(hubId, profile.id, state);
  await built.mgr.addProfile(hubId, { ...profile, active: true, updatedAt: new Date().toISOString() });

  return { state, written: writtenByTarget, failures };
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

    if (!this.profileId) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile activate: <profileId> required',
        hint: 'Run `ai-primitives-hub profile list` to see available profile IDs.'
      }));
    }

    let hubId: string;
    try {
      hubId = await resolveHubId(built.mgr, this.hubId);
    } catch (err) {
      if (err instanceof RegistryError) {
        return failWith(ctx, fmt, 'profile', err);
      }
      throw err;
    }

    const active = await requireActiveHubOrFail(built.mgr, hubId, 'profile.activate', ctx, fmt);
    if (typeof active === 'number') {
      return active;
    }
    const profile = active.config.profiles.find((p) => p.id === this.profileId);
    if (profile === undefined) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'BUNDLE.NOT_FOUND',
        message: `profile activate: "${this.profileId}" not in hub "${hubId}"`,
        hint: 'Run `ai-primitives-hub profile list` to see available profiles.'
      }));
    }

    let targets = await loadTargets(ctx);
    if (this.targets) {
      const wanted = new Set(this.targets.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
      targets = targets.filter((t) => wanted.has(t.name));
    }
    if (targets.length === 0) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile activate: no targets configured',
        hint: 'Run `ai-primitives-hub target add <name> --type <type>` to configure a target.'
      }));
    }

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

    const { state, written, failures } = await runProfileActivation(ctx, built, hubId, profile, targets);

    const status = failures.length === 0 ? 'ok' : 'warning';
    formatOutput({
      ctx, command: 'profile.activate', output: fmt, status,
      data: { hubId, profileId: profile.id, state, written, failures },
      warnings: failures.length > 0 ? failures.map((f) => `${f.bundleId} (${f.target}): ${f.reason}`) : undefined,
      textRenderer: (d) => `Activated profile "${d.profileId}" from hub "${d.hubId}":\n`
        + `  Bundles: ${[...new Set(d.state.syncedBundles)].join(', ')}\n`
        + `  Targets: ${Object.keys(d.written).join(', ')}\n`
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
    await deactivateProfileBundles(ctx, cur, targets);
    await built.activations.delete(cur.hubId, cur.profileId);

    const activeHub = await built.mgr.getActiveHub();
    if (activeHub?.id === cur.hubId) {
      const p = activeHub.config.profiles.find((pp) => pp.id === cur.profileId);
      if (p) {
        await built.mgr.addProfile(cur.hubId, { ...p, active: false, updatedAt: new Date().toISOString() });
      }
    }

    formatOutput({
      ctx, command: 'profile.deactivate', output: fmt, status: 'ok',
      data: { deactivated: { hubId: cur.hubId, profileId: cur.profileId } },
      textRenderer: (d) => `Deactivated profile "${d.deactivated?.profileId}".\n`
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
