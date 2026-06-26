/**
 * `prompt-registry index eval` — pattern-based relevance eval.
 *
 * Replaces the legacy `primitive-index eval-pattern` verb. Loads a
 * gold-set JSON file with `cases[]: PatternCase` and runs every
 * query against the index, reporting must-match satisfaction per
 * case + aggregated pass-rate. Exits non-zero when any case fails
 * so CI can gate ranking quality.
 * @module cli/commands/index-eval
 */
import * as fs from 'node:fs';
import {
  defaultIndexFile,
  loadIndex,
} from '@prompt-registry/infra';
import {
  type PatternCase,
  type PatternReport,
  renderPatternReportMarkdown,
  runPatternEval,
} from '@prompt-registry/infra';
import {
  Command,
  type CommandDefinition,
  type Context,
  defineCommand,
  failWith,
  formatOutput,
  getCommandContext,
  Option,
  type OutputFormat,
  RegistryError,
} from '../framework';

export interface IndexEvalOptions {
  output?: OutputFormat;
  /** Path to the index JSON. */
  indexFile?: string;
  /** Path to the gold-set JSON file. Required. */
  goldFile: string;
}

/**
 * Build the `index eval` command.
 * @param opts CLI options.
 * @returns CommandDefinition.
 */
export const createIndexEvalCommand = (
  opts: IndexEvalOptions
): CommandDefinition =>
  defineCommand({
    path: ['index', 'eval'],
    description: 'Run pattern-based relevance eval against an index.',
    category: 'Index & Search',
    // eslint-disable-next-line @typescript-eslint/require-await -- Intentionally async for interface compatibility
    run: async ({ ctx }: { ctx: Context }): Promise<number> => {
      const fmt = opts.output ?? 'text';
      if (opts.goldFile.length === 0) {
        return failWith(ctx, fmt, 'index.eval', new RegistryError({
          code: 'USAGE.MISSING_FLAG',
          message: 'index eval: --gold <FILE> is required'
        }));
      }
      const indexPath = opts.indexFile ?? defaultIndexFile(ctx.env);
      let report: PatternReport;
      try {
        const idx = loadIndex(indexPath);
        const raw = fs.readFileSync(opts.goldFile, 'utf8');
        const parsed = JSON.parse(raw) as { cases: PatternCase[] };
        report = runPatternEval(idx, parsed.cases);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        const err = /ENOENT|no such file/i.test(msg)
          ? new RegistryError({
            code: 'INDEX.NOT_FOUND',
            message: `index eval: missing file (${msg})`,
            hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
            cause: cause instanceof Error ? cause : undefined
          })
          : new RegistryError({
            code: 'INDEX.EVAL_FAILED',
            message: `index eval failed: ${msg}`,
            cause: cause instanceof Error ? cause : undefined
          });
        return failWith(ctx, fmt, 'index.eval', err);
      }
      formatOutput({
        ctx, command: 'index.eval', output: fmt, status: 'ok',
        data: report,
        textRenderer: (r) => renderPatternReportMarkdown(r)
      });
      // Non-zero exit when any case failed so CI treats it as a fail.
      return report.aggregate.failed > 0 ? 1 : 0;
    }
  });

/**
 * Index eval command class.
 * Runs pattern-based relevance eval against an index.
 */
export class IndexEvalCommand extends Command {
  public static readonly paths = [['index', 'eval']];

  public static readonly usage = Command.Usage({
    description: 'Run pattern-based relevance eval against an index.',
    category: 'Index & Search',
    details: `
      Usage: prompt-registry index eval --gold <FILE> [options]

      Examples:
        prompt-registry index eval --gold golden-queries.json
        prompt-registry index eval --gold golden-queries.json --index /tmp/index.json
    `
  });

  public gold = Option.String('--gold');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');

  public execute(): Promise<number> {
    const ctx = getCommandContext(this);

    const fmt = (this.output ?? 'text') as OutputFormat;

    if (!this.gold || this.gold.length === 0) {
      return Promise.resolve(failWith(ctx, fmt, 'index.eval', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'index eval: --gold <FILE> is required'
      })));
    }

    const indexPath = this.index ?? defaultIndexFile(ctx.env);

    let report: PatternReport;
    try {
      const idx = loadIndex(indexPath);
      const raw = fs.readFileSync(this.gold, 'utf8');
      const parsed = JSON.parse(raw) as { cases: PatternCase[] };
      report = runPatternEval(idx, parsed.cases);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      const err = /ENOENT|no such file/i.test(msg)
        ? new RegistryError({
          code: 'INDEX.NOT_FOUND',
          message: `index eval: missing file (${msg})`,
          hint: 'Run `prompt-registry index build` or `prompt-registry index harvest` first.',
          cause: cause instanceof Error ? cause : undefined
        })
        : new RegistryError({
          code: 'INDEX.EVAL_FAILED',
          message: `index eval failed: ${msg}`,
          cause: cause instanceof Error ? cause : undefined
        });
      return Promise.resolve(failWith(ctx, fmt, 'index.eval', err));
    }

    formatOutput({
      ctx, command: 'index.eval', output: fmt, status: 'ok',
      data: report,
      textRenderer: (r) => renderPatternReportMarkdown(r)
    });

    // Non-zero exit when any case failed so CI treats it as a fail.
    return Promise.resolve(report.aggregate.failed > 0 ? 1 : 0);
  }
}
