/**
 * `index eval` — pattern-based relevance eval.
 *
 * Loads a gold-set JSON file with `cases[]: PatternCase` and runs
 * every query against the index, reporting must-match satisfaction
 * per case + aggregated pass-rate. Exits non-zero when any case fails
 * so CI can gate ranking quality.
 * @module commands/index-eval
 */
import * as fs from 'node:fs';
import {
  defaultIndexFile,
  loadIndex,
} from '@ai-primitives-hub/infra';
import {
  type PatternCase,
  type PatternReport,
  renderPatternReportMarkdown,
  runPatternEval,
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
 * Index eval command class.
 * Runs pattern-based relevance eval against an index.
 */
export class IndexEvalCommand extends Command {
  public static readonly paths = [['index', 'eval']];

  public static readonly usage = Command.Usage({
    description: 'Run pattern-based relevance eval against an index.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index eval --gold <FILE> [options]

      Examples:
        ai-primitives-hub index eval --gold golden-queries.json
        ai-primitives-hub index eval --gold golden-queries.json --index /tmp/index.json
    `
  });

  public gold = Option.String('--gold');
  public index = Option.String('--index');
  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;

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
          hint: 'Run `ai-primitives-hub index build` or `ai-primitives-hub index harvest` first.',
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
