import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  computeHubScope,
  selectHubScope,
} from '../../src/domain/governance/hub-scope';

const source = (id: string) => ({ id, type: 'github', url: `https://github.com/org/${id}`, enabled: true, priority: 0 });
const reference = (sourceId: string, version = '1.0.0') => ({ source: sourceId, id: 'collection', version, required: true });
const profile = (id: string, sourceId: string) => ({ id, name: id, bundles: [reference(sourceId)] });
describe('semantic Hub scope', () => {
  it('ignores object key order and source/profile ordering', () => {
    const base = { sources: [source('a'), source('b')], profiles: [profile('p', 'a'), profile('q', 'b')] };
    expect(computeHubScope(base, { profiles: [...base.profiles].reverse(), sources: [...base.sources].reverse() }).noOp).toBe(true);
  });
  it('selects remaining dependents of deleted and changed sources', () => {
    const base = { sources: [source('a'), source('b')], profiles: [profile('p', 'a'), profile('q', 'b')] };
    const head = { ...base, sources: [{ ...source('b'), enabled: false }] };
    const scope = computeHubScope(base, head);
    expect(scope.sources).toEqual({ added: [], modified: ['b'], removed: ['a'] });
    expect(scope.profileIds).toEqual(['p', 'q']);
    expect(scope.references).toHaveLength(2);
  });
  it('scopes changed references without selecting unrelated baseline references', () => {
    const base = { sources: [source('a'), source('b')], profiles: [{ ...profile('p', 'a'), bundles: [reference('a'), reference('b')] }] };
    const head = { ...base, profiles: [{ ...base.profiles[0], bundles: [reference('a', '2.0.0'), reference('b')] }] };
    const scope = computeHubScope(base, head);
    expect(scope.references.map((r) => r.source)).toEqual(['a']);
    expect(selectHubScope(head, scope).sources.map((s) => s.id)).toEqual(['a']);
  });
  it('rejects duplicate and malformed IDs even for otherwise unchanged entities', () => {
    expect(() => computeHubScope({ sources: [], profiles: [] }, { sources: [source('a'), source('a')], profiles: [] })).toThrow(/Duplicate/);
    expect(() => computeHubScope({ sources: [], profiles: [] }, { sources: [{ id: 1 }], profiles: [] })).toThrow(/ID/);
  });
});
