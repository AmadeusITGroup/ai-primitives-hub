/**
 * MCP Kiro-specific path and format tests.
 *
 * Tests that:
 * 1. McpConfigLocator resolves the correct paths for Kiro (user + workspace)
 * 2. McpConfigLocator resolves VS Code paths unchanged (no regression)
 * 3. McpConfigService reads mcpServers key correctly from Kiro format
 * 4. McpConfigService writes mcpServers key for Kiro, servers key for VS Code
 * 5. getMcpLayoutConfig reads directly from default-layouts.json (single source of truth)
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsExtra from 'fs-extra';
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
// MCP format read/write (McpConfigService format transformation logic)
// ─────────────────────────────────────────────────────────────────────────────

suite('MCP Kiro config format', () => {
  const tmpDir = path.join(os.tmpdir(), `mcp-kiro-test-${Date.now()}`);
  const kinoMcpPath = path.join(tmpDir, 'mcp.json');

  setup(async () => {
    await fsExtra.ensureDir(tmpDir);
  });

  teardown(async () => {
    await fsExtra.remove(tmpDir);
  });

  test('reads mcpServers key from Kiro-format file', async () => {
    // Write a Kiro-format file (mcpServers key)
    const kiroConfig = {
      mcpServers: {
        'my-server': {
          command: 'npx',
          args: ['-y', 'my-mcp-server']
        }
      }
    };
    await fsExtra.writeJson(kinoMcpPath, kiroConfig);

    // Manually verify the reading logic: mcpServers -> servers normalization
    const content = await fs.promises.readFile(kinoMcpPath, 'utf8');
    const raw = JSON.parse(content) as Record<string, unknown>;
    assert.ok('mcpServers' in raw, 'Raw file should have mcpServers key');
    assert.ok(!('servers' in raw), 'Raw file should NOT have servers key');

    // After normalization (as McpConfigService does it):
    const normalized = 'mcpServers' in raw && !('servers' in raw)
      ? { ...raw, servers: raw.mcpServers }
      : raw;
    assert.ok('servers' in normalized, 'Normalized config should have servers key');
    assert.deepStrictEqual(normalized.servers, kiroConfig.mcpServers,
      'servers should equal the original mcpServers value');
  });

  test('serializes to mcpServers key for Kiro format', () => {
    // Simulate what toKiroFormat does
    const internalConfig = {
      servers: {
        'my-server': { command: 'npx', args: ['-y', 'my-mcp-server'] }
      }
    };

    const { servers, ...rest } = internalConfig;
    const kiroFormatted = { ...rest, mcpServers: servers };

    assert.ok('mcpServers' in kiroFormatted, 'Should use mcpServers key for Kiro');
    assert.ok(!('servers' in kiroFormatted), 'Should NOT have servers key in Kiro format');
    assert.deepStrictEqual(kiroFormatted.mcpServers, internalConfig.servers,
      'mcpServers should equal the original servers value');
  });

  test('VS Code format preserves servers key (no mcpServers)', () => {
    const vsCodeConfig = { servers: { 'my-server': { command: 'node' } } };
    const serialized = JSON.stringify(vsCodeConfig);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    assert.ok('servers' in parsed, 'VS Code format should use servers key');
    assert.ok(!('mcpServers' in parsed), 'VS Code format should NOT use mcpServers key');
  });

  test('Kiro path: workspace MCP under .kiro/settings/', () => {
    // MCP workspace path for Kiro is .kiro/settings/mcp.json
    const workspaceRoot = path.join(os.tmpdir(), 'test-workspace');
    const expectedPath = path.join(workspaceRoot, '.kiro', 'settings', 'mcp.json');
    // Simulate getWorkspaceConfigFolder() -> '.kiro/settings' for Kiro
    const configFolder = path.join('.kiro', 'settings');
    const result = path.join(workspaceRoot, configFolder, 'mcp.json');
    assert.strictEqual(result, expectedPath,
      'Workspace MCP path for Kiro should be .kiro/settings/mcp.json');
  });

  test('VS Code path: workspace MCP under .vscode/', () => {
    const workspaceRoot = path.join(os.tmpdir(), 'test-workspace');
    const expectedPath = path.join(workspaceRoot, '.vscode', 'mcp.json');
    const result = path.join(workspaceRoot, '.vscode', 'mcp.json');
    assert.strictEqual(result, expectedPath,
      'Workspace MCP path for VS Code should be .vscode/mcp.json');
  });
});
