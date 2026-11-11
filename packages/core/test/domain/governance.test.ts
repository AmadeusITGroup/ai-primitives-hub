import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  evaluateGovernance,
} from '../../src/domain/governance';

describe('governance verdict', () => {
  it('fails when errors accompany warnings', () => {
    const result = evaluateGovernance('hub', [
      { ruleId: 'HUB001', severity: 'error', message: 'invalid' },
      { ruleId: 'HUB002', severity: 'warning', message: 'advisory' }
    ]);
    expect(result).toMatchObject({ verdict: 'fail' });
  });

  it('passes with an unverified warning', () => {
    expect(evaluateGovernance('hub', [{ ruleId: 'HUB002', severity: 'warning', message: 'unavailable', verified: false }])).toMatchObject({ verdict: 'pass' });
  });

  it('retains all errors in a failing report', () => {
    const findings = Array.from({ length: 12 }, (_, index) => ({ ruleId: 'HUB001', severity: 'error' as const, message: String(index) }));
    expect(evaluateGovernance('hub', findings)).toMatchObject({ verdict: 'fail', findings });
  });

  it('records severity overrides and changes the verdict without hiding findings', () => {
    const result = evaluateGovernance('collection', [{ ruleId: 'COL003', severity: 'error', message: 'missing author' }], { rules: { COL003: { severity: 'warning', reason: 'Migration' } } });
    expect(result).toMatchObject({
      verdict: 'pass',
      findings: [expect.objectContaining({ severity: 'warning' })],
      suppressions: [expect.objectContaining({ ruleId: 'COL003', reason: 'Migration' })]
    });
  });

  it('passes with no findings', () => {
    expect(evaluateGovernance('hub', []).verdict).toBe('pass');
  });

  it('guards mandatory rules even when invoked without the policy parser', () => {
    const result = evaluateGovernance('hub', [{ ruleId: 'HUB001', severity: 'error', message: 'invalid' }], { rules: { HUB001: { enabled: false } } });
    expect(result.verdict).toBe('fail');
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'CFG003' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'HUB001' }));
  });
});
