/**
 * `config get` subcommand.
 *
 * Reads a value from the layered YAML config (see `loadConfig`'s own
 * precedence chain). The dotted key path (e.g., `output`) drills into
 * the resolved object.
 *
 * Scope is intentionally minimal: load config + read key. `config list`
 * follows the same shape.
 * @module commands/config-get
 */
import {
  Command,
  type Context,
  formatOutput,
  loadConfig,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/**
 * Config get data.
 */
interface ConfigGetData {
  key: string;
  value: unknown;
}

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

/**
 * Render config get data as text.
 * @param d Config get data.
 * @returns Formatted text output.
 */
const renderText = (d: ConfigGetData): string => {
  let valueStr: string;
  if (d.value === undefined) {
    valueStr = '(unset)';
  } else if (typeof d.value === 'string') {
    valueStr = d.value;
  } else {
    valueStr = JSON.stringify(d.value);
  }
  return `${d.key}: ${valueStr}\n`;
};

/**
 * Config get command class.
 */
export class ConfigGetCommand extends Command {
  public static readonly paths = [['config', 'get']];

  public static readonly usage = Command.Usage({
    description: 'Read a config value by dotted key path (e.g., `output`).',
    category: 'Configure & Debug',
    details: `
      Usage: ai-primitives-hub config get <dotted.key> [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub config get output
        ai-primitives-hub config get targets -o json
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public key = Option.String(); // Positional argument
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = this.output ?? 'text';
    const key = this.key ?? '';

    if (key.length === 0) {
      const err = new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'config get: missing key',
        hint: 'Usage: `ai-primitives-hub config get <dotted.key>`'
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
        textRenderer: renderText
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
