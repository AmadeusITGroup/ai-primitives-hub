import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type BenchCase,
  renderBenchReportMarkdown,
  runBench,
} from '../../src/search/bench';
import {
  PrimitiveIndex,
} from '../../src/search/primitive-index';
import type {
  BundleRef,
  Primitive,
} from '../../src/search/types';

function mkP(id: string, title: string, desc = ''): Primitive {
  const bundle: BundleRef = { sourceId: 's', sourceType: 'github', bundleId: 'b', bundleVersion: 'v', installed: false };
  return { id, bundle, kind: 'skill', path: '.', title, description: desc, tags: [], bodyPreview: '', contentHash: id };
}

describe('bench', () => {
  it('returns per-case + aggregate timing, with non-zero qps', () => {
    const idx = PrimitiveIndex.fromPrimitives([
      mkP('a', 'code-review', 'review code'),
      mkP('b', 'typescript-mcp', 'typescript mcp'),
      mkP('c', 'azure-pricing', 'azure price')
    ]);
    const cases: BenchCase[] = [
      { id: 'q1', query: { q: 'code' } },
      { id: 'q2', query: { q: 'azure' } }
    ];
    const r = runBench(idx, cases, 5);
    expect(r.perCase.length).toBe(2);
    expect(r.perCase[0].iterations).toBe(5);
    expect(r.aggregate.totalQueries).toBe(10);
    expect(r.aggregate.qps).toBeGreaterThan(0);
    for (const c of r.perCase) {
      expect(c.medianMs).toBeLessThanOrEqual(c.p95Ms + 1e-9);
      expect(c.p95Ms).toBeLessThanOrEqual(c.maxMs + 1e-9);
    }
  });

  it('renderBenchReportMarkdown emits a parseable table', () => {
    const idx = PrimitiveIndex.fromPrimitives([mkP('a', 'code-review')]);
    const r = runBench(idx, [{ id: 'q1', query: { q: 'code' } }], 3);
    const md = renderBenchReportMarkdown(r);
    expect(md.includes('Search microbenchmark')).toBe(true);
    expect(md.includes('Throughput:')).toBe(true);
    expect(md.includes('| `q1` | 1 |')).toBe(true);
  });
});
