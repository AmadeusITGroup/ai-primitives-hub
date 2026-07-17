/**
 * `target list`.
 *
 * Lists configured install targets, reading through the hierarchical
 * target resolution (`framework/target.ts`'s `loadTargets`): project-level
 * targets when present, falling back to user-level targets otherwise.
 * @module commands/target-list
 */
import type {
  Target,
} from '@ai-primitives-hub/core';
import {
  Command,
  type Context,
  formatOutput,
  loadTargets,
  Option,
  type OutputFormat,
  renderTable,
} from '../framework';

/**
 * Render a target list as a fixed-width text table. Empty list is
 * rendered as a friendly message that points users at `target add`.
 * @param targets - Array of Target rows.
 * @returns Rendered table string (newline-terminated).
 */
const renderTargetTable = (targets: Target[]): string =>
  renderTable<Target>({
    columns: [
      { header: 'NAME', get: (t) => t.name },
      { header: 'TYPE', get: (t) => t.type },
      { header: 'SCOPE', get: (t) => t.scope },
      { header: 'PATH', get: (t) => t.path ?? '' },
      { header: 'ALLOWED-KINDS', get: (t) => t.allowedKinds?.join(',') ?? '' }
    ],
    rows: targets,
    emptyMessage: 'No targets configured.\n'
      + 'Add one with: `ai-primitives-hub target add <name> --type <vscode|copilot-cli|kiro|windsurf|claude-code>`\n'
  });

/**
 * Target list command class.
 */
export class TargetListCommand extends Command {
  public static readonly paths = [['target', 'list']];

  public static readonly usage = Command.Usage({
    description: 'List configured install targets (vscode, copilot-cli, kiro, …).',
    category: 'Install & Manage',
    details: `
      Usage: ai-primitives-hub target list [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub target list
        ai-primitives-hub target list -o json
    `
  });

  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const targets = await loadTargets(ctx);
    formatOutput({
      ctx,
      command: 'target.list',
      output: (this.output as OutputFormat) ?? 'text',
      status: 'ok',
      data: targets,
      textRenderer: (d) => renderTargetTable(d)
    });
    return 0;
  }
}
