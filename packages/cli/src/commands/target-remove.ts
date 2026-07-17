/**
 * `target remove`.
 *
 * Wires the persist side: validates the positional name,
 * delegates to `removeTargetByName()`, and surfaces a not-found
 * error code distinct from the USAGE.MISSING_FLAG code used for
 * an empty name.
 * @module commands/target-remove
 */
import {
  removeTargetByName,
} from '@ai-primitives-hub/infra';
import {
  Command,
  type Context,
  failWith,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
} from '../framework';

/**
 * Target remove command class.
 */
export class TargetRemoveCommand extends Command {
  public static readonly paths = [['target', 'remove']];

  public static readonly usage = Command.Usage({
    description: 'Remove a configured install target.',
    category: 'Install & Manage',
    details: `
      Usage: ai-primitives-hub target remove <name> [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub target remove my-vscode
    `
  });

  public output = Option.String('-o,--output');
  public name = Option.String();
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
    const name = this.name ?? '';

    if (name.length === 0) {
      return failWith(ctx, fmt, 'target.remove', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'target remove: missing target name',
        hint: 'Usage: `ai-primitives-hub target remove <name>`'
      }));
    }
    try {
      const result = await removeTargetByName(
        { cwd: ctx.cwd(), fs: ctx.fs },
        name
      );
      formatOutput({
        ctx,
        command: 'target.remove',
        output: fmt,
        status: 'ok',
        data: { name, file: result.file },
        textRenderer: (d) => `Removed target "${d.name}" from ${d.file}.\n`
      });
      return 0;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const isMissing = message.includes('not found');
      return failWith(ctx, fmt, 'target.remove', new RegistryError({
        code: isMissing ? 'USAGE.MISSING_FLAG' : 'INTERNAL.UNEXPECTED',
        message: `target remove: ${message}`,
        hint: isMissing
          ? 'Run `ai-primitives-hub target list` to see configured targets.'
          : 'See `ai-primitives-hub doctor` for environment diagnostics.',
        context: { name },
        cause: cause instanceof Error ? cause : undefined
      }));
    }
  }
}
