import * as assert from 'node:assert';
import {
  calculateBreakdown,
  inferEnvironments,
  mapCollectionToBundle,
  parseCollectionYaml,
} from '../../../src/adapters/helpers/collection-parser';

suite('collection-parser', () => {
  suite('parseCollectionYaml()', () => {
    test('parses valid collection YAML', () => {
      const content = 'id: azure-cloud\nname: Azure Cloud\ndescription: Azure tools\ntags: [azure]\nitems:\n  - path: prompts/a.prompt.md\n    kind: prompt\n';
      const result = parseCollectionYaml(content);
      assert.strictEqual(result.id, 'azure-cloud');
      assert.strictEqual(result.items.length, 1);
    });
    test('handles mcpServers field', () => {
      const content = 'id: mcp\nname: MCP\ndescription: d\nitems: []\nmcpServers:\n  srv:\n    command: node\n';
      const result = parseCollectionYaml(content);
      assert.ok(result.mcpServers);
    });
  });

  suite('inferEnvironments()', () => {
    test('passes tags through as environments', () => {
      assert.deepStrictEqual(inferEnvironments(['python', 'azure']), ['python', 'azure']);
    });
    test('returns vscode when no tags', () => {
      assert.deepStrictEqual(inferEnvironments([]), ['vscode']);
    });
  });

  suite('calculateBreakdown()', () => {
    test('counts items by kind', () => {
      const items = [{ path: 'a', kind: 'prompt' as const }, { path: 'b', kind: 'prompt' as const }, { path: 'c', kind: 'instruction' as const }];
      const r = calculateBreakdown(items);
      assert.strictEqual(r.prompts, 2);
      assert.strictEqual(r.instructions, 1);
    });
    test('includes MCP server count', () => {
      const r = calculateBreakdown([{ path: 'a', kind: 'prompt' as const }], { s1: {}, s2: {} });
      assert.strictEqual(r.mcpServers, 2);
    });
  });

  suite('mapCollectionToBundle()', () => {
    test('maps CollectionManifest to Bundle', () => {
      const c = { id: 'test', name: 'Test', description: 'd', version: '2.0.0', author: 'auth', tags: ['ai'], items: [{ path: 'p', kind: 'prompt' as const }] };
      const bundle = mapCollectionToBundle(c, 'src-1', 'https://github.com/org/repo');
      assert.strictEqual(bundle.id, 'test');
      assert.strictEqual(bundle.version, '2.0.0');
      assert.strictEqual(bundle.author, 'auth');
    });
  });
});
