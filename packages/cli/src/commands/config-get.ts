/**
 * `config get` subcommand.
 *
 * Reads a value from the layered YAML config (8-layer precedence
 * chain — see `loadConfig`). The dotted key path
 * (e.g., `output.json.indent`) drills into the resolved object.
 *
 * Scope is intentionally minimal: load config + read key.
 * `config set` / `config list` follow the same shape.
 */
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
  loadConfig,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/**
 * Config get command options.
 */
export interface ConfigGetOptions {
  /** Output format. Default 'text'. */
  output?: OutputFormat;
  /** Dotted key path (e.g., 'output.json.indent'). Required. */
  key: string;
}

/**
 * Command context for config get command.
 */
interface ConfigGetContext {
  ctx: Context;
}

/**
 * Base class for config get command.
 */
abstract class BaseConfigGetCommand extends Command {
  public commandContext: ConfigGetContext = { ctx: null as any };
}

/**
 * Native clipanion class command for config get.
 */
export class ConfigGetCommand extends BaseConfigGetCommand {
  public static readonly paths = [['config', 'get']];

  public static readonly usage = Command.Usage({
    description: 'Read a config value by dotted key path (e.g., `output.json.indent`).',
    category: 'Configure & Debug',
    details: `
      Usage: prompt-registry config get <dotted.key> [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        prompt-registry config get output.json.indent
        prompt-registry config get targets -o json
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public key = Option.String(); // Positional argument

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const key = this.key ?? '';

    if (key.length === 0) {
      const err = new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'config get: missing key',
        hint: 'Usage: `prompt-registry config get <dotted.key>`'
      });
      emitError(ctx, fmt, err);
      return 1;
    }
    try {
      const config = await loadConfig({
        cwd: ctx.cwd(),
        env: ctx.env,
        fs: ctx.fs
      });
      const value = readDottedKey(config, key);
      formatOutput({
        ctx,
        command: 'config.get',
        output: fmt,
        status: 'ok',
        data: { key, value },
        textRenderer: (d) => {
          let valueStr: string;
          if (d.value === undefined) {
            valueStr = '(unset)\n';
          } else if (typeof d.value === 'string') {
            valueStr = d.value;
          } else {
            valueStr = JSON.stringify(d.value);
          }
          return `${d.key}: ${valueStr}\n`;
        }
      });
      return 0;
    } catch (err) {
      const re = err instanceof RegistryError
        ? err
        : new RegistryError({
          code: 'CONFIG.LOAD_FAILED',
          message: err instanceof Error ? err.message : String(err),
          cause: err
        });
      emitError(ctx, fmt, re);
      return 1;
    }
  }
}

/**
 * Create a CommandDefinition wrapper for the config get command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultKey Default key (optional).
 * @returns CommandClass.
 */
const createConfigGetCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  defaultKey?: string
): typeof ConfigGetCommand => {
  class ConfiguredCommand extends ConfigGetCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (defaultKey !== undefined && !this.key) {
        this.key = defaultKey;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(ConfigGetCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured config get command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param defaultKey Default key (optional).
 * @returns CommandClass.
 */
export const createConfigGetCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  defaultKey?: string
): typeof ConfigGetCommand => {
  return createConfigGetCommandDefinition(ctx, defaultOutput, defaultKey);
};

/**
 * Build the `config get` command.
 * @param opts - Command options.
 * @returns CommandDefinition wired to the framework adapter.
 */
export const createConfigGetCommand = (
  opts: ConfigGetOptions
): CommandDefinition =>
  defineCommand({
    path: ['config', 'get'],
    description: 'Read a config value by dotted key path (e.g., `output.json.indent`).',
    category: 'Configure & Debug',
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      if (opts.key.length === 0) {
        const err = new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'config get: missing key',
          hint: 'Usage: `prompt-registry config get <dotted.key>`'
        });
        emitError(ctx, opts.output ?? 'text', err);
        return 1;
      }
      try {
        const config = await loadConfig({
          cwd: ctx.cwd(),
          env: ctx.env,
          fs: ctx.fs
        });
        const value = readDottedKey(config, opts.key);
        formatOutput({
          ctx,
          command: 'config.get',
          output: opts.output ?? 'text',
          status: 'ok',
          data: { key: opts.key, value },
          textRenderer: (d) => {
            let valueStr: string;
            if (d.value === undefined) {
              valueStr = '(unset)\n';
            } else if (typeof d.value === 'string') {
              valueStr = d.value;
            } else {
              valueStr = JSON.stringify(d.value);
            }
            return `${d.key}: ${valueStr}\n`;
          }
        });
        return 0;
      } catch (err) {
        const re = err instanceof RegistryError
          ? err
          : new RegistryError({
            code: 'CONFIG.LOAD_FAILED',
            message: err instanceof Error ? err.message : String(err),
            cause: err
          });
        emitError(ctx, opts.output ?? 'text', re);
        return 1;
      }
    }
  });

/**
 * Read value from object using dotted key path.
 * @param obj Object to read from.
 * @param key Dotted key path.
 * @returns Value at key path, or undefined if not found.
 */
const readDottedKey = (obj: unknown, key: string): unknown => {
  const parts = key.split('.');
  let cursor: unknown = obj;
  for (const p of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
};

/**
 * Emit error in appropriate format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 */
const emitError = (ctx: Context, output: OutputFormat, err: RegistryError): void => {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command: 'config.get',
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
};
