/**
 * MCP Kiro-specific path and format tests.
 *
 * Tests that:
 * 1. McpConfigLocator resolves the correct paths for Kiro (user + workspace)
 * 2. McpConfigLocator resolves VS Code paths unchanged (no regression)
 * 3. getMcpLayoutConfig reads directly from default-layouts.json (single source of truth)
 * 4. The real shared format helpers map between the internal `servers` key and
 *    each IDE's on-disk key, without losing `inputs`/`tasks` or leaving a stale
 *    second server map behind
 * 5. The real McpConfigService read → modify → write cycle round-trips a
 *    Kiro-format file on disk
 *
 * Items 4 and 5 deliberately call production code. An earlier version of this
 * file re-implemented the transformation inline, so it passed regardless of what
 * the extension actually did and missed a serialization bug that dropped `inputs`.
 */

import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsExtra from 'fs-extra';
import {
  McpConfigService,
} from '../../src/services/mcp-config-service';
import type {
  McpConfiguration,
} from '../../src/types/mcp';
import {
  normalizeMcpConfig,
  parseMcpConfig,
  serializeMcpConfig,
} from '../../src/utils/mcp-config-format';
import {
  McpConfigLocator,
} from '../../src/utils/mcp-config-locator';

// ─────────────────────────────────────────────────────────────────────────────
// getMcpLayoutConfig — direct access to default-layouts.json
// ─────────────────────────────────────────────────────────────────────────────

suite('McpConfigLocator.getMcpLayoutConfig — reads from default-layouts.json', () => {
  test('Kiro: has correct paths and mcpServers key', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('kiro');
    assert.ok(mc, 'Kiro should have mcpConfig defined');
    assert.strictEqual(mc.serversKey, 'mcpServers');
    assert.ok(mc.userFile?.includes('.kiro/settings/mcp.json'), 'userFile should include .kiro/settings/mcp.json');
    assert.strictEqual(mc.workspaceFile, '.kiro/settings/mcp.json');
  });

  test('VS Code: has .vscode workspace file and servers key', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('vscode');
    assert.ok(mc, 'VS Code should have mcpConfig defined');
    assert.strictEqual(mc.serversKey, 'servers');
    assert.strictEqual(mc.userFile, null, 'VS Code userFile should be null (resolved from globalStorageUri)');
    assert.strictEqual(mc.workspaceFile, '.vscode/mcp.json');
  });

  test('Windsurf: has correct user path and mcpServers key', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('windsurf');
    assert.ok(mc, 'Windsurf should have mcpConfig defined');
    assert.strictEqual(mc.serversKey, 'mcpServers');
    assert.ok(mc.userFile?.includes('mcp_config.json'), 'Windsurf userFile should use mcp_config.json');
    assert.strictEqual(mc.workspaceFile, null, 'Windsurf has no workspace-level MCP');
  });

  test('Claude Code: has root-level .mcp.json workspace file', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('claude-code');
    assert.ok(mc, 'Claude Code should have mcpConfig defined');
    assert.strictEqual(mc.serversKey, 'mcpServers');
    assert.strictEqual(mc.workspaceFile, '.mcp.json');
  });

  test('Copilot CLI: has user file, no workspace file', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('copilot-cli');
    assert.ok(mc, 'Copilot CLI should have mcpConfig defined');
    assert.strictEqual(mc.serversKey, 'mcpServers');
    assert.strictEqual(mc.workspaceFile, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// McpConfigLocator — path resolution
// ─────────────────────────────────────────────────────────────────────────────

suite('McpConfigLocator — Kiro path resolution', () => {
  suite('getUserMcpConfigPath', () => {
    test('Kiro: returns ~/.kiro/settings/mcp.json', () => {
      const result = McpConfigLocator.getUserMcpConfigPath('kiro');
      const expected = path.join(os.homedir(), '.kiro', 'settings', 'mcp.json');
      assert.strictEqual(result, expected,
        'Kiro user MCP config should be in ~/.kiro/settings/mcp.json');
    });

    test('VS Code: returns path under AppData/Code (unchanged)', () => {
      const result = McpConfigLocator.getUserMcpConfigPath('vscode');
      assert.ok(result.endsWith('mcp.json'), 'Should end with mcp.json');
      // Should NOT be the Kiro path
      assert.ok(!result.includes(path.join('.kiro', 'settings')),
        'VS Code path should not include .kiro/settings');
    });

    test('VS Code: resolves the default profile, not a per-profile path (known limitation)', () => {
      // Documents a known limitation rather than desired behaviour: globalStorageUri is
      // not profile-scoped, so a non-default profile's
      // <userDataDir>/User/profiles/<id>/mcp.json is never targeted. There is no API to
      // resolve the active profile (microsoft/vscode#160466 and #211890, both not planned).
      // See docs/contributor-guide/architecture/mcp-integration.md.
      const result = McpConfigLocator.getUserMcpConfigPath('vscode');
      assert.ok(!result.includes(`${path.sep}profiles${path.sep}`),
        'user path is default-profile only; update the docs if this ever changes');
    });

    test('Windsurf: returns ~/.codeium/windsurf/mcp_config.json', () => {
      const result = McpConfigLocator.getUserMcpConfigPath('windsurf');
      assert.ok(result.includes(path.join('.codeium', 'windsurf')),
        'Windsurf path should be ~/.codeium/windsurf/');
      assert.ok(result.endsWith('mcp_config.json'),
        'Windsurf config filename should be mcp_config.json');
    });
  });

  suite('getUserTrackingPath', () => {
    test('Kiro: tracking file is in ~/.kiro/settings/ (same dir as mcp.json)', () => {
      const trackingPath = McpConfigLocator.getUserTrackingPath('kiro');
      const configPath = McpConfigLocator.getUserMcpConfigPath('kiro');
      assert.strictEqual(
        path.dirname(trackingPath),
        path.dirname(configPath),
        'Kiro tracking file should be in the same directory as mcp.json'
      );
      assert.ok(trackingPath.includes('.kiro'),
        'Kiro tracking path should contain .kiro');
    });

    test('VS Code: tracking file is parallel to VS Code mcp.json', () => {
      const trackingPath = McpConfigLocator.getUserTrackingPath('vscode');
      const configPath = McpConfigLocator.getUserMcpConfigPath('vscode');
      assert.strictEqual(
        path.dirname(trackingPath),
        path.dirname(configPath),
        'VS Code tracking file should be in the same directory as mcp.json'
      );
    });
  });

  suite('getMcpWorkspaceConfigFolder', () => {
    test('returns .kiro/settings for kiro target', () => {
      assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('kiro'), path.join('.kiro', 'settings'));
    });

    test('returns .vscode for vscode target', () => {
      assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('vscode'), '.vscode');
    });

    test('returns .vscode for windsurf target (no official workspace-level MCP — falls back to .vscode)', () => {
      // Windsurf has no official workspace-level MCP config documented;
      // getMcpWorkspaceConfigFolder falls back to .vscode for null-mapped IDEs.
      assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('windsurf'), '.vscode');
    });

    test('returns .vscode for vscode-insiders target', () => {
      assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('vscode-insiders'), '.vscode');
    });
  });

  suite('getMcpServersKey', () => {
    test('returns mcpServers for kiro target', () => {
      assert.strictEqual(McpConfigLocator.getMcpServersKey('kiro'), 'mcpServers');
    });

    test('returns servers for vscode target', () => {
      assert.strictEqual(McpConfigLocator.getMcpServersKey('vscode'), 'servers');
    });

    test('returns mcpServers for windsurf target', () => {
      assert.strictEqual(McpConfigLocator.getMcpServersKey('windsurf'), 'mcpServers');
    });

    test('returns mcpServers for claude-code target', () => {
      assert.strictEqual(McpConfigLocator.getMcpServersKey('claude-code'), 'mcpServers');
    });

    test('returns mcpServers for copilot-cli target', () => {
      assert.strictEqual(McpConfigLocator.getMcpServersKey('copilot-cli'), 'mcpServers');
    });
  });
});

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
    // A config that still holds a residual `mcpServers` (e.g. read from a file
    // that had both keys) must not be written back out with both maps.
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
    // Comments and trailing commas are valid in a VS Code mcp.json; a strict
    // JSON.parse throws on them.
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

// ─────────────────────────────────────────────────────────────────────────────
// McpConfigService — real read → modify → write cycle against a temp workspace
// ─────────────────────────────────────────────────────────────────────────────

/** Global the vscode test mock reads `workspace.workspaceFolders` from. */
const WORKSPACE_FOLDERS_GLOBAL = '__mockWorkspaceFolders';

suite('McpConfigService — Kiro workspace round-trip', () => {
  const tmpRoot = path.join(os.tmpdir(), `mcp-kiro-e2e-${Date.now()}`);
  const kiroMcpPath = path.join(tmpRoot, '.kiro', 'settings', 'mcp.json');
  let savedWorkspaceFolders: unknown;
  let savedAppName: string;
  let savedUriScheme: string;

  setup(async () => {
    await fsExtra.ensureDir(path.dirname(kiroMcpPath));

    const globals = global as unknown as Record<string, unknown>;
    savedWorkspaceFolders = globals[WORKSPACE_FOLDERS_GLOBAL];
    globals[WORKSPACE_FOLDERS_GLOBAL] = [
      { uri: { fsPath: tmpRoot }, name: 'workspace', index: 0 }
    ];

    // Point host detection at Kiro so the service resolves the Kiro key/paths.
    const env = (await import('vscode')).env as unknown as { appName: string; uriScheme: string };
    savedAppName = env.appName;
    savedUriScheme = env.uriScheme;
    env.appName = 'Kiro';
    env.uriScheme = 'kiro';
  });

  teardown(async () => {
    const globals = global as unknown as Record<string, unknown>;
    globals[WORKSPACE_FOLDERS_GLOBAL] = savedWorkspaceFolders;

    const env = (await import('vscode')).env as unknown as { appName: string; uriScheme: string };
    env.appName = savedAppName;
    env.uriScheme = savedUriScheme;

    await fsExtra.remove(tmpRoot);
  });

  test('reads a Kiro-format file written on disk', async () => {
    await fsExtra.writeJson(kiroMcpPath, {
      mcpServers: { 'my-server': { command: 'npx', args: ['-y', 'my-mcp-server'] } }
    });

    const config = await new McpConfigService().readMcpConfig('workspace');

    assert.deepStrictEqual(config.servers, {
      'my-server': { command: 'npx', args: ['-y', 'my-mcp-server'] }
    });
  });

  test('writes the Kiro key and keeps both tasks and inputs on disk', async () => {
    const service = new McpConfigService();

    await service.writeMcpConfig({
      servers: { 'my-server': { command: 'node' } },
      tasks: { build: { command: 'echo hi' } },
      inputs: [{ id: 'api-key', type: 'promptString', password: true }]
    }, 'workspace', false);

    const onDisk = await fsExtra.readJson(kiroMcpPath) as Record<string, unknown>;

    assert.ok('mcpServers' in onDisk, 'Kiro file should use the mcpServers key');
    assert.ok(!('servers' in onDisk), 'Kiro file should not carry the servers key');
    assert.ok(onDisk.tasks, 'tasks should be written');
    assert.ok(onDisk.inputs, 'inputs should be written alongside tasks');
  });

  test('a read → write cycle leaves exactly one server map', async () => {
    // Seed a file that already carries both keys (manual edit / migration).
    await fsExtra.writeJson(kiroMcpPath, {
      servers: { stale: { command: 'old' } },
      mcpServers: { current: { command: 'node' } },
      primaryApiKey: 'secret-value'
    });

    const service = new McpConfigService();
    const config = await service.readMcpConfig('workspace');
    await service.writeMcpConfig(config, 'workspace', false);

    const onDisk = await fsExtra.readJson(kiroMcpPath) as Record<string, unknown>;

    assert.ok('mcpServers' in onDisk, 'the host key should remain');
    assert.ok(!('servers' in onDisk), 'the stale key should be gone after a write');
    assert.deepStrictEqual(onDisk.mcpServers, { current: { command: 'node' } });
    assert.strictEqual(onDisk.primaryApiKey, 'secret-value', 'unrelated IDE state should survive');
  });
});
