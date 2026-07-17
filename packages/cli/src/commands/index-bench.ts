/**
 * `index bench` — search microbenchmark.
 *
 * Loads a gold-set JSON file (same shape as `index eval`) and runs
 * each query N times against the loaded index, reporting per-query
 * median/p95/max plus aggregate QPS.
 * @module commands/index-bench
 */
import * as fs from 'node:fs';
import {
  defaultIndexFile,
  loadIndex,
} from '@ai-primitives-hub/infra';
import {
  type BenchCase,
  renderBenchReportMarkdown,
  runBench,
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
 * Index bench command class.
 * Runs a search microbenchmark over a gold-set against an index.
 */
export class IndexBenchCommand extends Command {
  public static readonly paths = [['index', 'bench']];

  public static readonly usage = Command.Usage({
    description: 'Run a search microbenchmark over a gold-set against an index.',
    category: 'Index & Search',
    details: `
      Usage: ai-primitives-hub index bench --gold <FILE> [options]

      Examples:
        ai-primitives-hub index bench --gold golden-queries.json
        ai-primitives-hub index bench --gold golden-queries.json --index /tmp/index.json
        ai-primitives-hub index bench --gold golden-queries.json --iterations 100
    `
  });

  public gold = Option.String('--gold');
  public index = Option.String('--index');
  public iterations = Option.String('--iterations');
  public output = Option.String('-o,--output');
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;

    const fmt = (this.output ?? 'text') as OutputFormat;

    if (!this.gold || this.gold.length === 0) {
      return Promise.resolve(failWith(ctx, fmt, 'index.bench', new RegistryError({
        code: 'USAGE.MISSING_FLAG',
        message: 'index bench: --gold <FILE> is required'
      })));
    }

    const indexPath = this.index ?? defaultIndexFile(ctx.env);
    const iterations = this.iterations ? Number.parseInt(this.iterations, 10) : 50;

    try {
      const idx = loadIndex(indexPath);
      const raw = fs.readFileSync(this.gold, 'utf8');
      const parsed = JSON.parse(raw) as { cases: { id: string; query: BenchCase['query'] }[] };
      const cases: BenchCase[] = parsed.cases.map((c) => ({ id: c.id, query: c.query }));
      const report = runBench(idx, cases, iterations);
      formatOutput({
        ctx, command: 'index.bench', output: fmt, status: 'ok',
        data: report,
        textRenderer: (r) => renderBenchReportMarkdown(r)
      });
      return Promise.resolve(0);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      const err = /ENOENT|no such file/i.test(msg)
        ? new RegistryError({
          code: 'INDEX.NOT_FOUND',
          message: `index bench: missing file (${msg})`,
          hint: 'Run `ai-primitives-hub index build` or `ai-primitives-hub index harvest` first.',
          cause: cause instanceof Error ? cause : undefined
        })
        : new RegistryError({
          code: 'INDEX.BENCH_FAILED',
          message: `index bench failed: ${msg}`,
          cause: cause instanceof Error ? cause : undefined
        });
      return Promise.resolve(failWith(ctx, fmt, 'index.bench', err));
    }
  }
}
