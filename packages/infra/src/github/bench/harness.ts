/**
 * Microbenchmark harness for the shared GitHub middleware.
 *
 * Drives `GitHubClient` and `AssetFetcher` against deterministic fake
 * fetches to measure marshal/parse overhead and cache effectiveness.
 * Mirrors the shape of `primitive-index/bench.ts` so the report
 * format is consistent across the codebase.
 *
 * Five standard cases (see `cases.ts`):
 *   1. cold              — single GET against fresh client
 *   2. warm-etag-304     — conditional GET hitting 304 path
 *   3. blob-cache-hit    — repeated AssetFetcher with inline-bytes
 *   4. transient-5xx     — GET that retries once on 503
 *   5. rate-limit        — GET that observes primary rate-limit
 *
 * Thresholds (asserted by the test wrapper, configurable per case):
 *   - cold              < 5 ms
 *   - warm-etag-304     < 100 µs
 *   - blob-cache-hit    < 50 µs
 *   - transient-5xx     < 5 ms (retry sleep mocked to 0)
 *   - rate-limit        < 5 ms (sleep mocked to 0)
 * @module github/bench/harness
 */

export interface BenchCase {
  id: string;
  description: string;
  /** Run the case once. Throws if the case is structurally broken. */
  run: () => Promise<void>;
  /** p95 ceiling in ms. */
  thresholdMs: number;
}

export interface BenchCaseResult {
  id: string;
  description: string;
  iterations: number;
  thresholdMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  passed: boolean;
}

export interface BenchReport {
  perCase: BenchCaseResult[];
  aggregate: {
    iterations: number;
    totalCases: number;
    totalWallMs: number;
    medianMs: number;
    p95Ms: number;
    allPassed: boolean;
  };
}

/**
 * Run each case `iterations` times and report median/p95/max + a
 * pass/fail per case based on its threshold.
 * @param cases Bench cases to execute.
 * @param iterations Repetitions per case (default 200).
 * @returns Aggregated `BenchReport`.
 */
export const runBench = async (
  cases: readonly BenchCase[],
  iterations = 200
): Promise<BenchReport> => {
  const allMs: number[] = [];
  const perCase: BenchCaseResult[] = [];
  const startAll = performance.now();
  for (const c of cases) {
    const times: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const t0 = performance.now();
      await c.run();
      const t1 = performance.now();
      times.push(t1 - t0);
      allMs.push(t1 - t0);
    }
    const sortedTimes = times.toSorted((a, b) => a - b);
    const median = percentile(sortedTimes, 0.5);
    const p95 = percentile(sortedTimes, 0.95);
    const max = sortedTimes.at(-1) ?? 0;
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    perCase.push({
      id: c.id,
      description: c.description,
      iterations,
      thresholdMs: c.thresholdMs,
      medianMs: median,
      p95Ms: p95,
      maxMs: max,
      meanMs: mean,
      passed: p95 <= c.thresholdMs
    });
  }
  const totalWallMs = performance.now() - startAll;
  const sortedAllMs = allMs.toSorted((a, b) => a - b);
  return {
    perCase,
    aggregate: {
      iterations,
      totalCases: perCase.length,
      totalWallMs,
      medianMs: percentile(sortedAllMs, 0.5),
      p95Ms: percentile(sortedAllMs, 0.95),
      allPassed: perCase.every((c) => c.passed)
    }
  };
};

/**
 * Render a bench report as markdown — per-case table + aggregate.
 * @param r BenchReport to render.
 * @returns Markdown string.
 */
export const renderBenchReport = (r: BenchReport): string => {
  const lines: string[] = [
    '## github middleware microbenchmark',
    '',
    `- Iterations per case: ${String(r.aggregate.iterations)}`,
    `- Total cases: ${String(r.aggregate.totalCases)}`,
    `- Total wall: ${r.aggregate.totalWallMs.toFixed(1)} ms`,
    `- Global median: ${r.aggregate.medianMs.toFixed(3)} ms  /  p95: ${r.aggregate.p95Ms.toFixed(3)} ms`,
    `- **All thresholds met: ${r.aggregate.allPassed ? 'YES ✓' : 'NO ✗'}**`,
    '',
    '| Case | Description | Median (ms) | p95 (ms) | Max (ms) | Threshold (ms) | Result |',
    '|------|-------------|------------:|---------:|---------:|---------------:|:------:|'
  ];
  for (const c of r.perCase) {
    lines.push(
      `| \`${c.id}\` | ${c.description} | ${c.medianMs.toFixed(3)} | ${c.p95Ms.toFixed(3)} `
      + `| ${c.maxMs.toFixed(3)} | ${c.thresholdMs.toFixed(3)} | ${c.passed ? '✓' : '✗'} |`
    );
  }
  return lines.join('\n') + '\n';
};

const percentile = (sorted: number[], p: number): number => {
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
};
