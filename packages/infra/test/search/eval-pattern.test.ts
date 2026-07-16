import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  matchPattern,
  type PatternCase,
  renderPatternReportMarkdown,
  runPatternEval,
} from '../../src/search/eval-pattern';
import {
  PrimitiveIndex,
} from '../../src/search/primitive-index';
import type {
  BundleRef,
  Primitive,
} from '../../src/search/types';

function mkBundle(sourceId: string, bundleId: string): BundleRef {
  return { sourceId, sourceType: 'github', bundleId, bundleVersion: 'x', installed: false };
}

function mkPrimitive(overrides: Partial<Primitive> & { id: string; title: string }): Primitive {
  return {
    id: overrides.id,
    bundle: overrides.bundle ?? mkBundle('src', 'bundle'),
    kind: overrides.kind ?? 'skill',
    path: overrides.path ?? 'somewhere',
    title: overrides.title,
    description: overrides.description ?? '',
    tags: overrides.tags ?? [],
    bodyPreview: overrides.bodyPreview ?? '',
    contentHash: overrides.contentHash ?? 'h'
  };
}

describe('eval-pattern', () => {
  it('matchPattern treats undefined pattern fields as wildcards', () => {
    const p = mkPrimitive({ id: 'a', title: 'code-review', bundle: mkBundle('src1', 'b1') });
    expect(matchPattern(p, { title: 'code-review' })).toBe(true);
    expect(matchPattern(p, { bundleId: 'b1' })).toBe(true);
    expect(matchPattern(p, { title: 'code-review', bundleId: 'b1' })).toBe(true);
    expect(matchPattern(p, { title: 'nope' })).toBe(false);
    expect(matchPattern(p, {}), 'empty pattern = wildcard').toBe(true);
  });

  it('matchPattern uses case-insensitive regex', () => {
    const p = mkPrimitive({ id: 'a', title: 'Code-Review' });
    expect(matchPattern(p, { title: 'code-review' })).toBe(true);
    expect(matchPattern(p, { title: 'CODE' })).toBe(true);
  });

  it('runPatternEval reports mustMatch/soft + passed flags', () => {
    const idx = PrimitiveIndex.fromPrimitives([
      mkPrimitive({ id: 'p1', title: 'code-review', kind: 'skill', bundle: mkBundle('rail', 'rail-context'), description: 'Review code changes' }),
      mkPrimitive({ id: 'p2', title: 'typescript-mcp-server-generator', kind: 'skill', bundle: mkBundle('ac', 'typescript-mcp-development'), description: 'Generate a typescript MCP server' }),
      mkPrimitive({ id: 'p3', title: 'unrelated-thing', kind: 'prompt', bundle: mkBundle('other', 'other'), description: 'totally different topic' })
    ]);
    const cases: PatternCase[] = [
      {
        id: 'code-review',
        query: { q: 'code review' },
        mustMatch: [{ title: 'code-review' }],
        shouldMatch: [{ kind: 'skill' }, { sourceId: 'rail' }]
      },
      {
        id: 'typescript-mcp',
        query: { q: 'typescript mcp' },
        mustMatch: [{ title: 'typescript-mcp-server-generator' }, { bundleId: 'typescript-mcp-development' }]
      },
      {
        id: 'impossible',
        query: { q: 'code review' },
        mustMatch: [{ title: 'does-not-exist' }]
      }
    ];
    const report = runPatternEval(idx, cases);
    expect(report.perCase.length).toBe(3);
    expect(report.perCase[0].passed).toBe(true);
    expect(report.perCase[0].mustSatisfied).toBe(1);
    expect(report.perCase[0].soft).toBe(1);
    expect(report.perCase[1].passed).toBe(true);
    expect(report.perCase[1].mustSatisfied).toBe(2);
    expect(report.perCase[2].passed).toBe(false);
    expect(report.aggregate.passed).toBe(2);
    expect(report.aggregate.failed).toBe(1);
    expect(Math.abs(report.aggregate.passRate - 2 / 3)).toBeLessThan(1e-9);
  });

  it('renderPatternReportMarkdown produces a parseable table with ✓/✗', () => {
    const idx = PrimitiveIndex.fromPrimitives([
      mkPrimitive({ id: 'p1', title: 'code-review', bundle: mkBundle('rail', 'rail-context'), description: 'review the code' })
    ]);
    const report = runPatternEval(idx, [
      { id: 'code-review', query: { q: 'code review' }, mustMatch: [{ title: 'code-review' }] }
    ]);
    const md = renderPatternReportMarkdown(report);
    expect(md.includes('Pattern-based eval report')).toBe(true);
    expect(md.includes('Passed: 1 / 1')).toBe(true);
    expect(md.includes('100.0%')).toBe(true);
    expect(md.includes('✓')).toBe(true);
  });
});
