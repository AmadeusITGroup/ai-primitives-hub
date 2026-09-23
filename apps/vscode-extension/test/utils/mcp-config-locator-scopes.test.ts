/**
 * Tests for McpConfigLocator: per-scope config resolution from default-layouts.json.
 *
 * Covers that mcpConfig is read per scope, that a missing scope entry means
 * "unsupported at this scope" and is never inherited from the other scope, and that
 * path templates resolve including the filename (so hosts whose file is not named
 * mcp.json resolve correctly).
 */

import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  McpConfigLocator,
} from '../../src/utils/mcp-config-locator';

// ─────────────────────────────────────────────────────────────────────────────
// getMcpLayoutConfig — per-scope access to default-layouts.json
// ─────────────────────────────────────────────────────────────────────────────

suite('McpConfigLocator.getMcpLayoutConfig — reads per scope from default-layouts.json', () => {
  test('Kiro user: mcpServers key, HOME-relative path', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('kiro', 'user');
    assert.ok(mc, 'Kiro should define a user-scope mcpConfig');
    assert.strictEqual(mc.serversKey, 'mcpServers');
    assert.strictEqual(mc.path, '${HOME}/.kiro/settings/mcp.json');
  });

  test('Kiro repository: workspaceRoot-relative path', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('kiro', 'repository');
    assert.ok(mc, 'Kiro should define a repository-scope mcpConfig');
    assert.strictEqual(mc.serversKey, 'mcpServers');
    assert.strictEqual(mc.path, '${workspaceRoot}/.kiro/settings/mcp.json');
  });

  test('VS Code user: servers key, vscodeUserDir token', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('vscode', 'user');
    assert.ok(mc, 'VS Code should define a user-scope mcpConfig');
    assert.strictEqual(mc.serversKey, 'servers');
    assert.strictEqual(mc.path, '${vscodeUserDir}/mcp.json');
  });

  test('VS Code repository: .vscode/mcp.json', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('vscode', 'repository');
    assert.ok(mc);
    assert.strictEqual(mc.path, '${workspaceRoot}/.vscode/mcp.json');
  });

  test('Claude Code repository: root-level .mcp.json, not mcp.json', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('claude-code', 'repository');
    assert.ok(mc);
    assert.strictEqual(mc.path, '${workspaceRoot}/.mcp.json');
  });

  test('Windsurf user: mcp_config.json filename', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('windsurf', 'user');
    assert.ok(mc);
    assert.strictEqual(mc.serversKey, 'mcpServers');
    assert.ok(mc.path.endsWith('mcp_config.json'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope independence — absence must not be inherited
// ─────────────────────────────────────────────────────────────────────────────

suite('McpConfigLocator — scope independence', () => {
  test('Windsurf has no repository-scope MCP config', () => {
    // Windsurf documents no workspace-level MCP file. Inheriting the user entry
    // would make a repository-scope install write into the user's home config.
    assert.strictEqual(
      McpConfigLocator.getMcpLayoutConfig('windsurf', 'repository'),
      undefined,
      'windsurf repository mcpConfig must not fall back to the user entry'
    );
  });

  test('Copilot CLI still has a user-scope MCP config', () => {
    const mc = McpConfigLocator.getMcpLayoutConfig('copilot-cli', 'user');
    assert.ok(mc, 'user scope should be unaffected by the missing repository entry');
    assert.strictEqual(mc.serversKey, 'mcpServers');
  });

  test('an unknown target type has no MCP config at either scope', () => {
    assert.strictEqual(McpConfigLocator.getMcpLayoutConfig('emacs' as never, 'user'), undefined);
    assert.strictEqual(McpConfigLocator.getMcpLayoutConfig('emacs' as never, 'repository'), undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────────────────────────────────────

suite('McpConfigLocator — path resolution', () => {
  test('Kiro user: resolves ${HOME} to the home directory', () => {
    const result = McpConfigLocator.getMcpConfigPath('user', 'kiro');
    assert.strictEqual(result, path.join(os.homedir(), '.kiro', 'settings', 'mcp.json'));
  });

  test('Windsurf user: resolves to ~/.codeium/windsurf/mcp_config.json', () => {
    const result = McpConfigLocator.getMcpConfigPath('user', 'windsurf');
    assert.strictEqual(result, path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'));
  });

  test('Claude Code user: resolves to ~/.claude.json', () => {
    const result = McpConfigLocator.getMcpConfigPath('user', 'claude-code');
    assert.strictEqual(result, path.join(os.homedir(), '.claude.json'));
  });

  test('VS Code user: resolves the vscodeUserDir token, leaving no literal token', () => {
    const result = McpConfigLocator.getMcpConfigPath('user', 'vscode');
    assert.ok(result, 'VS Code user path should resolve');
    assert.ok(!result.includes('${'), `token left unresolved in ${result}`);
    assert.ok(result.endsWith('mcp.json'));
    assert.ok(!result.includes(path.join('.kiro', 'settings')), 'must not be the Kiro path');
  });

  test('VS Code user: resolves the default profile, not a per-profile path (known limitation)', () => {
    // Documents a known limitation rather than desired behaviour: globalStorageUri is
    // not profile-scoped, so <userDataDir>/User/profiles/<id>/mcp.json is never
    // targeted. No API resolves the active profile (microsoft/vscode#160466 and
    // #211890, both closed as not planned).
    // See docs/contributor-guide/architecture/mcp-integration.md.
    const result = McpConfigLocator.getMcpConfigPath('user', 'vscode');
    assert.ok(result);
    assert.ok(!result.includes(`${path.sep}profiles${path.sep}`),
      'user path is default-profile only; update the docs if this ever changes');
  });

  test('repository scope: resolves ${workspaceRoot} from the supplied root', () => {
    const root = path.join(os.tmpdir(), 'some-workspace');
    const result = McpConfigLocator.getMcpConfigPath('repository', 'kiro', root);
    assert.strictEqual(result, path.join(root, '.kiro', 'settings', 'mcp.json'));
  });

  test('repository scope: Claude Code keeps its root-level .mcp.json filename', () => {
    const root = path.join(os.tmpdir(), 'some-workspace');
    const result = McpConfigLocator.getMcpConfigPath('repository', 'claude-code', root);
    assert.strictEqual(result, path.join(root, '.mcp.json'));
  });

  test('repository scope: undefined when the IDE has no workspace-level file', () => {
    const root = path.join(os.tmpdir(), 'some-workspace');
    assert.strictEqual(McpConfigLocator.getMcpConfigPath('repository', 'windsurf', root), undefined);
  });

  test('tracking file sits beside the config file', () => {
    const location = McpConfigLocator.getMcpConfigLocation('user', 'kiro');
    assert.ok(location);
    assert.strictEqual(path.dirname(location.trackingPath), path.dirname(location.configPath));
  });

  test('location carries the serversKey for the scope', () => {
    const location = McpConfigLocator.getMcpConfigLocation('user', 'kiro');
    assert.ok(location);
    assert.strictEqual(location.serversKey, 'mcpServers');
  });

  test('getMcpWorkspaceConfigFolder returns the folder relative to the workspace root', () => {
    assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('kiro'), path.join('.kiro', 'settings'));
    assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('vscode'), '.vscode');
  });

  test('getMcpWorkspaceConfigFolder returns "." for a root-level config file', () => {
    assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('claude-code'), '.');
  });

  test('repository path keeps the real filename for root-level configs', () => {
    // The git-exclude pattern is derived from this path, so a hardcoded "mcp.json"
    // here would exclude the wrong file for hosts using .mcp.json.
    const root = path.join(os.tmpdir(), 'ws');
    for (const host of ['claude-code', 'copilot-cli'] as const) {
      assert.strictEqual(
        McpConfigLocator.getMcpConfigPath('repository', host, root),
        path.join(root, '.mcp.json'),
        `${host} repository config should be <root>/.mcp.json`
      );
    }
  });

  test('getMcpWorkspaceConfigFolder is undefined when there is no repository-scope file', () => {
    assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('windsurf'), undefined);
  });

  test('vscode-insiders resolves the same MCP shape as vscode', () => {
    // Insiders is a separate target entry, so it can silently drift from vscode.
    for (const scope of ['user', 'repository'] as const) {
      const stable = McpConfigLocator.getMcpLayoutConfig('vscode', scope);
      const insiders = McpConfigLocator.getMcpLayoutConfig('vscode-insiders', scope);
      assert.ok(insiders, `vscode-insiders should define a ${scope} mcpConfig`);
      assert.deepStrictEqual(insiders, stable,
        `vscode-insiders ${scope} mcpConfig should match vscode`);
    }
  });

  test('copilot-cli has a repository-scope config at the project root', () => {
    // Copilot CLI reads .mcp.json from the project root; it previously had no
    // repository entry at all, which made repo-scope installs fail.
    const mc = McpConfigLocator.getMcpLayoutConfig('copilot-cli', 'repository');
    assert.ok(mc, 'copilot-cli should define a repository-scope mcpConfig');
    assert.strictEqual(mc.path, '${workspaceRoot}/.mcp.json');
  });

  test('only VS Code hosts declare input support', () => {
    // ${input:id} is a VS Code Copilot feature. Any other host receives the
    // placeholder literally, so the flag must stay off for them.
    assert.strictEqual(McpConfigLocator.getMcpLayoutConfig('vscode', 'user')?.supportsInputs, true);
    assert.strictEqual(McpConfigLocator.getMcpLayoutConfig('vscode-insiders', 'user')?.supportsInputs, true);
    for (const host of ['kiro', 'windsurf', 'claude-code', 'copilot-cli'] as const) {
      assert.notStrictEqual(
        McpConfigLocator.getMcpLayoutConfig(host, 'user')?.supportsInputs,
        true,
        `${host} must not declare input support`
      );
    }
  });
});
