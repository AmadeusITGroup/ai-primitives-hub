import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  evaluateGovernance,
  hubCollectionFindings,
  releaseFindings,
} from '../../src/domain/governance';

describe('source governance rules', () => {
  it('rejects missing published releases and protects COL002 from policy overrides', () => {
    const findings = releaseFindings({ id: 'test', sourceId: 'one' }, { status: 'missing' });
    const report = evaluateGovernance('collection', findings, { rules: { COL002: { enabled: false } } });
    expect(report.verdict).toBe('fail');
    expect(report.findings.map((finding) => finding.ruleId)).toEqual(['CFG003', 'COL002']);
  });
  it('fails unverifiable releases without changing the score', () => {
    const report = evaluateGovernance('collection', releaseFindings({ id: 'test', sourceId: 'one' }, { status: 'unverified' }));
    expect(report).toMatchObject({ verdict: 'fail', score: 100 });
    expect(report.findings[0]).toMatchObject({ ruleId: 'COL002', verified: false });
  });
  it('accepts a published release', () => {
    expect(releaseFindings({ id: 'test', sourceId: 'one' }, { status: 'published' })).toEqual([]);
  });
  it('detects canonical collection IDs across sources, not runtime bundle prefixes', () => {
    const report = evaluateGovernance('hub', hubCollectionFindings({ collections: [
      { id: 'test', sourceId: 'one' }, { id: 'test', sourceId: 'two' }
    ], unverifiedSources: [] }));
    expect(report).toMatchObject({ verdict: 'fail', score: 90 });
    expect(report.findings[0]).toMatchObject({ ruleId: 'COL004' });
    expect(report.findings[0].message).toContain('one');
    expect(report.findings[0].message).toContain('two');
  });
  it('does not treat versions in the same source or matching display names as ID collisions', () => {
    expect(hubCollectionFindings({ collections: [
      { id: 'test', name: 'Same', sourceId: 'one' }, { id: 'test', name: 'Same', sourceId: 'one' },
      { id: 'different', name: 'Same', sourceId: 'two' }
    ], unverifiedSources: [] })).toEqual([]);
  });
  it('permits COL004 suppression and reports incomplete inventories without score penalties', () => {
    const findings = hubCollectionFindings({ collections: [], unverifiedSources: [{ sourceId: 'private', message: 'Unavailable' }] });
    expect(evaluateGovernance('hub', findings)).toMatchObject({ verdict: 'fail', score: 100 });
    const report = evaluateGovernance('hub', findings, { rules: { COL004: { enabled: false, reason: 'Migration' } } });
    expect(report).toMatchObject({ verdict: 'pass', score: 100 });
    expect(report.suppressions[0].reason).toBe('Migration');
  });
});
