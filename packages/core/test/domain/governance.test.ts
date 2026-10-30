import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  evaluateGovernance,
} from '../../src/domain/governance';

describe('governance verdict and advisory score', () => {
  it('deducts ten per verified error and three per verified warning', () => {
    const result = evaluateGovernance('hub', [
      { ruleId: 'HUB001', severity: 'error', message: 'invalid' },
      { ruleId: 'HUB002', severity: 'warning', message: 'advisory' }
    ]);
    expect(result).toMatchObject({ score: 87, verdict: 'fail' });
  });

  it('never weights an unverified finding', () => {
    expect(evaluateGovernance('hub', [{ ruleId: 'HUB002', severity: 'warning', message: 'unavailable', verified: false }])).toMatchObject({ score: 100, verdict: 'pass' });
  });

  it('clamps the score at zero', () => {
    const findings = Array.from({ length: 12 }, (_, index) => ({ ruleId: 'HUB001', severity: 'error' as const, message: String(index) }));
    expect(evaluateGovernance('hub', findings).score).toBe(0);
  });

  it('records severity overrides and changes the verdict without hiding findings', () => {
    const result = evaluateGovernance('collection', [{ ruleId: 'COL003', severity: 'error', message: 'missing author' }], { rules: { COL003: { severity: 'warning', reason: 'Migration' } } });
    expect(result).toMatchObject({
      score: 97, verdict: 'pass',
      findings: [expect.objectContaining({ severity: 'warning' })],
      suppressions: [expect.objectContaining({ ruleId: 'COL003', reason: 'Migration' })]
    });
  });

  it('uses the CLI minimum score ahead of the committed policy', () => {
    expect(evaluateGovernance('hub', [{ ruleId: 'HUB002', severity: 'warning', message: 'advisory' }], { minScore: 100 }, 90).verdict).toBe('pass');
  });

  it('guards mandatory rules even when invoked without the policy parser', () => {
    const result = evaluateGovernance('hub', [{ ruleId: 'HUB001', severity: 'error', message: 'invalid' }], { rules: { HUB001: { enabled: false } } });
    expect(result.verdict).toBe('fail');
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'CFG003' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'HUB001' }));
  });
});
