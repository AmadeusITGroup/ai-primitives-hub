/**
 * Pattern-based relevance evaluation for a live index.
 *
 * Motivation: the classic `eval.ts` harness uses frozen primitive IDs,
 * which works great for synthetic fixtures but breaks for live corpora
 * — IDs change every harvest when title/description/path shift. The
 * pattern harness expresses relevance as regex matchers over the
 * primitive's `title`, `bundleId`, and `sourceId` so the gold set is
 * resilient to content drift.
 *
 * Contract for a `PatternCase`:
 *   - `mustMatch[]`  — at least one hit in the top-k satisfies EVERY
 *                      pattern. Used for "the index is aware of X".
 *   - `shouldMatch[]`— bonus: each pattern that matches in top-k adds
 *                      to the soft score (for ranking-quality analysis).
 *
 * The returned report mirrors the `EvalReport` shape so downstream
 * tooling (markdown renderers, CI gates) can treat both harnesses
 * uniformly.
 */

import type {
  PrimitiveIndex,
} from './primitive-index';
import type {
  Primitive,
  SearchQuery,
} from './types';

export interface RelevancePattern {
  /** RegExp source matched against primitive.title (case-insensitive). */
  title?: string;
  /** RegExp source matched against primitive.bundle.bundleId. */
  bundleId?: string;
  /** RegExp source matched against primitive.bundle.sourceId. */
  sourceId?: string;
  /** RegExp source matched against primitive.kind. */
  kind?: string;
}

export interface PatternCase {
  id: string;
  query: SearchQuery;
  /** Top-k considered for must-match assertions. Default: 3. */
  k?: number;
  /** Every mustMatch pattern must be satisfied by at least one top-k hit. */
  mustMatch: RelevancePattern[];
  /** Each shouldMatch pattern satisfied adds to the soft score. */
  shouldMatch?: RelevancePattern[];
}

export interface PatternCaseReport {
  id: string;
  query: SearchQuery;
  /** Number of `mustMatch` patterns satisfied by top-k. Full pass = mustMatch.length. */
  mustSatisfied: number;
  mustTotal: number;
  /** Soft score: fraction of shouldMatch patterns satisfied by top-k. */
  soft: number;
  /** The top-k primitives returned (title, bundle, source) for inspection. */
  topK: { rank: number; id: string; title: string; bundleId: string; sourceId: string; score: number }[];
  /** Pass = every mustMatch satisfied. */
  passed: boolean;
}

export interface PatternReport {
  perCase: PatternCaseReport[];
  aggregate: {
    passed: number;
    failed: number;
    passRate: number;
    meanSoft: number;
  };
}

/**
 * Match a single pattern against a primitive. Undefined pattern fields
 * are wildcards (they match anything).
 * @param p
 * @param pat
 */
export function matchPattern(p: Primitive, pat: RelevancePattern): boolean {
  const check = (source: string, src: string | undefined): boolean => {
    if (src === undefined) {
      return true;
    }
    return new RegExp(src, 'iu').test(source);
  };
  return (
    check(p.title, pat.title)
    && check(p.bundle.bundleId, pat.bundleId)
    && check(p.bundle.sourceId, pat.sourceId)
    && check(p.kind, pat.kind)
  );
}

/**
 * Run the pattern-based golden set. Returns a report including per-case
 * must/soft scores plus the top-k primitives (for human inspection in
 * CI logs or a markdown eval report).
 * @param index
 * @param cases
 */
export function runPatternEval(index: PrimitiveIndex, cases: PatternCase[]): PatternReport {
  const perCase: PatternCaseReport[] = [];
  for (const c of cases) {
    const k = c.k ?? 3;
    const res = index.search({ ...c.query, limit: Math.max(k, c.query.limit ?? k) });
    const topK = res.hits.slice(0, k).map((h, i) => ({
      rank: i,
      id: h.primitive.id,
      title: h.primitive.title,
      bundleId: h.primitive.bundle.bundleId,
      sourceId: h.primitive.bundle.sourceId,
      score: h.score
    }));

    // mustMatch: each pattern must be satisfied by at least one top-k hit.
    let mustSatisfied = 0;
    for (const pat of c.mustMatch) {
      if (res.hits.slice(0, k).some((h) => matchPattern(h.primitive, pat))) {
        mustSatisfied += 1;
      }
    }

    // shouldMatch: fraction of patterns satisfied in top-k.
    let softHits = 0;
    const shouldMatch = c.shouldMatch ?? [];
    for (const pat of shouldMatch) {
      if (res.hits.slice(0, k).some((h) => matchPattern(h.primitive, pat))) {
        softHits += 1;
      }
    }
    const soft = shouldMatch.length > 0 ? softHits / shouldMatch.length : 0;

    perCase.push({
      id: c.id,
      query: c.query,
      mustSatisfied,
      mustTotal: c.mustMatch.length,
      soft,
      topK,
      passed: mustSatisfied === c.mustMatch.length
    });
  }

  const passed = perCase.filter((r) => r.passed).length;
  const failed = perCase.length - passed;
  const meanSoft = perCase.length > 0 ? perCase.reduce((acc, r) => acc + r.soft, 0) / perCase.length : 0;
  return {
    perCase,
    aggregate: {
      passed,
      failed,
      passRate: perCase.length > 0 ? passed / perCase.length : 0,
      meanSoft
    }
  };
}

/**
 * Render a pattern report as a compact markdown table (one row per
 * case). Easy to paste into a PR description or docs.
 * @param report
 */
export function renderPatternReportMarkdown(report: PatternReport): string {
  const lines: string[] = [
    '## Pattern-based eval report',
    '',
    `- Cases: ${report.perCase.length}`,
    `- **Passed: ${report.aggregate.passed} / ${report.perCase.length}** (${(report.aggregate.passRate * 100).toFixed(1)}%)`,
    `- Failed: ${report.aggregate.failed}`,
    `- Mean soft score: ${(report.aggregate.meanSoft * 100).toFixed(1)}%`,
    '',
    '| # | Query | k | Must | Soft | Top-1 | Status |',
    '|---|-------|--:|-----:|-----:|-------|--------|'
  ];
  for (const [i, r] of report.perCase.entries()) {
    const q = r.query.q ?? '(filter-only)';
    const top = r.topK[0];
    const topStr = top ? `${top.title} (${top.bundleId})` : '—';
    const status = r.passed ? '✓' : '✗';
    const k = r.topK.length;
    lines.push(`| ${i + 1} | \`${q}\` | ${k} | ${r.mustSatisfied}/${r.mustTotal} | ${(r.soft * 100).toFixed(0)}% | ${topStr} | ${status} |`);
  }
  return lines.join('\n') + '\n';
}
