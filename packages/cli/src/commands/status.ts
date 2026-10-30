/**
 * `ai-primitives-hub status` — show current configuration state at a glance.
 *
 * Reads targets, active hub, primitive index, and the install record to produce
 * a concise dashboard without any network calls. Useful for verifying
 * that a project is correctly configured before activating profiles.
 *
 * The record is selected with no level given (W4, BR6.2): the repository
 * record when one (or an old `prompt-registry.*` file) is at the git root,
 * else the user lockfile. JSON carries `level`, `records` and one
 * `entries` row per (bundle, tool) (BR9.2); bundles only in an old file are
 * listed under tool `unknown` with that file as their record (BR10.1).
 * @module commands/status
 */
import {
  readLockfile,
  resolveUserConfigPaths,
  type StatusRow,
} from '@ai-primitives-hub/app';
import type {
  RecordLevel,
} from '@ai-primitives-hub/core';
import {
  ActiveHubStore,
  defaultIndexFile,
  HubStore,
  tryLoadIndex,
} from '@ai-primitives-hub/infra';
import {
  Command,
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  loadTargets,
  Option,
  type OutputFormat,
  prepareRecordSelection,
  recordOutputFields,
  RegistryError,
  renderError,
  renderRecordLine,
  resolveProjectConfigPath,
} from '../framework';

/** Status data shape returned to callers. */
export interface StatusData {
  configPath: string | null;
  userTargetsPath: string | null;
  targets: { name: string; type: string; scope: string }[];
  activeHubId: string | null;
  hubs: string[];
  index: { primitives: number; path: string } | null;
  /** Level of the selected record (BR6.2). */
  level: RecordLevel;
  /** Record files read: the selected new files, plus the old-store file when it exists. */
  records: string[];
  /**
   * One row per (bundle, tool), sorted by bundle then tool (BR9.2). Bundles
   * only in an old `prompt-registry.*` / user lockfile are listed under tool
   * `unknown` with that file as their `record` (BR10.1).
   */
  entries: StatusRow[];
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
      Usage: ai-primitives-hub status [options]

      Reads local config files (no network calls) and prints a summary of:
        - Project config file location (ai-primitives-hub.yml)
        - Configured targets
        - Active hub and available hubs
        - Primitive index size
        - Installed bundles from lockfile

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)
        --verbose               Include per-bundle details from lockfile

      Examples:
        ai-primitives-hub status
        ai-primitives-hub status -o json
        ai-primitives-hub status --verbose
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
 * @param verbose Whether text output shows each entry's record file.
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

    const record = await readRecordStatus(ctx);

    const data: StatusData = {
      configPath: configPath ?? null,
      userTargetsPath: userTargetsExists ? userPaths.userTargets : null,
      targets: targets.map((t) => ({ name: t.name, type: t.type, scope: t.scope ?? 'user' })),
      activeHubId,
      hubs: hubIds,
      index: indexStats === null
        ? null
        : { primitives: indexStats.search({}).total, path: indexPath },
      ...record
    };

    formatOutput({
      ctx,
      command: 'status',
      output: fmt,
      status: 'ok',
      data,
      textRenderer: (d) => renderStatusText(d, verbose)
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
 * Read a record level, files and rows for `status` (W8; BR6.2, BR9.2,
 * BR10.1): select with no level given, list the new record's rows, then add
 * bundles found only in the old-store file, under tool `unknown`, marked
 * with that file's path.
 * @param ctx CLI context.
 * @returns The `level`, `records` and `entries` fields.
 * @throws {RegistryError} A `RECORD.*` error naming the file.
 */
async function readRecordStatus(ctx: Context): Promise<Pick<StatusData, 'level' | 'records' | 'entries'>> {
  const { selection, service, fs } = await prepareRecordSelection(ctx, { command: 'status' });
  const entries = await service.listEntries(selection.locations);
  const records: string[] = [];
  for (const location of selection.locations) {
    if (await fs.exists(location.path)) {
      records.push(location.path);
    }
  }
  const old = selection.oldLockfile === undefined ? null : await readLockfile(selection.oldLockfile, ctx.fs);
  if (old !== null && selection.oldLockfile !== undefined) {
    const recorded = new Set(entries.map((row) => row.bundleId));
    for (const [bundleId, entry] of Object.entries(old.bundles)) {
      if (!recorded.has(bundleId)) {
        entries.push({ bundleId, tool: 'unknown', level: selection.level, version: entry.version, record: selection.oldLockfile, needsReinstall: false });
      }
    }
    records.push(selection.oldLockfile);
  }
  entries.sort((left, right) => compare(left.bundleId, right.bundleId) || compare(left.tool, right.tool));
  return { level: selection.level, records: records.length > 0 ? records : (await recordOutputFields(selection, fs)).records, entries };
}

const compare = (left: string, right: string): number => (left < right ? -1 : (left > right ? 1 : 0));

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
  return 'config      (none — run `ai-primitives-hub init`)\n';
}

function renderTargetsLine(targets: StatusData['targets']): string {
  if (targets.length === 0) {
    return 'targets     (none — run `ai-primitives-hub target add`)\n';
  }
  const targetStrings = targets.map((t) => t.name + ' [' + t.type + ']');
  return 'targets     ' + targetStrings.join(', ') + '\n';
}

function renderHubLines(activeHubId: string | null, hubs: string[]): string[] {
  if (activeHubId !== null) {
    return [`active hub  ${activeHubId}\n`];
  }
  if (hubs.length > 0) {
    return [`active hub  (none — run \`ai-primitives-hub hub use <id>\`)\n`, `hubs        ${hubs.join(', ')}\n`];
  }
  return ['active hub  (none — run `ai-primitives-hub hub add <ref>`)\n'];
}

function renderIndexLine(index: StatusData['index']): string {
  if (index === null) {
    return 'index       (none — run `ai-primitives-hub index build`)\n';
  }
  return `index       ${index.primitives} primitives  [${index.path}]\n`;
}

function renderEntryLines(d: StatusData, verbose: boolean): string[] {
  if (d.entries.length === 0) {
    return ['lockfile    (none)\n'];
  }
  const bundles = new Set(d.entries.map((row) => row.bundleId)).size;
  const lines = [`lockfile    ${bundles} bundle${bundles === 1 ? '' : 's'} installed (${d.entries.length} entr${d.entries.length === 1 ? 'y' : 'ies'})\n`];
  for (const row of d.entries) {
    const flag = row.needsReinstall ? '  needs reinstall' : '';
    lines.push(`              ${row.bundleId}@${row.version} (${row.tool})${flag}${verbose ? `  [${row.record}]` : ''}\n`);
  }
  return lines;
}

/**
 * Render status as human-readable text: one line per (bundle, tool) and the `Record:` line.
 * @param d Status data.
 * @param verbose Whether to show each row's record file.
 * @returns Rendered text.
 */
function renderStatusText(d: StatusData, verbose: boolean): string {
  return [
    'ai-primitives-hub status\n',
    '─'.repeat(40) + '\n',
    renderConfigLine(d.configPath, d.userTargetsPath),
    renderTargetsLine(d.targets),
    ...renderHubLines(d.activeHubId, d.hubs),
    renderIndexLine(d.index),
    ...renderEntryLines(d, verbose),
    renderRecordLine({ level: d.level, records: d.records })
  ].join('');
}
