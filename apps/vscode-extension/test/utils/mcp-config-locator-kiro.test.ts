/**
 * MCP path, scope and format tests.
 *
 * Tests that:
 * 1. `mcpConfig` is read per scope from default-layouts.json (single source of truth)
 * 2. Absence of a scope's `mcpConfig` means "unsupported at this scope" and is never
 *    inherited from the other scope
 * 3. Path templates resolve for Kiro, VS Code and Windsurf, including the filename
 *    (so hosts whose file is not `mcp.json` work)
 * 4. The real shared format helpers map between the internal `servers` key and each
 *    IDE's on-disk key without losing `inputs`/`tasks` or leaving a stale second map
 * 5. The real McpConfigService read -> modify -> write cycle round-trips on disk
 *
 * Items 4 and 5 deliberately call production code. An earlier version of this file
 * re-implemented the transformation inline, so it passed regardless of what the
 * extension did and missed a serialization bug that dropped `inputs`.
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

/** Global the vscode test mock reads `workspace.workspaceFolders` from. */
const WORKSPACE_FOLDERS_GLOBAL = '__mockWorkspaceFolders';

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

  test('Copilot CLI has no repository-scope MCP config', () => {
    assert.strictEqual(
      McpConfigLocator.getMcpLayoutConfig('copilot-cli', 'repository'),
      undefined
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

  test('getMcpWorkspaceConfigFolder is undefined when there is no repository-scope file', () => {
    assert.strictEqual(McpConfigLocator.getMcpWorkspaceConfigFolder('windsurf'), undefined);
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

// ─────────────────────────────────────────────────────────────────────────────
// McpConfigService — real read → modify → write cycle against a temp workspace
// ─────────────────────────────────────────────────────────────────────────────

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

  test('mergeServers preserves unrelated top-level state through a full install', async () => {
    // Regression: both merge sites rebuilt the config from only servers/tasks/inputs,
    // dropping every other top-level key BEFORE serialization ran. Hosts such as
    // Claude Code keep projects, account and preference state as siblings in the same
    // file, so an install truncated it. The sibling round-trip tests missed this
    // because they call readMcpConfig -> writeMcpConfig directly and never go through
    // the merge, which is the path a real install takes.
    await fsExtra.writeJson(kiroMcpPath, {
      mcpServers: { existing: { command: 'node' } },
      projects: { '/some/repo': { allowedTools: ['read'] } },
      primaryApiKey: 'secret-value',
      numStartups: 42
    });

    const service = new McpConfigService();
    const existing = await service.readMcpConfig('workspace');

    const merged = await service.mergeServers(
      existing,
      { 'new-server': { command: 'npx', args: ['-y', 'pkg'] } },
      { scope: 'workspace', overwrite: false, skipOnConflict: false }
    );
    await service.writeMcpConfig(merged.config, 'workspace', false);

    const onDisk = await fsExtra.readJson(kiroMcpPath) as Record<string, unknown>;

    assert.deepStrictEqual(onDisk.projects, { '/some/repo': { allowedTools: ['read'] } },
      'unrelated project state must survive an install');
    assert.strictEqual(onDisk.primaryApiKey, 'secret-value',
      'credential state must survive an install');
    assert.strictEqual(onDisk.numStartups, 42,
      'unrelated scalar state must survive an install');

    const servers = onDisk.mcpServers as Record<string, unknown>;
    assert.ok(servers.existing, 'pre-existing server should remain');
    assert.ok(servers['new-server'], 'newly installed server should be present');
  });

  test('a read → write cycle leaves exactly one server map', async () => {
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
