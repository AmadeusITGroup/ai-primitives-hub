/**
 * `target remove`.
 *
 * Wires the persist side: validates the positional name,
 * delegates to `removeTargetByName()`, and surfaces a not-found
 * error code distinct from the USAGE.MISSING_FLAG code used for
 * an empty name.
 */
import {
  removeTargetByName,
} from '@prompt-registry/infra';
import {
  Command,
  copyCommandPrototype,
  failWith,
  Option,
} from '../framework';
import {
  type CommandDefinition,
  type Context,
  defineCommand,
  formatOutput,
  type OutputFormat,
  RegistryError,
} from '../framework';

/**
 * Target remove command options.
 */
export interface TargetRemoveOptions {
  output?: OutputFormat;
  /** Target name (required). */
  name: string;
}

/**
 * Command context for target remove command.
 */
interface TargetRemoveContext {
  ctx: Context;
}

/**
 * Base class for target remove command.
 */
abstract class BaseTargetRemoveCommand extends Command {
  public commandContext: TargetRemoveContext = { ctx: null as any };
}

/**
 * Native clipanion class command for target remove.
 */
export class TargetRemoveCommand extends BaseTargetRemoveCommand {
  public static readonly paths = [['target', 'remove']];

  public static readonly usage = Command.Usage({
    description: 'Remove a configured install target.',
    category: 'Install & Manage',
    details: `
      Usage: prompt-registry target remove <name> [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry target remove my-vscode
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public name = Option.String(); // Positional argument

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const name = this.name ?? '';

    if (name.length === 0) {
      return failWith(ctx, fmt, 'target.remove', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'target remove: missing target name',
        hint: 'Usage: `prompt-registry target remove <name>`'
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
          ? 'Run `prompt-registry target list` to see configured targets.'
          : 'See `prompt-registry doctor` for environment diagnostics.',
        context: { name },
        cause: cause instanceof Error ? cause : undefined
      }));
    }
  }
}

/**
 * Create a CommandDefinition wrapper for the target remove command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultName Default target name (optional).
 * @returns CommandClass.
 */
const createTargetRemoveCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  defaultName?: string
): typeof TargetRemoveCommand => {
  class ConfiguredCommand extends TargetRemoveCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (defaultName !== undefined && !this.name) {
        this.name = defaultName;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(TargetRemoveCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured target remove command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultName Default target name (optional).
 * @returns CommandClass.
 */
export const createTargetRemoveCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  defaultName?: string
): typeof TargetRemoveCommand => {
  return createTargetRemoveCommandDefinition(ctx, defaultOutput, defaultName);
};

/**
 * Build the `target remove` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createTargetRemoveCommand = (
  opts: TargetRemoveOptions
): CommandDefinition =>
  defineCommand({
    path: ['target', 'remove'],
    description: 'Remove a configured install target.',
    category: 'Install & Manage',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const fmt = opts.output ?? 'text';
      if (opts.name.length === 0) {
        return failWith(ctx, fmt, 'target.remove', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'target remove: missing target name',
          hint: 'Usage: `prompt-registry target remove <name>`'
        }));
      }
      try {
        const result = await removeTargetByName(
          { cwd: ctx.cwd(), fs: ctx.fs },
          opts.name
        );
        formatOutput({
          ctx,
          command: 'target.remove',
          output: fmt,
          status: 'ok',
          data: { name: opts.name, file: result.file },
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
            ? 'Run `prompt-registry target list` to see configured targets.'
            : 'See `prompt-registry doctor` for environment diagnostics.',
          context: { name: opts.name },
          cause: cause instanceof Error ? cause : undefined
        }));
      }
    }
  });

/**
 * Fail with error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 * @returns Exit code.
 */
