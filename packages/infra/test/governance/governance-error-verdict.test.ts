import {
  evaluateGovernance,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseGovernanceConfig,
} from '../../src/governance/governance-config';

describe('score-free governance configuration v1', () => {
  it.each(['minScore: 80\n', 'score: 100\n'])('rejects removed configuration fields as CFG001: %s', (content) => {
    const parsed = parseGovernanceConfig(content, 'hub-governance.yml');
    expect(parsed.policy).toBeUndefined();
    expect(parsed.findings).toEqual([expect.objectContaining({
      ruleId: 'CFG001', severity: 'error', file: 'hub-governance.yml'
    })]);
    expect(evaluateGovernance('hub', parsed.findings).verdict).toBe('fail');
  });
});
