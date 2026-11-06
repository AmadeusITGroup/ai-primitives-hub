import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  evaluateGovernance,
} from '../../src/domain/governance';

describe('hub governance foundation v1', () => {
  it('passes warnings without a score and fails unverified errors', () => {
    const report = evaluateGovernance('hub', [{ ruleId: 'HUB002', severity: 'warning', message: 'Warning' }]);
    expect(report.verdict).toBe('pass');
    expect(report).not.toHaveProperty('score');
    expect(evaluateGovernance('hub', [{ ruleId: 'HUB001', severity: 'error', message: 'Unavailable', verified: false }]).verdict).toBe('fail');
  });

  it('rejects unknown and non-configurable rules', () => {
    for (const id of ['UNKNOWN', 'CFG001']) {
      expect(evaluateGovernance('hub', [], { rules: { [id]: { enabled: false } } }).findings)
        .toContainEqual(expect.objectContaining({ ruleId: 'CFG002' }));
    }
  });

  it('ignores the entire policy when a floor rule is downgraded', () => {
    const report = evaluateGovernance('hub', [{ ruleId: 'HUB002', severity: 'warning', message: 'Warning' }], {
      rules: { HUB001: { severity: 'warning' }, HUB002: { enabled: false } }
    });
    expect(report.verdict).toBe('fail');
    expect(report.findings.map((finding) => finding.ruleId)).toEqual(['CFG003', 'HUB002']);
    expect(report.suppressions).toEqual([]);
  });

  it('records permitted warning suppression', () => {
    const report = evaluateGovernance('hub', [{ ruleId: 'HUB002', severity: 'warning', message: 'Warning' }], {
      rules: { HUB002: { enabled: false, reason: 'Reviewed' } }
    });
    expect(report.findings).toEqual([]);
    expect(report.suppressions).toContainEqual(expect.objectContaining({ ruleId: 'HUB002', reason: 'Reviewed' }));
  });
});
