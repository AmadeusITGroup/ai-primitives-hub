/**
 * `profile` commands.
 *
 * Subcommands:
 *   profile list [--hub <id>]
 *   profile show <profileId>
 *   profile activate <profileId> [--hub <id>] [--target <name>...]
 *   profile deactivate
 *   profile current
 *
 * Converted to clipanion class-based commands with property initializers.
 */
import * as path from 'node:path';
import {
  type ActivationOutcome,
  HubManager,
  ProfileActivator,
  resolveUserConfigPaths,
} from '@prompt-registry/app';
import {
  resolveLayout,
} from '@prompt-registry/app';
import {
  type HttpClient,
  type ProfileBundle,
  type Target,
  type TokenProvider,
} from '@prompt-registry/core';
import {
  generateSourceId,
} from '@prompt-registry/core';
import {
  HubStore,
  ProfileActivationStore,
  readLockfile,
  readTargets,
  upsertEntry,
  upsertSource,
  upsertUseProfile,
  writeLockfile,
} from '@prompt-registry/infra';
import {
  Command,
  createHttpClientAndTokens,
  createHubManager,
  failWith,
  Option,
  requireActiveHubOrFail,
} from '../framework';
import {
  type Context,
  formatOutput,
  type OutputFormat,
  RegistryError,
} from '../framework';

/**
 * Build HubManager and related instances.
 * @param ctx CLI context.
 * @param http HTTP client (optional test seam).
 * @param tokens Token provider (optional test seam).
 * @returns HubManager, activations store, HTTP client, and token provider.
 */
const buildHubMgr = (ctx: Context, http?: HttpClient, tokens?: TokenProvider): {
  mgr: HubManager;
  activations: ProfileActivationStore;
  http: HttpClient;
  tokens: TokenProvider;
} => {
  const paths = resolveUserConfigPaths(ctx.env);
  const [httpClient, tokenProvider] = createHttpClientAndTokens(http, ctx, tokens);
  const mgr = createHubManager({ ctx, http: httpClient, tokens: tokenProvider });
  return {
    mgr,
    activations: new ProfileActivationStore(paths.profileActivations, ctx.fs),
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
      hint: 'Run `prompt-registry hub add` to import a hub, then `hub use <id>` to activate it.'
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
      Usage: prompt-registry profile list [options]

      Options:
        --hub <hub-id>           Hub ID to list profiles from
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry profile list
        prompt-registry profile list --hub my-hub
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

    // Re-load the hub config to pull profiles[].
    const hubs = await mgr.listHubs();
    if (!hubs.some((h) => h.id === hubId)) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'HUB.NOT_FOUND',
        message: `profile list: hub "${hubId}" not found`,
        hint: 'Run `prompt-registry hub list` to see available hubs.'
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
        ? `No profiles in hub "${d.hubId}". Run \`prompt-registry profile create <id> --name <name>\` to add one.\n`
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
      Usage: prompt-registry profile show <profile-id> [options]

      Options:
        --hub <hub-id>           Hub ID containing the profile
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry profile show my-profile
        prompt-registry profile show my-profile --hub my-hub
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
        hint: 'Run `prompt-registry profile list` to see available profiles.'
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
 * profile activate - activate a profile
 */
export class ProfileActivateCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'activate']];
  public static readonly usage = Command.Usage({
    description: 'Activate a profile on configured targets.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry profile activate <profile-id> [options]

      Options:
        --hub <hub-id>           Hub ID containing the profile
        --target <name>          Comma-separated target names to limit activation
        --dry-run                Preview changes without applying
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry profile activate default
        prompt-registry profile activate default --target vscode
        prompt-registry profile activate default --dry-run
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
        hint: 'Run `prompt-registry profile list` to see available profile IDs.'
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
        hint: 'Run `prompt-registry profile list` to see available profiles.'
      }));
    }

    let targets = await readTargets({ cwd: ctx.cwd(), fs: ctx.fs });
    if (this.targets) {
      const wanted = new Set(this.targets.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0));
      targets = targets.filter((t) => wanted.has(t.name));
    }
    if (targets.length === 0) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile activate: no targets configured',
        hint: 'Run `prompt-registry target add <name> --type <type>` to configure a target.'
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

    const lockPath = path.join(ctx.cwd(), 'prompt-registry.lock.json');
    const prev = await built.activations.getActive();
    if (prev !== null) {
      await cleanupDeactivatedLockfile(ctx, lockPath);
      await built.activations.remove(prev.hubId, prev.profileId);
    }

    const activator = new ProfileActivator({
      fs: ctx.fs, env: ctx.env, http: built.http, tokens: built.tokens
    });
    const out = await activator.activate({
      hubId,
      profile,
      sources: Object.fromEntries((await built.mgr.listSources(hubId)).map((s) => [s.id, s])),
      targets
    });
    await built.activations.save(out.state);
    const sourcesMap = Object.fromEntries((await built.mgr.listSources(hubId)).map((s) => [s.id, s]));
    await updateActivationLockfile(ctx, lockPath, hubId, profile, sourcesMap, out);

    formatOutput({
      ctx, command: 'profile.activate', output: fmt, status: 'ok',
      data: { hubId, profileId: profile.id, state: out.state, written: out.written, lockfile: lockPath },
      textRenderer: (d) => `Activated profile "${d.profileId}" from hub "${d.hubId}":\n`
        + `  Bundles: ${[...new Set(d.state.syncedBundles)].join(', ')}\n`
        + `  Targets: ${d.state.syncedTargets.join(', ')}\n`
    });
    return 0;
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
      Usage: prompt-registry profile deactivate [options]

      Options:
        --dry-run                Preview changes without applying
        -o, --output <format>     Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry profile deactivate
        prompt-registry profile deactivate --dry-run
    `
  });

  public dryRun = Option.Boolean('--dry-run', false);

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);
    const cur = await built.activations.getActive();
    if (cur === null) {
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
          deactivated: { hubId: cur.hubId, profileId: cur.profileId }
        },
        textRenderer: (d) => `[dry-run] Would deactivate profile "${d.deactivated?.profileId}" from hub "${d.deactivated?.hubId}":\n`
          + 'Run without --dry-run to apply.\n'
      });
      return 0;
    }

    await built.activations.remove(cur.hubId, cur.profileId);

    const lockPath = path.join(ctx.cwd(), 'prompt-registry.lock.json');
    await cleanupDeactivatedLockfile(ctx, lockPath);
    formatOutput({
      ctx, command: 'profile.deactivate', output: fmt, status: 'ok',
      data: { deactivated: { hubId: cur.hubId, profileId: cur.profileId } },
      textRenderer: (d) => `Deactivated profile "${d.deactivated?.profileId}".\n`
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
      Usage: prompt-registry profile current

      Examples:
        $ prompt-registry profile current
    `
  });

  public async execute() {
    const { ctx, http, tokens } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const built = buildHubMgr(ctx, http, tokens);
    const activations = built.activations;

    const active = await activations.getActive();
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
 * profile create - create a new local profile
 */
export class ProfileCreateCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'create']];

  public static readonly usage = Command.Usage({
    description: 'Create a new local profile in the default-local hub.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry profile create <profile-id> --name <name> [options]

      Examples:
        prompt-registry profile create my-profile --name "My Profile" --description "A custom profile"
        prompt-registry profile create dev-tools --name "Dev Tools" --bundles bundle1,bundle2

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

    // Convert bundle IDs to ProfileBundle format
    const profileBundles: ProfileBundle[] = bundleList.map((bundleId) => ({
      id: bundleId,
      version: 'latest',
      source: hubId,
      required: false
    }));

    const profile = await mgr.addProfile(hubId, {
      id: this.profileId,
      name: this.name,
      description: this.description,
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

const applyBundleRemovals = (bundles: ProfileBundle[], spec: string): ProfileBundle[] => {
  const result = [...bundles];
  for (const bundleId of spec.split(',').map((b) => b.trim())) {
    const idx = result.findIndex((b) => b.id === bundleId);
    if (idx !== -1) {
      result.splice(idx, 1);
    }
  }
  return result;
};

const applyBundleAdditions = (bundles: ProfileBundle[], spec: string, hubId: string): ProfileBundle[] => {
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
      Usage: prompt-registry profile edit <profile-id> [options]

      Examples:
        prompt-registry profile edit my-profile --description "Updated description"
        prompt-registry profile edit my-profile --add-bundles bundle1,bundle2
        prompt-registry profile edit my-profile --remove-bundles bundle1,bundle2
        prompt-registry profile edit my-profile --name "New Name"

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

    // Load existing profile
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

    // Build updated profile
    let updatedBundles = [...existingProfile.bundles];
    if (this.removeBundles) {
      updatedBundles = applyBundleRemovals(updatedBundles, this.removeBundles);
    }
    if (this.addBundles) {
      updatedBundles = applyBundleAdditions(updatedBundles, this.addBundles, hubId);
    }

    const updatedProfile = await mgr.addProfile(hubId, {
      id: existingProfile.id,
      name: this.name ?? existingProfile.name,
      description: this.description ?? existingProfile.description,
      bundles: updatedBundles
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
 * Update the lockfile after a successful profile activation.
 * @param ctx CLI context.
 * @param lockPath Path to the lockfile.
 * @param hubId Hub identifier.
 * @param profile Profile being activated.
 * @param profile.id Profile identifier.
 * @param profile.bundles Profile bundle references.
 * @param sourcesMap Map of source ID to source config.
 * @param out Activation outcome with written files and state.
 */
async function updateActivationLockfile(
  ctx: Context,
  lockPath: string,
  hubId: string,
  profile: { id: string; bundles: { source: string; id: string; version: string }[] },
  sourcesMap: Record<string, { type: string; url: string }>,
  out: ActivationOutcome
): Promise<void> {
  const existing = await readLockfile(lockPath, ctx.fs);
  let nextLock = upsertUseProfile(existing, { hubId, profileId: profile.id });
  for (const t of out.state.syncedTargets) {
    for (const bundleRef of profile.bundles) {
      const src = sourcesMap[bundleRef.source];
      if (!src) {
        continue;
      }
      const sourceId = generateSourceId(src.type, src.url);
      const writtenFiles = out.written[t] || [];
      const fileChecksums: Record<string, string> = {};
      const crypto = await import('node:crypto');
      const relativeFiles: string[] = [];
      for (const f of writtenFiles) {
        const bytes = await ctx.fs.readFile(f);
        fileChecksums[f] = crypto.createHash('sha256').update(bytes).digest('hex');
        // Store paths relative to ctx.cwd() for lockfile portability
        relativeFiles.push(path.relative(ctx.cwd(), f));
      }
      // Use profile reference ID for lockfile to match display
      nextLock = upsertEntry(nextLock, {
        target: t,
        sourceId,
        bundleId: bundleRef.id,
        bundleVersion: bundleRef.version === 'latest' ? out.state.syncedBundleVersions[bundleRef.id] : bundleRef.version,
        installedAt: new Date().toISOString(),
        files: relativeFiles,
        fileChecksums
      });
      nextLock = upsertSource(nextLock, sourceId, { type: src.type, url: src.url });
    }
  }
  await writeLockfile(lockPath, nextLock, ctx.fs);
}

/**
 * profile publish - inject a profile into a hub and sync (F-08)
 */
export class ProfilePublishCommand extends BaseProfileCommand {
  public static readonly paths = [['profile', 'publish']];

  public static readonly usage = Command.Usage({
    description: 'Publish a profile to a hub by injecting it into hub-config.yml and syncing.',
    category: 'Hub & Discovery',
    details: `
      Usage: prompt-registry profile publish <profile-id> --hub <hub-id> [--file <path>]

      Examples:
        prompt-registry profile publish my-profile --hub default-local
        prompt-registry profile publish my-profile --hub default-local --file ./my-profile.yml

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
        hint: 'Run `prompt-registry profile publish <id> --hub <hub-id>`'
      }));
    }

    if (!this.hubId) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'profile publish: --hub <id> is required',
        hint: 'Run `prompt-registry hub list` to see available hubs.'
      }));
    }

    // Load profile YAML
    const profilePath = this.profileFile ?? path.join(ctx.cwd(), `${this.profileId}.profile.yml`);
    if (!(await ctx.fs.exists(profilePath))) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'FS.NOT_FOUND',
        message: `Profile file not found: ${profilePath}`,
        hint: 'Export a profile first with `index export --shortlist <id> --profile-id <id>` or provide --file <path>.'
      }));
    }

    const profileYaml = await ctx.fs.readFile(profilePath);
    const load = await import('js-yaml');
    const profile = load.load(profileYaml) as { id: string; name?: string; bundles?: string[] };
    if (!profile || typeof profile !== 'object') {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'PROFILE.INVALID_YAML',
        message: 'Profile YAML is invalid or empty'
      }));
    }

    // Load hub config
    const hubs = await mgr.listHubs();
    const hub = hubs.find((h) => h.id === this.hubId);
    if (!hub) {
      return failWith(ctx, fmt, 'profile', new RegistryError({
        code: 'HUB.NOT_FOUND',
        message: `Hub "${this.hubId}" not found`,
        hint: 'Run `prompt-registry hub list` to see available hubs.'
      }));
    }

    // Resolve hub config path via hub store
    const paths = resolveUserConfigPaths(ctx.env);
    const hubStore = new HubStore(paths.hubs, ctx.fs);
    const hubConfigPath = hubStore.configPath(this.hubId);
    const hubConfigYaml = await ctx.fs.readFile(hubConfigPath);
    const hubConfig = load.load(hubConfigYaml) as { profiles?: Record<string, unknown> };
    hubConfig.profiles ??= {};
    hubConfig.profiles[this.profileId] = profile;
    await ctx.fs.writeFile(hubConfigPath, load.dump(hubConfig));

    // Sync hub
    await mgr.syncHub(this.hubId);

    formatOutput({
      ctx, command: 'profile.publish', output: fmt, status: 'ok',
      data: { profileId: this.profileId, hubId: this.hubId },
      textRenderer: (d) => `Published profile "${d.profileId}" to hub "${d.hubId}" and synced.\n`
    });
    return 0;
  }
}

/**
 * Collect all parent directories of given paths, sorted by depth (deepest first).
 * @param paths File paths.
 * @param root Root directory (stop here).
 * @returns Set of parent directories sorted by depth.
 */
function collectParentDirs(paths: string[], root: string): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    let current = path.dirname(p);
    while (current !== root && current !== path.dirname(current)) {
      dirs.add(current);
      current = path.dirname(current);
    }
  }
  // Sort by depth (deepest first) for bottom-up removal
  return Array.from(dirs).toSorted((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

/**
 * Remove all files from the filesystem.
 * @param ctx CLI context.
 * @param allFiles List of file paths to remove.
 */
async function removeAllFiles(ctx: Context, allFiles: string[]): Promise<void> {
  for (const f of allFiles) {
    const filePath = path.join(ctx.cwd(), f);
    try {
      await ctx.fs.remove(filePath);
    } catch {
      // Best-effort removal
    }
  }
}

/**
 * Remove empty parent directories bottom-up (deepest first).
 * @param ctx CLI context.
 * @param parentDirs List of parent directories to check and remove if empty.
 */
async function removeEmptyParentDirs(ctx: Context, parentDirs: string[]): Promise<void> {
  for (const d of parentDirs) {
    try {
      const dirPath = path.join(ctx.cwd(), d);
      const entries = await ctx.fs.readDir(dirPath);
      if (entries.length === 0) {
        await ctx.fs.remove(dirPath);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Clean up kind route directories for a specific target.
 * @param ctx CLI context.
 * @param target Target configuration.
 * @param layout Target layout.
 * @param layout.baseDir Base directory path.
 * @param layout.kindRoutes Kind route directory mapping.
 * @returns Promise that resolves when cleanup is complete.
 */
async function cleanupKindRouteDirectories(ctx: Context, target: Target, layout: { baseDir: string; kindRoutes: Record<string, string> }): Promise<void> {
  const baseDir: string = layout.baseDir
    .replaceAll('${workspaceRoot}', ctx.cwd())
    .replaceAll('${HOME}', ctx.env.HOME ?? '')
    .replace(/^~/, ctx.env.HOME ?? '');

  for (const outPrefix of Object.values(layout.kindRoutes)) {
    const kindDir = path.join(baseDir, outPrefix);
    try {
      if (await ctx.fs.exists(kindDir)) {
        await ctx.fs.remove(kindDir, { recursive: true });
      }
    } catch {
      // Best-effort cleanup
    }
  }

  try {
    if (await ctx.fs.exists(baseDir)) {
      const entries = await ctx.fs.readDir(baseDir);
      if (entries.length === 0) {
        await ctx.fs.remove(baseDir);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Perform adaptive cleanup based on target layouts.
 * @param ctx CLI context.
 * @param existing Existing lockfile entries.
 * @param existing.entries Array of lockfile entries.
 * @returns Promise that resolves when cleanup is complete.
 */
async function adaptiveCleanup(ctx: Context, existing: { entries: { target: string }[] }): Promise<void> {
  try {
    const targets = await readTargets({ cwd: ctx.cwd(), fs: ctx.fs });
    // If entries are empty, clean up all targets; otherwise clean up only targets from entries
    const targetsToClean = existing.entries.length > 0
      ? existing.entries.map((e) => targets.find((t) => t.name === e.target)).filter((t): t is any => t !== undefined)
      : targets;
    for (const target of targetsToClean) {
      const layout = resolveLayout(target);
      await cleanupKindRouteDirectories(ctx, target, layout);
    }
    // Also clean up .github directory if it's empty after removing kind routes
    const githubDir = path.join(ctx.cwd(), '.github');
    if (await ctx.fs.exists(githubDir)) {
      const entries = await ctx.fs.readDir(githubDir);
      if (entries.length === 0) {
        await ctx.fs.remove(githubDir);
      }
    }
  } catch {
    // Best-effort: if layout resolution fails, skip adaptive cleanup
  }
}

/**
 * Remove all files listed in the lockfile and wipe entries on deactivation.
 * Best-effort: errors are ignored.
 * @param ctx CLI context.
 * @param lockPath Path to the lockfile.
 * @returns Promise that resolves when cleanup is complete.
 */
async function cleanupDeactivatedLockfile(ctx: Context, lockPath: string): Promise<void> {
  if (!await ctx.fs.exists(lockPath)) {
    return;
  }
  const existing = await readLockfile(lockPath, ctx.fs);
  const allFiles: string[] = [];
  for (const entry of existing.entries) {
    allFiles.push(...entry.files);
  }

  await removeAllFiles(ctx, allFiles);
  const parentDirs = collectParentDirs(allFiles, ctx.cwd());
  await removeEmptyParentDirs(ctx, parentDirs);
  // Run adaptive cleanup before clearing entries to ensure kind route directories are removed
  await adaptiveCleanup(ctx, existing);

  await writeLockfile(lockPath, { ...existing, entries: [], sources: {}, useProfile: undefined }, ctx.fs);
}
