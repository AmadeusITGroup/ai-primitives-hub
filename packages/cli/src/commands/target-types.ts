/**
 * `target types` command.
 *
 * Lists all supported install target types with a human-readable
 * description. Removes the guessing-game of valid `--type` values
 * from `target add`.
 * @module commands/target-types
 */
import {
  TARGET_TYPES,
} from '@ai-primitives-hub/core';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
} from '../framework';

/**
 * Human-readable description for each target type.
 * @internal
 */
const TARGET_DESCRIPTIONS: Record<string, string> = {
  vscode: 'VS Code (user scope — ~/.config/Code/User/prompts/)',
  'vscode-insiders': 'VS Code Insiders (user scope — ~/.config/Code - Insiders/User/prompts/)',
  'copilot-cli': 'GitHub Copilot CLI (user scope — ~/.config/github-copilot/prompts/)',
  kiro: 'Kiro IDE',
  windsurf: 'Windsurf IDE (Codeium)',
  'claude-code': 'Anthropic Claude Code'
};

/**
 * Target type entry.
 */
export interface TargetTypeEntry {
  type: string;
  description: string;
}

/**
 * Target types command class.
 */
export class TargetTypesCommand extends Command {
  public static readonly paths = [['target', 'types']];

  public static readonly usage = Command.Usage({
    description: 'List all supported install target types with descriptions.',
    category: 'Install & Manage',
    details: `
      Usage: ai-primitives-hub target types [-o <format>]

      Examples:
        $ ai-primitives-hub target types
        $ ai-primitives-hub target types -o json
    `
  });

  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const data: TargetTypeEntry[] = TARGET_TYPES.map((t) => ({
      type: t,
      description: TARGET_DESCRIPTIONS[t] ?? ''
    }));
    formatOutput({
      ctx,
      command: 'target.types',
      output: (this.output as OutputFormat) ?? 'text',
      status: 'ok',
      data,
      textRenderer: (d) => [
        'Supported target types:\n',
        ...d.map((t) => `  ${t.type.padEnd(22)} ${t.description}\n`),
        '\nUsage: ai-primitives-hub target add <name> --type <type>\n'
      ].join('')
    });
    return Promise.resolve(0);
  }
}
