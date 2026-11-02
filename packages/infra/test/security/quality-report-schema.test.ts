import {
  buildQualityReport,
  QUALITY_REPORT_SCHEMA,
  type SecurityFinding,
} from '@ai-primitives-hub/core';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  describe,
  expect,
  it,
} from 'vitest';

const finding = (overrides: Partial<SecurityFinding>): SecurityFinding => ({
  ruleId: 'SEC-001',
  title: 'Hardcoded key',
  severity: 'CRITICAL',
  confidence: 'HIGH',
  category: 'secrets',
  file: 'skills/a/SKILL.md',
  line: 3,
  section: 'Instructions',
  vulnerableContent: 'REDACTED',
  risk: 'A leaked key can be used by anyone.',
  recommendedFix: 'Remove the value.',
  fingerprint: 'f',
  canonicalFingerprint: 'c',
  ...overrides
});

const validator = (): ReturnType<Ajv['compile']> => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(QUALITY_REPORT_SCHEMA);
};

const report = (findings: SecurityFinding[], bundles: { id: string; files: string[] }[]) => buildQualityReport({
  findings,
  bundles: bundles.map((bundle) => ({ ...bundle, version: '1.0.0', metadata: { author: null, kind: { skill: 1 }, labels: [] } })),
  mode: 'collections',
  failOn: 'CRITICAL',
  generatedAt: '2026-01-01T00:00:00.000Z',
  scanner: { name: 'ai-primitives-hub-security' },
  source: { repository: 'owner/repo', tag: '', commit: 'abc' }
});

describe('quality report schema', () => {
  it('accepts a report with bundles', () => {
    const validate = validator();
    const value = report([finding({})], [{ id: 'a', files: ['skills/a/SKILL.md'] }, { id: 'b', files: ['skills/b/SKILL.md'] }]);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a whole-repository report when no bundles were found', () => {
    const validate = validator();
    const value = report([], []);
    expect(value.repo.basis).toBe('repository');
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a report with an unknown gate level or a missing section', () => {
    const validate = validator();
    const value = report([], []);
    expect(validate({ ...value, gate: { failOn: 'ANY', passed: true } })).toBe(false);
    const { bundles: _omitted, ...withoutBundles } = value;
    expect(validate(withoutBundles)).toBe(false);
  });
});
