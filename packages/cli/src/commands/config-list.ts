/**
 * `config list` subcommand.
 *
 * Dumps the resolved config (after the layered merge — see `loadConfig`)
 * as text or the JSON envelope. Useful for debugging precedence: a user
 * can `ai-primitives-hub config list -o yaml` and see exactly what the
 * commands see.
 * @module commands/config-list
 */
import {
  Command,
  type Context,
  formatOutput,
  loadConfig,
  Option,
  type OutputFormat,
} from '../framework';

/**
 * Render the hubs section.
 * @param hubs Hubs config object.
 * @returns Formatted lines.
 */
const renderHubsSection = (hubs: Record<string, unknown>): string[] => {
  const lines: string[] = ['=== Hubs ===', `Active hub: ${(hubs.activeHub as string | undefined) ?? 'none'}`];
  const configuredHubs = hubs.configuredHubs as Record<string, unknown> | undefined;
  if (configuredHubs !== undefined && typeof configuredHubs === 'object') {
    lines.push(`Configured hubs: ${Object.keys(configuredHubs).join(', ') || 'none'}`);
  }
  lines.push('');
  return lines;
};

/**
 * Render the targets section.
 * @param rawTargets Raw targets value from config.
 * @returns Formatted lines.
 */
const renderTargetsSection = (rawTargets: unknown): string[] => {
  const targetArray: { name: string; type: string }[] | undefined = Array.isArray(rawTargets)
    ? (rawTargets as { name: string; type: string }[])
    : ((rawTargets as Record<string, unknown> | undefined)?.targets as { name: string; type: string }[] | undefined);
  if (targetArray === undefined) {
    return [];
  }
  const items = targetArray.length === 0
    ? ['No targets configured']
    : targetArray.map((t) => `  - ${t.name} (${t.type})`);
  return ['=== Targets ===', ...items, ''];
};

/**
 * Render the profiles section.
 * @param profiles Profiles config object.
 * @returns Formatted lines.
 */
const renderProfilesSection = (profiles: Record<string, unknown>): string[] => [
  '=== Profiles ===',
  `Active profile: ${(profiles.activeProfile as string | undefined) ?? 'none'}`,
  ''
];

/**
 * Render the GitHub authentication section.
 * @param github GitHub config object.
 * @returns Formatted lines.
 */
const renderGithubSection = (github: Record<string, unknown>): string[] => [
  '=== GitHub Authentication ===',
  `Token configured: ${(github.token as string | undefined) ? 'yes' : 'no'}`,
  ''
];

/**
 * Render the paths section.
 * @param paths Paths config object.
 * @returns Formatted lines.
 */
const renderPathsSection = (paths: Record<string, unknown>): string[] => {
  const lines: string[] = ['=== Paths ==='];
  const configPath = paths.configPath as string | undefined;
  const cachePath = paths.cachePath as string | undefined;
  if (configPath !== undefined) {
    lines.push(`Config path: ${configPath}`);
  }
  if (cachePath !== undefined) {
    lines.push(`Cache path: ${cachePath}`);
  }
  lines.push('');
  return lines;
};

/**
 * Render config in a human-readable format.
 * @param config Resolved config object.
 * @returns Formatted string.
 */
const renderConfigText = (config: Record<string, unknown>): string => {
  const versionStr = typeof config.version === 'string' || typeof config.version === 'number'
    ? String(config.version)
    : 'unknown';
  const outputStr = typeof config.output === 'string' ? config.output : 'text';
  const lines: string[] = [
    '=== AI Primitives Hub Configuration ===\n',
    `Version: ${versionStr}`,
    `Output format: ${outputStr}`,
    `Verbose: ${String(Boolean(config.verbose))}`,
    `Quiet: ${String(Boolean(config.quiet))}`,
    ''
  ];
  const hubs = config.hubs as Record<string, unknown> | undefined;
  if (hubs !== undefined && typeof hubs === 'object') {
    lines.push(...renderHubsSection(hubs));
  }
  lines.push(...renderTargetsSection(config.targets));
  const profiles = config.profiles as Record<string, unknown> | undefined;
  if (profiles !== undefined && typeof profiles === 'object') {
    lines.push(...renderProfilesSection(profiles));
  }
  const github = config.github as Record<string, unknown> | undefined;
  if (github !== undefined && typeof github === 'object') {
    lines.push(...renderGithubSection(github));
  }
  const paths = config.paths as Record<string, unknown> | undefined;
  if (paths !== undefined && typeof paths === 'object') {
    lines.push(...renderPathsSection(paths));
  }
  return lines.join('\n');
};

/**
 * Config list command class.
 */
export class ConfigListCommand extends Command {
  public static readonly paths = [['config', 'list']];

  public static readonly usage = Command.Usage({
    description: 'Print the resolved config (post-merge across all precedence layers). Shows hubs, targets, profiles, and paths.',
    category: 'Configure & Debug',
    details: `
      Usage: ai-primitives-hub config list [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub config list
        ai-primitives-hub config list -o yaml
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const config = await loadConfig({
      cwd: ctx.cwd(),
      env: ctx.env,
      fs: ctx.fs
    });

    const fmt = this.output ?? 'text';

    // For text output, write directly to stdout to avoid envelope wrapping
    if (fmt === 'text') {
      ctx.stdout.write(renderConfigText(config));
      return 0;
    }

    // For other formats (json, yaml, ndjson), use the envelope
    formatOutput({
      ctx,
      command: 'config.list',
      output: fmt,
      status: 'ok',
      data: config,
      textRenderer: (d) => renderConfigText(d as Record<string, unknown>)
    });
    return 0;
  }
}
