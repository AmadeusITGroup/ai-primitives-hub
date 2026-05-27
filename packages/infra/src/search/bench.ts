/**
 * Search microbenchmark harness.
 *
 * Runs the golden-set queries repeatedly against a loaded index,
 * reporting per-query median/p95/max wall time plus overall throughput
 * (QPS). Intended for (a) catching ranking regressions in CI and (b)
 * answering the operational question "how many queries/s can I expect
 * in the extension QuickPick loop?".
 *
 * Zero dependencies on GitHub / the file system besides an already-
 * loaded `PrimitiveIndex`.
 */

import type {
  PrimitiveIndex,
} from './primitive-index';
import type {
  SearchQuery,
} from './types';

export interface BenchCase {
  id: string;
  query: SearchQuery;
}

export interface BenchCaseResult {
  id: string;
  total: number;
  iterations: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface BenchReport {
  perCase: BenchCaseResult[];
  aggregate: {
    iterations: number;
    totalQueries: number;
    totalWallMs: number;
    qps: number;
    medianMs: number;
    p95Ms: number;
  };
}

/**
 * Run each case `iterations` times, collecting per-call timing.
 * Timing uses `performance.now()` so sub-millisecond precision is kept.
 * @param index    Loaded primitive index.
 * @param cases    Queries to benchmark.
 * @param iterations Repetitions per case. Default 50 — high enough to
 *                 smooth out GC jitter without ballooning runtime for
 *                 small indices.
 */
export function runBench(index: PrimitiveIndex, cases: BenchCase[], iterations = 50): BenchReport {
  const allMs: number[] = [];
  const perCase: BenchCaseResult[] = [];
  const startAll = performance.now();

  for (const c of cases) {
    const times: number[] = [];
    let total = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = index.search(c.query);
      const t1 = performance.now();
      total = res.total;
      times.push(t1 - t0);
      allMs.push(t1 - t0);
    }
    const sortedTimes = times.toSorted((a, b) => a - b);
    const median = percentile(sortedTimes, 0.5);
    const p95 = percentile(sortedTimes, 0.95);
    // times.length >= 1 (we ran at least one iteration); the fallback
    // keeps the type checker happy without changing the runtime value.
    const max = sortedTimes.at(-1) ?? 0;
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    perCase.push({ id: c.id, total, iterations, medianMs: median, p95Ms: p95, maxMs: max, meanMs: mean });
  }

  const totalWallMs = performance.now() - startAll;
  const sortedAllMs = allMs.toSorted((a, b) => a - b);
  const totalQueries = perCase.reduce((acc, c) => acc + c.iterations, 0);
  return {
    perCase,
    aggregate: {
      iterations,
      totalQueries,
      totalWallMs,
      qps: totalQueries / (totalWallMs / 1000),
      medianMs: percentile(sortedAllMs, 0.5),
      p95Ms: percentile(sortedAllMs, 0.95)
    }
  };
}

/**
 * Render a bench report as markdown — per-case table + aggregate line.
 * Useful for PR descriptions and CI logs.
 * @param r
 */
export function renderBenchReportMarkdown(r: BenchReport): string {
  const lines: string[] = [
    '## Search microbenchmark',
    '',
    `- Iterations per case: ${r.aggregate.iterations}`,
    `- Total queries: ${r.aggregate.totalQueries}`,
    `- Total wall: ${r.aggregate.totalWallMs.toFixed(1)} ms`,
    `- **Throughput: ${r.aggregate.qps.toFixed(0)} queries/sec**`,
    `- Global median: ${r.aggregate.medianMs.toFixed(3)} ms  /  p95: ${r.aggregate.p95Ms.toFixed(3)} ms`,
    '',
    '| Query | Hits | Median (ms) | p95 (ms) | Max (ms) |',
    '|-------|-----:|------------:|---------:|---------:|'
  ];
  for (const c of r.perCase) {
    lines.push(`| \`${c.id}\` | ${c.total} | ${c.medianMs.toFixed(3)} | ${c.p95Ms.toFixed(3)} | ${c.maxMs.toFixed(3)} |`);
  }
  return lines.join('\n') + '\n';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) {
    return sorted[lo];
  }
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}
