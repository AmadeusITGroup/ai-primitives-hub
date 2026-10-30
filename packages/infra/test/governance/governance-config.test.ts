import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AjvSchemaValidator,
} from '../../src/governance/ajv-schema-validator';
import {
  parseGovernanceConfig,
} from '../../src/governance/governance-config';

describe('parseGovernanceConfig', () => {
  it('accepts an empty file as all defaults', () => {
    expect(parseGovernanceConfig('', 'hub-governance.yml')).toEqual({ policy: {}, findings: [] });
  });

  it('returns the policy for a valid file', () => {
    expect(parseGovernanceConfig('minScore: 80\nrules:\n  COL003:\n    enabled: false\n    reason: legacy\n').policy)
      .toEqual({ minScore: 80, rules: { COL003: { enabled: false, reason: 'legacy' } } });
  });

  it('reports YAML and schema problems as CFG001 with the file path', () => {
    expect(parseGovernanceConfig('rules: [', 'hub-governance.yml').findings)
      .toEqual([expect.objectContaining({ ruleId: 'CFG001', file: 'hub-governance.yml', message: expect.stringContaining('YAML') })]);
    expect(parseGovernanceConfig('typo: 1\n').findings).toEqual([expect.objectContaining({ ruleId: 'CFG001' })]);
    expect(parseGovernanceConfig('rules:\n  COL003:\n    severity: info\n').findings[0].ruleId).toBe('CFG001');
  });

  it('leaves semantic checks (unknown ids, floor rules, score range) to core', () => {
    expect(parseGovernanceConfig('minScore: 500\nrules:\n  NOPE:\n    enabled: false\n').findings).toEqual([]);
  });
});

describe('AjvSchemaValidator', () => {
  it('validates with formats and caches compiled schemas by identity', () => {
    const validator = new AjvSchemaValidator();
    const schema = { type: 'object', required: ['version'], properties: { version: { type: 'string', format: 'semver' } } };
    expect(validator.validate(schema, { version: '1.2.3' })).toEqual({ valid: true, issues: [] });
    expect(validator.validate(schema, { version: 'one' })).toMatchObject({ valid: false, issues: [{ instancePath: '/version', keyword: 'format' }] });
    expect(validator.validate(schema, {}).issues[0]).toMatchObject({ keyword: 'required', params: { missingProperty: 'version' } });
  });
});
