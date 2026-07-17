/**
 * `index stats` — summary stats for a primitive index.
 *
 * Output goes through `formatOutput` so `-o json|yaml|ndjson` all
 * produce the canonical envelope.
 * @module commands/index-stats
 */
import type {
  IndexStats,
} from '@ai-primitives-hub/infra';
import {
  defaultIndexFile,
  loadIndex,
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
 * Index stats command class.
 */
export class IndexStatsCommand extends Command {
  public static readonly paths = [['index', 'stats']];

  public static readonly usage = Command.Usage({
    description: 'Show summary statistics for a primitive index.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index stats [options]

      Options:
        -o, --output <format>  Output format (text, json, yaml, ndjson)
        --index <path>         Path to index JSON (default: XDG cache/primitive-index.json)
    `
  });

  public output = Option.String('-o,--output');
  public indexFile = Option.String('--index');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = (this.output ?? 'text') as OutputFormat;
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
      return Promise.resolve(0);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      const err = /ENOENT|no such file/i.test(msg)
        ? new RegistryError({
          code: 'INDEX.NOT_FOUND',
          message: `index not found: ${indexPath}`,
          hint: 'Run `ai-primitives-hub index build` or `ai-primitives-hub index harvest` first.',
          cause: cause instanceof Error ? cause : undefined
        })
        : new RegistryError({
          code: 'INDEX.LOAD_FAILED',
          message: `failed to load index ${indexPath}: ${msg}`,
          cause: cause instanceof Error ? cause : undefined
        });
      return Promise.resolve(failWith(ctx, fmt, 'index.stats', err));
    }
  }
}

const renderStatsText = (s: IndexStats): string =>
  [
    `primitives: ${String(s.primitives)}`,
    `bundles: ${String(s.bundles)}`,
    `shortlists: ${String(s.shortlists)}`,
    `byKind: ${JSON.stringify(s.byKind)}`,
    `bySource: ${JSON.stringify(s.bySource)}`,
    `builtAt: ${s.builtAt}`
  ].join('\n') + '\n';
