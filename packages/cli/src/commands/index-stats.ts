/**
 * `prompt-registry index stats` — summary stats for a primitive index.
 *
 * Replaces the legacy `primitive-index stats` verb with a framework
 * command. Output goes through `formatOutput` so `-o json|yaml|ndjson`
 * all produce the canonical envelope.
 * @module cli/commands/index-stats
 */
import type {
  IndexStats,
} from '@prompt-registry/infra';
import {
  defaultIndexFile,
  loadIndex,
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

export interface IndexStatsOptions {
  output?: OutputFormat;
  /** Path to the index JSON. Defaults to `<XDG cache>/primitive-index.json`. */
  indexFile?: string;
}

/**
 * Command context for index stats command.
 */
interface IndexStatsContext {
  ctx: Context;
}

/**
 * Base class for index stats command.
 */
abstract class BaseIndexStatsCommand extends Command {
  public commandContext: IndexStatsContext = { ctx: null as any };
}

/**
 * Native clipanion class command for index stats.
 */
export class IndexStatsCommand extends BaseIndexStatsCommand {
  public static readonly paths = [['index', 'stats']];

  public static readonly usage = Command.Usage({
    description: 'Show summary statistics for a primitive index.',
    category: 'Index & Search',
    details: `
      Usage: prompt-registry index stats [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)
        --index <path>         Path to index JSON (default: XDG cache/primitive-index.json)
    `
  });

  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public indexFile = Option.String('--index');

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text');
    const indexPath = this.indexFile ?? defaultIndexFile(ctx.env);
    try {
      const idx = loadIndex(indexPath);
      const stats = idx.stats();
      formatOutput({
        ctx,
        command: 'index.stats',
        output: fmt,
        status: 'ok',
        data: stats,
        textRenderer: (s) => renderStatsText(s)
      });
      return 0;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      const err = /ENOENT|no such file/i.test(msg)
        ? new RegistryError({
          code: 'INDEX.NOT_FOUND',
          message: `index not found: ${indexPath}`,
          hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
          cause: cause instanceof Error ? cause : undefined
        })
        : new RegistryError({
          code: 'INDEX.LOAD_FAILED',
          message: `failed to load index ${indexPath}: ${msg}`,
          cause: cause instanceof Error ? cause : undefined
        });
      return failWith(ctx, fmt, 'index.stats', err);
    }
  }
}

/**
 * Create a CommandDefinition wrapper for the index stats command class.
 * This adapts native clipanion classes to the framework's CommandDefinition pattern.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param indexFileDefault Default index file path (optional).
 * @returns CommandClass.
 */
const createIndexStatsCommandDefinition = (
  ctx: Context,
  defaultOutput?: string,
  indexFileDefault?: string
): typeof IndexStatsCommand => {
  class ConfiguredCommand extends IndexStatsCommand {
    public execute(): Promise<number> {
      this.commandContext = { ctx };
      if (defaultOutput !== undefined && !this.output) {
        this.output = defaultOutput as OutputFormat;
      }
      if (indexFileDefault !== undefined && !this.indexFile) {
        this.indexFile = indexFileDefault;
      }

      return super.execute();
    }
  }
  copyCommandPrototype(IndexStatsCommand, ConfiguredCommand);

  return ConfiguredCommand;
};

/**
 * Factory function to create a configured index stats command class.
 * @param ctx CLI context.
 * @param defaultOutput Default output format (optional).
 * @param indexFileDefault Default index file path (optional).
 * @returns CommandClass.
 */
export const createIndexStatsCommandClass = (
  ctx: Context,
  defaultOutput?: string,
  indexFileDefault?: string
): typeof IndexStatsCommand => {
  return createIndexStatsCommandDefinition(ctx, defaultOutput, indexFileDefault);
};

/**
 * Build the `index stats` command.
 * @param opts CLI options.
 * @returns CommandDefinition.
 */
export const createIndexStatsCommand = (
  opts: IndexStatsOptions = {}
): CommandDefinition =>
  defineCommand({
    path: ['index', 'stats'],
    description: 'Show summary statistics for a primitive index.',
    category: 'Index & Search',
    run: ({ ctx }: { ctx: Context }): number | Promise<number> => {
      const fmt = opts.output ?? 'text';
      const indexPath = opts.indexFile ?? defaultIndexFile(ctx.env);
      try {
        const idx = loadIndex(indexPath);
        const stats = idx.stats();
        formatOutput({
          ctx,
          command: 'index.stats',
          output: fmt,
          status: 'ok',
          data: stats,
          textRenderer: (s) => renderStatsText(s)
        });
        return Promise.resolve(0);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        const err = /ENOENT|no such file/i.test(msg)
          ? new RegistryError({
            code: 'INDEX.NOT_FOUND',
            message: `index not found: ${indexPath}`,
            hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
            cause: cause instanceof Error ? cause : undefined
          })
          : new RegistryError({
            code: 'INDEX.LOAD_FAILED',
            message: `failed to load index ${indexPath}: ${msg}`,
            cause: cause instanceof Error ? cause : undefined
          });
        return failWith(ctx, fmt, 'index.stats', err);
      }
    }
  });

const renderStatsText = (s: IndexStats): string =>
  [
    `primitives: ${String(s.primitives)}`,
    `bundles: ${String(s.bundles)}`,
    `shortlists: ${String(s.shortlists)}`,
    `byKind: ${JSON.stringify(s.byKind)}`,
    `bySource: ${JSON.stringify(s.bySource)}`,
    `builtAt: ${s.builtAt}`
  ].join('\n') + '\n';
