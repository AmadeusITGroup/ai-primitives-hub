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
  it('fails unverifiable releases', () => {
    const report = evaluateGovernance('collection', releaseFindings({ id: 'test', sourceId: 'one' }, { status: 'unverified' }));
    expect(report).toMatchObject({ verdict: 'fail' });
    expect(report.findings[0]).toMatchObject({ ruleId: 'COL002', verified: false });
  });
  it('accepts a published release', () => {
    expect(releaseFindings({ id: 'test', sourceId: 'one' }, { status: 'published' })).toEqual([]);
  });
  it('detects canonical collection IDs across sources, not runtime bundle prefixes', () => {
    const report = evaluateGovernance('collection', hubCollectionFindings({ collections: [
      { id: 'test', sourceId: 'one' }, { id: 'test', sourceId: 'two' }
    ], unverifiedSources: [] }));
    expect(report).toMatchObject({ verdict: 'fail' });
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
  it('permits COL004 suppression and reports incomplete inventories as errors', () => {
    const findings = hubCollectionFindings({ collections: [], unverifiedSources: [{ sourceId: 'private', message: 'Unavailable' }] });
    expect(evaluateGovernance('collection', findings)).toMatchObject({ verdict: 'fail' });
    const report = evaluateGovernance('collection', findings, { rules: { COL004: { enabled: false, reason: 'Migration' } } });
    expect(report).toMatchObject({ verdict: 'pass' });
    expect(report.suppressions[0].reason).toBe('Migration');
  });

  it('uses the registered source rather than names or runtime bundle identity for ownership', () => {
    const inventory = { collections: [], registry: { owners: new Map([['tools', 'one']]), sources: new Map([['one', 'owner/one'], ['two', 'owner/two']]) }, unverifiedSources: [] };
    expect(hubCollectionFindings(inventory, [{ id: 'tools', name: 'Updated name', sourceId: 'one' }])).toEqual([]);
    expect(hubCollectionFindings(inventory, [{ id: 'tools', sourceId: 'two' }])).toEqual([
      expect.objectContaining({ ruleId: 'COL004', verified: true, problem: 'Collection ID belongs to another source' })
    ]);
    expect(hubCollectionFindings(inventory, [{ id: 'new-tools', sourceId: 'one' }])).toEqual([
      expect.objectContaining({ ruleId: 'COL004', verified: true, problem: 'Collection ID is not registered' })
    ]);
    expect(hubCollectionFindings(inventory, [{ id: 'tools', sourceId: '' }])).toEqual([
      expect.objectContaining({ ruleId: 'COL004', verified: false, problem: 'Collection source identity is unverified' })
    ]);
  });

  it('does not discard incomplete index evidence when no candidates are selected', () => {
    const findings = hubCollectionFindings({ collections: [], registry: { owners: new Map(), sources: new Map() },
      unverifiedSources: [{ sourceId: 'collection-index.yml', message: 'Unavailable' }] });
    expect(findings).toEqual([expect.objectContaining({ ruleId: 'COL004', verified: false })]);
    expect(evaluateGovernance('collection', findings).verdict).toBe('fail');
  });
});
