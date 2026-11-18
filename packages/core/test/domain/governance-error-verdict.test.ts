import {
  describe,
  expect,
  it,
} from 'vitest';
import * as governance from '../../src/domain/governance';

describe('error-based governance verdict v1', () => {
  it('returns a passing report with no scoring fields for any number of warnings', () => {
    const findings = Array.from({ length: 40 }, () => ({
      ruleId: 'HUB002', severity: 'warning' as const, message: 'Advisory'
    }));
    const report = governance.evaluateGovernance('hub', findings);
    expect(report.verdict).toBe('pass');
    expect(report.findings).toEqual(findings);
    expect(report).not.toHaveProperty('score');
    expect(report).not.toHaveProperty('minScore');
  });

  it('fails on errors even when their evidence is unverified', () => {
    expect(governance.evaluateGovernance('hub', [{
      ruleId: 'HUB001', severity: 'error', message: 'Unavailable', verified: false
    }]).verdict).toBe('fail');
  });

  it('does not export scoring or register a score configuration rule', () => {
    expect(governance).not.toHaveProperty('governanceScore');
    expect(governance).not.toHaveProperty('ERROR_PENALTY');
    expect(governance).not.toHaveProperty('WARNING_PENALTY');
    expect(governance.GOVERNANCE_RULES.map((rule) => rule.id)).not.toContain('CFG004');
  });

  it('accepts execution options as the fourth argument and preserves configuration locations', () => {
    const report = governance.evaluateGovernance('hub', [], {
      rules: { UNKNOWN: { enabled: false } }
    }, { mode: 'sources', configFile: 'custom-policy.yml' });
    expect(report).toMatchObject({ mode: 'sources', verdict: 'fail', notChecked: [] });
    expect(report.findings).toEqual([expect.objectContaining({ ruleId: 'CFG002', file: 'custom-policy.yml' })]);
  });

  it('renders error-based catalogue guidance without scoring', () => {
    const catalogue = governance.renderRuleCatalogue(governance.GOVERNANCE_RULES);
    expect(catalogue).toContain('Any error fails the run. Warnings do not fail the run.');
    expect(catalogue).not.toMatch(/score|penalt|CFG004/i);
  });
});
