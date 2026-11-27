/**
 * Tests for the display labels of primitive kinds.
 */
import * as assert from 'node:assert';
import {
  formatKindCounts,
  primitiveKindLabel,
} from '../../src/utils/primitive-kind-labels';

suite('primitiveKindLabels', () => {
  suite('formatKindCounts', () => {
    test('lists non-zero kinds in canonical kind order with plural nouns', () => {
      assert.strictEqual(formatKindCounts({ plugin: 1, prompt: 2 }), '2 prompts, 1 plugin');
    });

    test('uses display nouns for multi-word kinds', () => {
      assert.strictEqual(formatKindCounts({ 'mcp-server': 1 }), '1 MCP server');
      assert.strictEqual(formatKindCounts({ 'chat-mode': 2 }), '2 chat modes');
    });

    test('returns an empty string when nothing is counted', () => {
      assert.strictEqual(formatKindCounts({}), '');
      assert.strictEqual(formatKindCounts({ plugin: 0 }), '');
    });
  });

  suite('primitiveKindLabel', () => {
    test('title-cases the singular noun of a known kind or alias', () => {
      assert.strictEqual(primitiveKindLabel('plugin'), 'Plugin');
      assert.strictEqual(primitiveKindLabel('instructions'), 'Instruction');
      assert.strictEqual(primitiveKindLabel('mcp-server'), 'MCP server');
    });

    test('labels a missing type as a prompt', () => {
      assert.strictEqual(primitiveKindLabel(undefined), 'Prompt');
    });

    test('returns an unknown type unchanged', () => {
      assert.strictEqual(primitiveKindLabel('widget'), 'widget');
    });
  });
});
