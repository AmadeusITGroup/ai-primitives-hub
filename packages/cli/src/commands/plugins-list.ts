/**
 * `plugins list` subcommand.
 *
 * Discovers `prompt-registry-<name>` executables on `$PATH` per
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
 */
import * as path from 'node:path';
import {
  Command,
  copyCommandPrototype,
  Option,
} from '../framework';
import {
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  type OutputFormat,
  renderTable,
} from '../framework';

interface PluginRecord {
  name: string;
  source: string;
  conflicts: string[];
}

export interface PluginsListOptions {
  output?: OutputFormat;
}

const PLUGIN_PREFIX = 'prompt-registry-';

/**
 * Command context for plugins list command.
 */
interface PluginsListContext {
  ctx: Context;
}

/**
 * Base class for plugins list command.
 */
abstract class BasePluginsListCommand extends Command {
  public commandContext: PluginsListContext = { ctx: null as any };
}

/**
 * Native clipanion class command for plugins list.
 */
export class PluginsListCommand extends BasePluginsListCommand {
  public static readonly paths = [['plugins', 'list']];

  public static readonly usage = Command.Usage({
    description: 'List `prompt-registry-<name>` plugins discovered on $PATH (kubectl-style).',
    category: 'Configure & Debug',
    details: `
      Usage: prompt-registry plugins list [options]

      Discovers prompt-registry-<name> executables on $PATH and reports conflicts.

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry plugins list
        prompt-registry plugins list -o json
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
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

/**
 * Create a CommandDefinition wrapper for the plugins list command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @returns CommandClass.
 */
const createPluginsListCommandDefinition = (
  ctx: Context,
  defaultOutput?: string
): typeof PluginsListCommand => {
  class ConfiguredCommand extends PluginsListCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(PluginsListCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured plugins list command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @returns CommandClass.
 */
export const createPluginsListCommandClass = (
  ctx: Context,
  defaultOutput?: string
): typeof PluginsListCommand => {
  return createPluginsListCommandDefinition(ctx, defaultOutput);
};

async function scanPathForPlugins(pathVar: string, ctx: Context): Promise<Map<string, PluginRecord>> {
  const dirs = pathVar.split(path.delimiter).filter((d) => d.length > 0);
  const plugins = new Map<string, PluginRecord>();
  for (const dir of dirs) {
    await scanDirectoryForPlugins(dir, ctx, plugins);
  }
  return plugins;
}

async function scanDirectoryForPlugins(
  dir: string,
  ctx: Context,
  plugins: Map<string, PluginRecord>
): Promise<void> {
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
}

async function getDirectoryEntries(dir: string, ctx: Context): Promise<string[] | undefined> {
  try {
    return await ctx.fs.readDir(dir);
  } catch {
    return undefined;
  }
}

function processPluginFile(filename: string, dir: string, plugins: Map<string, PluginRecord>): void {
  if (!filename.startsWith(PLUGIN_PREFIX)) {
    return;
  }
  const name = filename.slice(PLUGIN_PREFIX.length);
  const fullPath = path.join(dir, filename);
  if (plugins.has(name)) {
    const existing = plugins.get(name);
    if (existing !== undefined) {
      existing.conflicts.push(fullPath);
    }
  } else {
    plugins.set(name, { name, source: fullPath, conflicts: [] });
  }
}

function generateConflictWarnings(records: PluginRecord[]): string[] {
  const warnings: string[] = [];
  for (const r of records) {
    for (const c of r.conflicts) {
      warnings.push(`plugin "${r.name}" shadowed: ${c} (in use: ${r.source})`);
    }
  }
  return warnings;
}

/**
 * Build the `plugins list` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createPluginsListCommand = (
  opts: PluginsListOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['plugins', 'list'],
    description: 'List `prompt-registry-<name>` plugins discovered on $PATH (kubectl-style).',
    category: 'Configure & Debug',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const pathVar = ctx.env.PATH ?? '';
      const plugins = await scanPathForPlugins(pathVar, ctx);
      const records = [...plugins.values()].toSorted((a, b) => a.name.localeCompare(b.name));
      const warnings = generateConflictWarnings(records);
      formatOutput({
        ctx,
        command: 'plugins.list',
        output: opts.output ?? 'text',
        status: warnings.length > 0 ? 'warning' : 'ok',
        data: records,
        warnings,
        textRenderer: renderText
      });
      return 0;
    }
  });

const renderText = (records: PluginRecord[]): string =>
  renderTable<PluginRecord>({
    columns: [
      { header: 'NAME', get: (r) => r.name },
      { header: 'SOURCE', get: (r) => r.source }
    ],
    rows: records,
    emptyMessage: 'No plugins found on $PATH.\n  (Plugins are executables named `prompt-registry-<name>` discoverable via PATH.)\n'
  });
