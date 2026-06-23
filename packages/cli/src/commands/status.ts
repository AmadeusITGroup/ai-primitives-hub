/**
 * `prompt-registry status` — show current configuration state at a glance.
 *
 * Reads targets, active hub, primitive index, and lockfile to produce
 * a concise dashboard without any network calls. Useful for verifying
 * that a project is correctly configured before activating profiles.
 */
import {
  resolveUserConfigPaths,
} from '@prompt-registry/app';
import {
  ActiveHubStore,
  defaultIndexFile,
  HubStore,
  readLockfile,
  tryLoadIndex,
} from '@prompt-registry/infra';
import {
  Command,
  type CommandDefinition,
  type Context,
  defineCommand,
  findProjectLockfile,
  formatOutput,
  loadTargets,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
  resolveProjectConfigPath,
} from '../framework';

/** Bundle detail shown in verbose mode. */
export interface StatusBundle {
  bundleId: string;
  bundleVersion: string;
  target: string;
  installedAt: string;
}

/** Status data shape returned to callers. */
export interface StatusData {
  configPath: string | null;
  userTargetsPath: string | null;
  targets: { name: string; type: string; scope: string }[];
  activeHubId: string | null;
  hubs: string[];
  index: { primitives: number; path: string } | null;
  lockfile: { entries: number; path: string; bundles?: StatusBundle[] } | null;
}

/**
 * Build the `status` command using defineCommand (for test compatibility).
 * @param opts CLI options.
 * @param opts.output Output format.
 * @param opts.verbose Whether to include per-bundle details.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createStatusCommand = (
  opts: { output?: OutputFormat; verbose?: boolean } = {}
): CommandDefinition =>
  defineCommand({
    path: ['status'],
    description: 'Show current configuration state: targets, active hub, index, and lockfile.',
    category: 'Configure & Debug',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      return runStatus(ctx, opts.output ?? 'text', opts.verbose ?? false);
    }
  });

/**
 * Status command class.
 */
export class StatusCommand extends Command {
  public static readonly paths = [['status']];

  public static readonly usage = Command.Usage({
    description: 'Show current configuration state: targets, active hub, index, and lockfile.',
    category: 'Configure & Debug',
    details: `
      Usage: prompt-registry status [options]

      Reads local config files (no network calls) and prints a summary of:
        - Project config file location (prompt-registry.yml)
        - Configured targets
        - Active hub and available hubs
        - Primitive index size
        - Installed bundles from lockfile

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)
        --verbose               Include per-bundle details from lockfile

      Examples:
        prompt-registry status
        prompt-registry status -o json
        prompt-registry status --verbose
    `
  });

  public output = Option.String('-o,--output');
  public verbose = Option.Boolean('--verbose', false);
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    return runStatus(ctx, (this.output ?? 'text') as OutputFormat, this.verbose);
  }
}

/**
 * Core status logic shared by both command variants.
 * @param ctx CLI context.
 * @param fmt Output format.
 * @param verbose Whether to include per-bundle details in the lockfile section.
 * @returns Exit code.
 */
async function runStatus(ctx: Context, fmt: OutputFormat, verbose: boolean): Promise<number> {
  try {
    const userPaths = resolveUserConfigPaths(ctx.env);

    const [targets, hubIds, activeHubId, configPath, userTargetsExists] = await Promise.all([
      loadTargets(ctx),
      readHubIds(userPaths.hubs, ctx),
      readActiveHubId(userPaths.activeHub, ctx),
      resolveProjectConfigPath({ cwd: ctx.cwd(), env: ctx.env, fs: ctx.fs }),
      ctx.fs.exists(userPaths.userTargets)
    ]);

    const indexPath = defaultIndexFile(ctx.env);
    const indexStats = tryLoadIndex(indexPath);

    const lockPath = await findProjectLockfile(ctx);
    const lockfile = lockPath === null ? null : await readLockfile(lockPath, ctx.fs);

    let lockfileData: StatusData['lockfile'] = null;
    if (lockfile !== null && lockPath !== null) {
      lockfileData = { entries: lockfile.entries.length, path: lockPath };
      if (verbose) {
        lockfileData.bundles = lockfile.entries.map((e) => ({
          bundleId: e.bundleId,
          bundleVersion: e.bundleVersion,
          target: e.target,
          installedAt: e.installedAt
        }));
      }
    }

    const data: StatusData = {
      configPath: configPath ?? null,
      userTargetsPath: userTargetsExists ? userPaths.userTargets : null,
      targets: targets.map((t) => ({ name: t.name, type: t.type, scope: t.scope ?? 'user' })),
      activeHubId,
      hubs: hubIds,
      index: indexStats === null
        ? null
        : { primitives: indexStats.search({}).total, path: indexPath },
      lockfile: lockfileData
    };

    formatOutput({
      ctx,
      command: 'status',
      output: fmt,
      status: 'ok',
      data,
      textRenderer: renderStatusText
    });
    return 0;
  } catch (err) {
    if (err instanceof RegistryError) {
      renderError(err, ctx);
      return 1;
    }
    renderError(new RegistryError({
      code: 'INTERNAL.UNEXPECTED',
      message: err instanceof Error ? err.message : String(err),
      cause: err instanceof Error ? err : undefined
    }), ctx);
    return 1;
  }
}

/**
 * Read list of hub IDs from the hubs directory.
 * @param hubsDir Path to hubs directory.
 * @param ctx CLI context.
 * @returns Array of hub IDs.
 */
async function readHubIds(hubsDir: string, ctx: Context): Promise<string[]> {
  try {
    const store = new HubStore(hubsDir, ctx.fs);
    return await store.list();
  } catch {
    return [];
  }
}

/**
 * Read the active hub ID pointer.
 * @param activeHubPath Path to active-hub.json.
 * @param ctx CLI context.
 * @returns Active hub ID or null.
 */
async function readActiveHubId(activeHubPath: string, ctx: Context): Promise<string | null> {
  try {
    const store = new ActiveHubStore(activeHubPath, ctx.fs);
    return await store.get();
  } catch {
    return null;
  }
}

function renderConfigLine(configPath: string | null, userTargetsPath: string | null): string {
  if (configPath !== null) {
    return `config      ${configPath}\n`;
  }
  if (userTargetsPath !== null) {
    return `config      ${userTargetsPath} (user)\n`;
  }
  return 'config      (none — run `prompt-registry init`)\n';
}

function renderTargetsLine(targets: StatusData['targets']): string {
  if (targets.length === 0) {
    return 'targets     (none — run `prompt-registry target add`)\n';
  }
  const targetStrings = targets.map((t) => t.name + ' [' + t.type + ']');
  return 'targets     ' + targetStrings.join(', ') + '\n';
}

function renderHubLines(activeHubId: string | null, hubs: string[]): string[] {
  if (activeHubId !== null) {
    return [`active hub  ${activeHubId}\n`];
  }
  if (hubs.length > 0) {
    return [`active hub  (none — run \`prompt-registry hub use <id>\`)\n`, `hubs        ${hubs.join(', ')}\n`];
  }
  return ['active hub  (none — run `prompt-registry hub add <ref>`)\n'];
}

function renderIndexLine(index: StatusData['index']): string {
  if (index === null) {
    return 'index       (none — run `prompt-registry index build`)\n';
  }
  return `index       ${index.primitives} primitives  [${index.path}]\n`;
}

function renderLockfileLines(lockfile: StatusData['lockfile']): string[] {
  if (lockfile === null) {
    return ['lockfile    (none)\n'];
  }
  const lines: string[] = [`lockfile    ${lockfile.entries} bundle${lockfile.entries === 1 ? '' : 's'} installed  [${lockfile.path}]\n`];
  if (lockfile.bundles !== undefined && lockfile.bundles.length > 0) {
    for (const b of lockfile.bundles) {
      lines.push(`              ${b.bundleId}@${b.bundleVersion}  target=${b.target}  installed=${b.installedAt}\n`);
    }
  }
  return lines;
}

/**
 * Render status as human-readable text.
 * @param d Status data.
 * @returns Rendered text.
 */
function renderStatusText(d: StatusData): string {
  return [
    'prompt-registry status\n',
    '─'.repeat(40) + '\n',
    renderConfigLine(d.configPath, d.userTargetsPath),
    renderTargetsLine(d.targets),
    ...renderHubLines(d.activeHubId, d.hubs),
    renderIndexLine(d.index),
    ...renderLockfileLines(d.lockfile)
  ].join('');
}
