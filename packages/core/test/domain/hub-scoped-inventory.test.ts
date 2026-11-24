import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  computeHubScope,
  selectHubScope,
} from '../../src/domain/governance/hub-scope';
import {
  hubScopeInventoryDocument,
  scopedHubInventory,
} from '../../src/domain/governance/hub-scoped-inventory';

const source = (id: string) => ({ id, type: 'github', url: `https://github.com/owner/${id}`, enabled: true, priority: 0 });
const bundle = (version = '1.0.0') => ({ id: 'owner-a-selected-1.0.0', source: 'a', version, required: true });
const document = () => ({ sources: [source('a'), source('b'), source('c')], profiles: [{ id: 'p', name: 'P', bundles: [bundle()] }] });

describe('scoped inventory and dependency rules', () => {
  it('excludes disabled owners even when stale inventory evidence is supplied', () => {
    const head = document();
    head.sources[0].enabled = false;
    const scope = computeHubScope(head, head, { sourceIds: ['a'], profileIds: [] });
    const evidence = scopedHubInventory(head, scope, {
      collections: [{ sourceId: 'a', id: 'selected' }, { sourceId: 'b', id: 'selected' }],
      unverifiedSources: [{ sourceId: 'b', message: 'Unavailable' }]
    });
    expect(evidence).toEqual({ collections: [], releaseCandidates: [], unverifiedSources: [] });
  });
  it('does not attribute a baseline-only collision to a missing selected owner', () => {
    const base = document();
    const head = document();
    head.profiles[0].bundles[0].version = '2.0.0';
    const evidence = scopedHubInventory(head, computeHubScope(base, head), {
      collections: [{ sourceId: 'b', id: 'selected' }, { sourceId: 'c', id: 'selected' }],
      releaseCandidates: [{ sourceId: 'a', id: 'selected' }], unverifiedSources: []
    });
    expect(evidence.collections).toEqual([]);
    expect(evidence.releaseCandidates).toEqual([{ sourceId: 'a', id: 'selected' }]);
  });
  it('does not require collection context for skill-only selections', () => {
    const head = document();
    head.sources[0].type = 'skills';
    const scope = computeHubScope(head, head, { sourceIds: ['a'], profileIds: [] });
    expect(hubScopeInventoryDocument(head, scope).sources).toEqual([]);
  });
  it('retains competing owners only for selected IDs', () => {
    const base = document();
    const head = document();
    head.profiles[0].bundles[0].version = '2.0.0';
    const scope = computeHubScope(base, head);
    const evidence = scopedHubInventory(head, scope, { collections: [
      { sourceId: 'a', id: 'selected' }, { sourceId: 'b', id: 'selected' },
      { sourceId: 'b', id: 'baseline-collision' }, { sourceId: 'c', id: 'baseline-collision' }
    ], unverifiedSources: [] });
    expect(evidence.collections.map((c) => c.id)).toEqual(['selected', 'selected']);
    expect(evidence.releaseCandidates).toEqual([{ sourceId: 'a', id: 'selected' }]);
  });
  it('checks every discovered collection for a changed source but not unrelated source publications', () => {
    const base = document();
    const head = document();
    head.sources[0].url = 'https://github.com/owner/replacement';
    const scope = computeHubScope(base, head);
    const evidence = scopedHubInventory(head, scope, { collections: [
      { sourceId: 'a', id: 'one' }, { sourceId: 'a', id: 'two' }, { sourceId: 'b', id: 'baseline' }
    ], unverifiedSources: [] });
    expect(evidence.releaseCandidates?.map((c) => c.id)).toEqual(['one', 'two']);
    expect(scope.profileIds).toEqual(['p']);
  });
  it('reports added/removed profiles and removed reference versions', () => {
    const base = document();
    const head = document();
    head.profiles = [{ id: 'new', name: 'New', bundles: [bundle('2.0.0')] }];
    const scope = computeHubScope(base, head);
    expect(scope.profiles).toEqual({ added: ['new'], modified: [], removed: ['p'] });
    expect(scope.removedReferences).toContainEqual(expect.objectContaining({ profileId: 'p', version: '1.0.0' }));
    expect(scope.references).toContainEqual(expect.objectContaining({ profileId: 'new', version: '2.0.0' }));
  });
  it('keeps metadata-only profile edits local to schema validation', () => {
    const base = document();
    const head = document();
    head.profiles[0].name = 'Renamed';
    const scope = computeHubScope(base, head);
    expect(scope.profileIds).toEqual(['p']);
    expect(scope.references).toEqual([]);
    expect(scope.sourceIds).toEqual([]);
    expect(scope.noOp).toBe(false);
  });
  it('does not hide malformed selected versions during projection', () => {
    const base = document();
    const head = { ...document(), profiles: [{ id: 'p', name: 'P', bundles: [{ ...bundle(), version: undefined }] }] };
    const scope = computeHubScope(base, head);
    expect(selectHubScope(head, scope).profiles[0].bundles).toHaveLength(1);
  });
  it('rejects null entity lists and duplicate profiles globally', () => {
    expect(() => computeHubScope(document(), { ...document(), profiles: null })).toThrow(/array/);
    const head = document();
    head.profiles.push(head.profiles[0]);
    expect(() => computeHubScope(document(), head)).toThrow(/Duplicate/);
  });
  it('limits context to enabled collection sources, not unrelated skill/APM configuration', () => {
    const head = document();
    head.sources[1].type = 'apm';
    head.sources[2].enabled = false;
    const scope = computeHubScope(head, head, { sourceIds: ['a'], profileIds: [] });
    expect(hubScopeInventoryDocument(head, scope).sources.map((s) => s.id)).toEqual(['a']);
  });
  it('compares nested mapping key order without losing source config changes', () => {
    const base = { ...document(), sources: [{ ...source('a'), config: { first: 1, second: { a: 1, b: 2 } } }] };
    const head = { ...document(), sources: [{ ...source('a'), config: { second: { b: 2, a: 1 }, first: 1 } }] };
    expect(computeHubScope(base, head).noOp).toBe(true);
    head.sources[0].config.first = 2;
    expect(computeHubScope(base, head).sources.modified).toEqual(['a']);
  });
});
