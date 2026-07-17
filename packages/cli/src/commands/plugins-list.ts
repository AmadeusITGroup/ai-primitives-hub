/**
 * `plugins list` subcommand.
 *
 * Discovers `ai-primitives-hub-<name>` executables on `$PATH` per
 * the kubectl/gh model. Each match becomes a plugin
 * candidate; dashes in the filename map to nested subcommands at
 * dispatch time (not implemented in this iteration).
 *
 * This iteration ships discovery only — invocation is deferred to a later
 * iteration when the dispatcher knows how to spawn matched plugins.
 *
 * The lookup walks every directory in PATH and reports the first
 * match for each plugin name, mirroring how the shell's PATH search
 * works. Conflicts are flagged as warnings.
 * @module commands/plugins-list
 */
import * as path from 'node:path';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  renderTable,
} from '../framework';

/**
 * Discovered plugin record.
 */
interface PluginRecord {
  name: string;
  source: string;
  conflicts: string[];
}

const PLUGIN_PREFIX = 'ai-primitives-hub-';

/**
 * Scan every directory in PATH for plugin executables.
 * @param pathVar Raw PATH environment variable value.
 * @param ctx CLI context.
 * @returns Map of plugin name to record (first match wins; later matches recorded as conflicts).
 */
const scanPathForPlugins = async (pathVar: string, ctx: Context): Promise<Map<string, PluginRecord>> => {
  const dirs = pathVar.split(path.delimiter).filter((d) => d.length > 0);
  const plugins = new Map<string, PluginRecord>();
  for (const dir of dirs) {
    await scanDirectoryForPlugins(dir, ctx, plugins);
  }
  return plugins;
};

/**
 * Scan a single directory for plugin executables.
 * @param dir Directory to scan.
 * @param ctx CLI context.
 * @param plugins Map to accumulate discovered plugins into.
 */
const scanDirectoryForPlugins = async (
  dir: string,
  ctx: Context,
  plugins: Map<string, PluginRecord>
): Promise<void> => {
  if (!(await ctx.fs.exists(dir))) {
    return;
  }
  const entries = await getDirectoryEntries(dir, ctx);
  if (entries === undefined) {
    return;
  }
  for (const filename of entries) {
    processPluginFile(filename, dir, plugins);
  }
};

/**
 * Read directory entries, tolerating unreadable directories.
 * @param dir Directory to read.
 * @param ctx CLI context.
 * @returns Entry filenames, or undefined if the directory could not be read.
 */
const getDirectoryEntries = async (dir: string, ctx: Context): Promise<string[] | undefined> => {
  try {
    return await ctx.fs.readDir(dir);
  } catch {
    return undefined;
  }
};

/**
 * Record a candidate plugin file if its name matches the plugin prefix.
 * @param filename Filename to check.
 * @param dir Directory the filename is in.
 * @param plugins Map to accumulate discovered plugins into.
 */
const processPluginFile = (filename: string, dir: string, plugins: Map<string, PluginRecord>): void => {
  if (!filename.startsWith(PLUGIN_PREFIX)) {
    return;
  }
  const name = filename.slice(PLUGIN_PREFIX.length);
  const fullPath = path.join(dir, filename);
  const existing = plugins.get(name);
  if (existing === undefined) {
    plugins.set(name, { name, source: fullPath, conflicts: [] });
  } else {
    existing.conflicts.push(fullPath);
  }
};

/**
 * Generate warnings for every shadowed (conflicting) plugin match.
 * @param records Plugin records.
 * @returns Warning messages.
 */
const generateConflictWarnings = (records: PluginRecord[]): string[] => {
  const warnings: string[] = [];
  for (const r of records) {
    for (const c of r.conflicts) {
      warnings.push(`plugin "${r.name}" shadowed: ${c} (in use: ${r.source})`);
    }
  }
  return warnings;
};

/**
 * Render plugins as text.
 * @param records Plugin records.
 * @returns Formatted text output.
 */
const renderText = (records: PluginRecord[]): string =>
  renderTable<PluginRecord>({
    columns: [
      { header: 'NAME', get: (r) => r.name },
      { header: 'SOURCE', get: (r) => r.source }
    ],
    rows: records,
    emptyMessage: 'No plugins found on $PATH.\n  (Plugins are executables named `ai-primitives-hub-<name>` discoverable via PATH.)\n'
  });

/**
 * Plugins list command class.
 */
export class PluginsListCommand extends Command {
  public static readonly paths = [['plugins', 'list']];

  public static readonly usage = Command.Usage({
    description: 'List `ai-primitives-hub-<name>` plugins discovered on $PATH (kubectl-style).',
    category: 'Configure & Debug',
    details: `
      Usage: ai-primitives-hub plugins list [options]

      Discovers ai-primitives-hub-<name> executables on $PATH and reports conflicts.

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub plugins list
        ai-primitives-hub plugins list -o json
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = this.output ?? 'text';
    const pathVar = ctx.env.PATH ?? '';
    const plugins = await scanPathForPlugins(pathVar, ctx);
    const records = [...plugins.values()].toSorted((a, b) => a.name.localeCompare(b.name));
    const warnings = generateConflictWarnings(records);
    formatOutput({
      ctx,
      command: 'plugins.list',
      output: fmt,
      status: warnings.length > 0 ? 'warning' : 'ok',
      data: records,
      warnings,
      textRenderer: renderText
    });
    return 0;
  }
}
