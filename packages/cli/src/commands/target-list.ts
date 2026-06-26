/**
 * `target list` stub.
 *
 * The full `target` model lives in environment-agnostic install.
 * This ships a list-only stub that reads `targets[]`
 * from the resolved config and prints what's there. Later iterations add
 * `target add` and `target remove`. Each iteration is a one-
 * file delta against the same shape.
 *
 * The point of shipping these stubs is twofold:
 *   - The migration guide can list every command users
 *     might encounter, including ones whose semantics are not
 *     final.
 *   - When install lands, the command tree won't appear to
 *     "grow new top-level nouns out of nowhere" — `target` is
 *     already a documented hub.
 */
import {
  Command,
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  getCommandContext,
  loadConfig,
  Option,
  type OutputFormat,
  renderTable,
} from '../framework';

/**
 * Target record.
 */
interface TargetRecord {
  name: string;
  type: string;
  scope?: string;
  path?: string;
  allowedKinds?: string[];
}

/**
 * Render a target list as a fixed-width text table. Empty list is
 * rendered as a friendly message that points users at `target add`.
 * @param targets - Array of TargetRecord rows.
 * @returns Rendered table string (newline-terminated).
 */
const renderTargetTable = (targets: TargetRecord[]): string =>
  renderTable<TargetRecord>({
    columns: [
      { header: 'NAME', get: (t) => t.name },
      { header: 'TYPE', get: (t) => t.type },
      { header: 'SCOPE', get: (t) => t.scope ?? '' },
      { header: 'PATH', get: (t) => t.path ?? '' },
      { header: 'ALLOWED-KINDS', get: (t) => t.allowedKinds?.join(',') ?? '' }
    ],
    rows: targets,
    emptyMessage: 'No targets configured.\n'
      + 'Add one with: `prompt-registry target add <name> --type <vscode|copilot-cli|kiro|windsurf|vscode-insiders>`\n'
  });

/**
 * Target list command options.
 */
export interface TargetListOptions {
  output?: OutputFormat;
}

/**
 * Build the `target list` command using defineCommand (for test compatibility).
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createTargetListCommand = (
  opts: TargetListOptions
): CommandDefinition =>
  defineCommand({
    path: ['target', 'list'],
    description: 'List configured install targets (vscode, copilot-cli, kiro, …).',
    category: 'Install & Manage',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const fmt = opts.output ?? 'text';
      const config = await loadConfig({
        cwd: ctx.cwd(),
        env: ctx.env,
        fs: ctx.fs
      });
      const raw = (config as { targets?: unknown }).targets;
      const targets = Array.isArray(raw)
        ? (raw as TargetRecord[])
        : [];
      if (fmt === 'json' || fmt === 'yaml' || fmt === 'ndjson') {
        formatOutput({
          ctx,
          command: 'target.list',
          output: fmt,
          status: 'ok',
          data: targets
        });
      } else {
        ctx.stdout.write(renderTargetTable(targets));
      }
      return 0;
    }
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
      Usage: prompt-registry target list [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry target list
        prompt-registry target list -o json
    `
  });

  public output = Option.String('-o,--output');

  public async execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const config = await loadConfig({
      cwd: ctx.cwd(),
      env: ctx.env,
      fs: ctx.fs
    });
    const raw = (config as { targets?: unknown }).targets;
    const targets = Array.isArray(raw)
      ? (raw as TargetRecord[])
      : [];
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
