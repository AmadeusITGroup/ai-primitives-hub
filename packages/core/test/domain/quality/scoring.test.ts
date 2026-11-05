import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  classifyPath,
  DEFAULT_SCORING_WEIGHTS,
  gateFailed,
  gateScoreLimit,
  type QualityFinding,
  riskFromScore,
  scoreFindings,
  scoreFromPenalty,
} from '../../../src/domain/quality';

type ScoredInput = Pick<QualityFinding, 'ruleId' | 'severity' | 'confidence' | 'file' | 'line'>;

const finding = (overrides: Partial<ScoredInput> = {}): ScoredInput => ({
  ruleId: 'HKS-001',
  severity: 'HIGH',
  confidence: 'HIGH',
  file: 'skills/a/SKILL.md',
  line: 1,
  ...overrides
});

const points = (...findings: ScoredInput[]): number[] => scoreFindings(findings).points;

describe('quality scoring', () => {
  describe('points per finding', () => {
    it('costs the severity points at full strength', () => {
      expect((['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const)
        .map((severity) => points(finding({ severity }))[0])).toEqual([40, 20, 8, 3, 0]);
    });

    it('scales by confidence', () => {
      expect((['HIGH', 'MEDIUM', 'LOW'] as const)
        .map((confidence) => points(finding({ confidence }))[0])).toEqual([20, 10, 5]);
    });

    it('scales by location without dropping the finding', () => {
      expect(points(finding({ file: 'README.md' }))[0]).toBe(5);
      expect(points(finding({ file: 'docs/guide.md' }))[0]).toBe(5);
      expect(points(finding({ file: 'change-logs/CHANGELOG_4.0.md' }))[0]).toBe(5);
      expect(points(finding({ file: '.yarn/releases/yarn-4.cjs' }))[0]).toBe(2);
      expect(points(finding({ file: 'app/node_modules/x/index.js' }))[0]).toBe(2);
      expect(points(finding({ file: 'public/app.min.js' }))[0]).toBe(2);
      expect(points(finding({ file: 'scripts/install.sh' }))[0]).toBe(20);
    });

    it('classifies Windows separators and case', () => {
      expect(classifyPath('Docs\\Guide.MD')).toBe('doc');
      expect(classifyPath('SKILLS\\a\\SKILL.md')).toBe('primitive');
    });

    it('costs known over-reporting rules less, not nothing', () => {
      expect(points(finding({ ruleId: 'MD-001' }))[0]).toBe(5);
    });

    it('decays repeats of a rule in one file', () => {
      const repeated = [1, 2, 3, 4, 5, 6].map((line) => finding({ line }));
      expect(points(...repeated)).toEqual([20, 10, 5, 5, 5, 5]);
    });

    it('restarts the decay for another file or another rule', () => {
      expect(points(finding(), finding({ file: 'skills/b/SKILL.md' }), finding({ ruleId: 'HKS-002' }))).toEqual([20, 20, 20]);
    });

    it('returns points in input order', () => {
      expect(points(finding({ line: 5 }), finding({ line: 1 }))).toEqual([10, 20]);
    });
  });

  describe('score and risk', () => {
    it('follows the curve from the penalty', () => {
      expect(scoreFindings([]).score).toBe(100);
      const bySeverity = (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const)
        .map((severity) => scoreFindings([finding({ severity })]).score);
      expect(bySeverity).toEqual([93, 82, 61, 37]);
    });

    it('lowers the score with each extra finding and floors at zero', () => {
      const scores = [1, 2, 3, 10].map((count) => scoreFindings(
        Array.from({ length: count }, (_, index) => finding({ severity: 'CRITICAL', file: `a${String(index)}.md` }))
      ).score);
      expect(scores).toEqual([37, 14, 5, 0]);
      expect(scoreFromPenalty(10_000)).toBe(0);
    });

    it('keeps a bundle of weak findings above zero', () => {
      const weak = Array.from({ length: 39 }, (_, index) => finding({ file: 'change-logs/CHANGELOG.md', line: index + 1 }));
      expect(scoreFindings(weak).score).toBeGreaterThan(0);
    });

    it('labels the risk as a band of the score', () => {
      const risks = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const)
        .map((severity) => scoreFindings([finding({ severity })]).risk);
      expect(risks).toEqual(['critical', 'high', 'medium', 'low']);
      expect(scoreFindings([finding({ severity: 'CRITICAL', confidence: 'MEDIUM' })]).risk).toBe('high');
      expect(scoreFindings([finding({ severity: 'CRITICAL', file: 'README.md' })]).risk).toBe('medium');
      expect(scoreFindings([]).risk).toBe('low');
    });

    it('never gives a higher score a higher risk', () => {
      const rank = { low: 1, medium: 2, high: 3, critical: 4 } as const;
      const ranks = Array.from({ length: 101 }, (_, score) => rank[riskFromScore(score) as keyof typeof rank]);
      expect(ranks).toEqual([...ranks].toSorted((a, b) => b - a));
      expect(riskFromScore(null)).toBe('unknown');
      expect([100, 90, 89, 70, 69, 40, 39, 0].map((score) => riskFromScore(score)))
        .toEqual(['low', 'low', 'medium', 'medium', 'high', 'high', 'critical', 'critical']);
    });
  });

  describe('gate', () => {
    it('uses the band edges as limits', () => {
      expect((['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((level) => gateScoreLimit(level))).toEqual([40, 70, 90, 100]);
    });

    it('fails exactly when the risk label reaches the fail-on level', () => {
      const result = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((severity) => {
        const scored = scoreFindings([finding({ severity })]);
        return { risk: scored.risk, failsHigh: gateFailed(scored.score, 'HIGH') };
      });
      expect(result).toEqual([
        { risk: 'critical', failsHigh: true },
        { risk: 'high', failsHigh: true },
        { risk: 'medium', failsHigh: false },
        { risk: 'low', failsHigh: false }
      ]);
    });

    it('never fails when off, unscored or clean', () => {
      expect(gateFailed(0, 'none')).toBe(false);
      expect(gateFailed(null, 'CRITICAL')).toBe(false);
      expect(gateFailed(100, 'LOW')).toBe(false);
    });
  });

  it('exposes the default weights', () => {
    expect(DEFAULT_SCORING_WEIGHTS.curveScale).toBe(40);
    expect(DEFAULT_SCORING_WEIGHTS.riskBands).toEqual({ low: 90, medium: 70, high: 40 });
  });
});

describe('quality scoring edge cases', () => {
  it('scores a rule id that names an Object member at full weight', () => {
    const [value] = points(finding({ ruleId: 'toString', severity: 'CRITICAL' }));
    expect(value).toBe(40);
  });

  it('does not depend on the input order of findings that share rule, file and line', () => {
    const critical = finding({ severity: 'CRITICAL' });
    const medium = finding({ severity: 'MEDIUM' });
    const total = (...items: ScoredInput[]): number => scoreFindings(items).penalty;
    expect(total(critical, medium)).toBe(total(medium, critical));
  });
});
