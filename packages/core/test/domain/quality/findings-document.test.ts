import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseFindingsDocument,
  recommendedFixFor,
} from '../../../src/domain/quality';

describe('parseFindingsDocument', () => {
  const entry = { ruleId: 'HKS-001', title: 'Remote Shell Pipe', severity: 'high', confidence: 'medium', file: 'a.md', line: 4, recommendedFix: 'Pin it' };

  it('reads an object with a findings array and normalises severity and confidence', () => {
    expect(parseFindingsDocument({ findings: [entry] })).toEqual({
      skipped: 0,
      findings: [{ ruleId: 'HKS-001', title: 'Remote Shell Pipe', severity: 'HIGH', confidence: 'MEDIUM', file: 'a.md', line: 4, recommendedFix: 'Pin it' }]
    });
  });

  it('reads a bare array and applies defaults for optional fields', () => {
    const { findings } = parseFindingsDocument([{ ruleId: 'MD-002', severity: 'LOW', file: 'b.md' }]);
    expect(findings).toEqual([{ ruleId: 'MD-002', title: 'MD-002', severity: 'LOW', confidence: 'HIGH', file: 'b.md' }]);
  });

  it('reads the snake_case names of the security scan report', () => {
    const { findings } = parseFindingsDocument({
      findings: [{ rule_id: 'HKS-001', title: 'Remote Shell Pipe', severity: 'CRITICAL', confidence: 'HIGH', file: 'a.md', line: 3, recommended_fix: 'Pin it' }]
    });
    expect(findings).toEqual([{ ruleId: 'HKS-001', title: 'Remote Shell Pipe', severity: 'CRITICAL', confidence: 'HIGH', file: 'a.md', line: 3, recommendedFix: 'Pin it' }]);
  });

  it('skips and counts entries that cannot be rated', () => {
    const result = parseFindingsDocument([entry, null, 'text', { ...entry, ruleId: '' }, { ...entry, file: '' }, { ...entry, severity: 'SEVERE' }]);
    expect(result.findings).toHaveLength(1);
    expect(result.skipped).toBe(5);
  });

  it('rejects a document without findings', () => {
    expect(() => parseFindingsDocument({ other: [] })).toThrow(TypeError);
    expect(() => parseFindingsDocument('findings')).toThrow(TypeError);
  });
});

describe('recommendedFixFor', () => {
  it('prefers an exact rule, then the rule family, then a generic hint', () => {
    expect(recommendedFixFor('HKS-001')).toContain('pipe a download into a shell');
    expect(recommendedFixFor('SEC-999')).toContain('revoke or rotate');
    expect(recommendedFixFor('ZZZ-001')).toContain('Review the finding');
  });
});
