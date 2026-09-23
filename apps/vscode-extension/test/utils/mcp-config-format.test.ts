/**
 * Tests for utils/mcp-config-format.
 *
 * These call the real serialize / normalize / parse helpers. An earlier version of
 * this suite re-implemented the servers <-> mcpServers transformation inline and
 * asserted on its own copy, so it passed regardless of what the extension did and
 * missed a serialization bug that dropped `inputs`.
 */

import * as assert from 'node:assert';
import type {
  McpConfiguration,
} from '../../src/types/mcp';
import {
  normalizeMcpConfig,
  parseMcpConfig,
  serializeMcpConfig,
} from '../../src/utils/mcp-config-format';
// ─────────────────────────────────────────────────────────────────────────────
// MCP format translation — calls the real serialize/normalize/parse helpers
// ─────────────────────────────────────────────────────────────────────────────

suite('MCP config format — serializeMcpConfig', () => {
  test('Kiro: writes the server map under mcpServers only', () => {
    const config: McpConfiguration = {
      servers: { 'my-server': { command: 'npx', args: ['-y', 'my-mcp-server'] } }
    };

    const result = serializeMcpConfig(config, 'mcpServers');

    assert.ok('mcpServers' in result, 'Kiro output should use the mcpServers key');
    assert.ok(!('servers' in result), 'Kiro output should not carry the servers key');
    assert.deepStrictEqual(result.mcpServers, config.servers);
  });

  test('VS Code: writes the server map under servers only', () => {
    const config: McpConfiguration = {
      servers: { 'my-server': { command: 'node' } }
    };

    const result = serializeMcpConfig(config, 'servers');

    assert.ok('servers' in result, 'VS Code output should use the servers key');
    assert.ok(!('mcpServers' in result), 'VS Code output should not carry the mcpServers key');
    assert.deepStrictEqual(result.servers, config.servers);
  });

  test('keeps inputs when tasks is also present', () => {
    // Regression: an early-return chain returned as soon as `tasks` was found,
    // so `inputs` (which holds the prompts for API keys) was silently dropped.
    const config: McpConfiguration = {
      servers: { 'my-server': { command: 'node' } },
      tasks: { build: { command: 'echo hi' } },
      inputs: [{ id: 'api-key', type: 'promptString', description: 'API key', password: true }]
    };

    const result = serializeMcpConfig(config, 'mcpServers');

    assert.ok(result.tasks, 'tasks should survive serialization');
    assert.ok(result.inputs, 'inputs should survive serialization alongside tasks');
    assert.deepStrictEqual(result.inputs, config.inputs);
    assert.deepStrictEqual(result.tasks, config.tasks);
  });

  test('keeps inputs when tasks is absent', () => {
    const config: McpConfiguration = {
      servers: {},
      inputs: [{ id: 'token', type: 'promptString' }]
    };

    const result = serializeMcpConfig(config, 'mcpServers');

    assert.deepStrictEqual(result.inputs, config.inputs);
  });

  test('omits tasks and inputs when neither is present', () => {
    const result = serializeMcpConfig({ servers: {} }, 'mcpServers');

    assert.ok(!('tasks' in result), 'tasks should be omitted when absent');
    assert.ok(!('inputs' in result), 'inputs should be omitted when absent');
  });

  test('drops a stale server map so the file never carries two', () => {
    const config = {
      servers: { current: { command: 'node' } },
      mcpServers: { stale: { command: 'old' } }
    } as unknown as McpConfiguration;

    const result = serializeMcpConfig(config, 'servers');

    assert.ok(!('mcpServers' in result), 'stale mcpServers key should be removed');
    assert.deepStrictEqual(result.servers, { current: { command: 'node' } });
  });

  test('preserves unrelated IDE state such as an API key', () => {
    const config = {
      servers: {},
      primaryApiKey: 'secret-value',
      theme: 'dark'
    } as unknown as McpConfiguration;

    const result = serializeMcpConfig(config, 'mcpServers');

    assert.strictEqual(result.primaryApiKey, 'secret-value');
    assert.strictEqual(result.theme, 'dark');
  });
});

suite('MCP config format — normalizeMcpConfig', () => {
  test('maps a Kiro file onto the internal servers key', () => {
    const raw = { mcpServers: { 'my-server': { command: 'npx' } } };

    const config = normalizeMcpConfig(raw, 'mcpServers');

    assert.deepStrictEqual(config.servers, raw.mcpServers);
    assert.ok(!('mcpServers' in config), 'the on-disk key should not survive normalization');
  });

  test('leaves a VS Code file on the servers key', () => {
    const raw = { servers: { 'my-server': { command: 'node' } } };

    const config = normalizeMcpConfig(raw, 'servers');

    assert.deepStrictEqual(config.servers, raw.servers);
    assert.ok(!('mcpServers' in config));
  });

  test('host key wins when a file contains both server maps', () => {
    const raw = {
      servers: { fromVsCode: { command: 'a' } },
      mcpServers: { fromKiro: { command: 'b' } }
    };

    const asKiro = normalizeMcpConfig(raw, 'mcpServers');
    const asVsCode = normalizeMcpConfig(raw, 'servers');

    assert.deepStrictEqual(asKiro.servers, raw.mcpServers, 'Kiro should read its own key');
    assert.deepStrictEqual(asVsCode.servers, raw.servers, 'VS Code should read its own key');
    assert.ok(!('mcpServers' in asKiro), 'the duplicate map must be dropped, not carried');
    assert.ok(!('mcpServers' in asVsCode), 'the duplicate map must be dropped, not carried');
  });

  test('falls back to the other key when the host key is missing', () => {
    const raw = { mcpServers: { 'my-server': { command: 'npx' } } };

    const config = normalizeMcpConfig(raw, 'servers');

    assert.deepStrictEqual(config.servers, raw.mcpServers);
  });

  test('returns an empty server map for a missing file', () => {
    assert.deepStrictEqual(normalizeMcpConfig(undefined, 'servers'), { servers: {} });
    assert.deepStrictEqual(normalizeMcpConfig(null, 'mcpServers'), { servers: {} });
  });

  test('returns an empty server map when no server key is present', () => {
    const config = normalizeMcpConfig({ inputs: [] }, 'servers');
    assert.deepStrictEqual(config.servers, {});
  });
});

suite('MCP config format — parseMcpConfig', () => {
  test('parses JSONC with comments and a trailing comma', () => {
    const content = `{
      // the server map
      "mcpServers": {
        "my-server": { "command": "npx" },
      },
    }`;

    const { config, warnings } = parseMcpConfig(content, 'mcpServers');

    assert.deepStrictEqual(config.servers, { 'my-server': { command: 'npx' } });
    assert.strictEqual(warnings.length, 0, 'JSONC input should not produce warnings');
  });

  test('returns an empty config for blank content', () => {
    const { config } = parseMcpConfig('', 'servers');
    assert.deepStrictEqual(config, { servers: {} });
  });

  test('reports warnings for malformed content without throwing', () => {
    const { warnings } = parseMcpConfig('{ "servers": { ', 'servers');
    assert.ok(warnings.length > 0, 'malformed JSON should surface warnings');
  });
});
