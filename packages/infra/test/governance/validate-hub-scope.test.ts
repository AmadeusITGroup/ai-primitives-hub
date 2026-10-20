import {
  computeHubScope,
  selectHubScope,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseHubScopeDocument,
} from '../../src/governance/git-hub-scope';
import {
  validateHubScopeDocument,
} from '../../src/governance/validate-hub-scope';

const doc = () => ({ version: '1.0.0', metadata: { name: 'Hub', description: 'Hub', maintainer: 'Test', updatedAt: '2026-01-01T00:00:00Z' },
  sources: [{ id: 'a', type: 'skills', url: 'https://github.com/owner/a', enabled: true, priority: 0 }],
  profiles: [{ id: 'p', name: 'P', description: 'P', bundles: [{ id: 'one', source: 'a', version: '1.0.0', required: true }] }] });
describe('projected Hub schema', () => {
  it('ignores YAML formatting and mapping order', () => {
    const base = parseHubScopeDocument('sources: []\nprofiles: []\n');
    const head = parseHubScopeDocument('# only presentation changed\nprofiles: []\nsources: []\n');
    expect(computeHubScope(base, head).noOp).toBe(true);
  });
  it('accepts projected empty references but not an actually empty profile', () => {
    const base = doc();
    const head = doc();
    head.profiles[0].name = 'Changed';
    let scope = computeHubScope(base, head);
    expect(validateHubScopeDocument(head, selectHubScope(head, scope)).valid).toBe(true);
    head.profiles[0].bundles = [];
    scope = computeHubScope(base, head);
    expect(validateHubScopeDocument(head, selectHubScope(head, scope)).valid).toBe(false);
  });
  it('does not hide selected reference schema failures', () => {
    const base = doc();
    const head = doc();
    head.profiles[0].bundles[0].version = 'bad-version';
    const scope = computeHubScope(base, head);
    expect(validateHubScopeDocument(head, selectHubScope(head, scope)).valid).toBe(false);
  });
  it('validates global metadata even when entity scope is a semantic no-op', () => {
    const head = doc();
    head.metadata.updatedAt = 'bad-date';
    const scope = computeHubScope(head, head);
    expect(validateHubScopeDocument(head, selectHubScope(head, scope)).valid).toBe(false);
  });
  it('rejects duplicate YAML mapping keys', () => {
    expect(() => parseHubScopeDocument('sources: []\nsources: []\nprofiles: []')).toThrow();
  });
});
