/**
 * Tests for McpConfigService against a real MCP config file on disk.
 *
 * Drives the actual read -> merge -> write lifecycle rather than the format helpers in
 * isolation, because the install path (mergeServers) is where the "unrelated IDE state
 * is preserved" guarantee is easiest to break.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsExtra from 'fs-extra';
import {
  McpConfigService,
} from '../../src/services/mcp-config-service';

/** Global the vscode test mock reads `workspace.workspaceFolders` from. */
const WORKSPACE_FOLDERS_GLOBAL = '__mockWorkspaceFolders';
// ─────────────────────────────────────────────────────────────────────────────
// McpConfigService — real read → modify → write cycle against a temp workspace
// ─────────────────────────────────────────────────────────────────────────────

suite('McpConfigService — Kiro workspace round-trip', () => {
  let tmpRoot: string;
  let kiroMcpPath: string;
  let savedWorkspaceFolders: unknown;
  let savedAppName: string;
  let savedUriScheme: string;

  /**
   * Host env accessor. The vscode mock exposes appName/uriScheme as writable, which is
   * how host detection is steered at Kiro for these tests.
   */
  const hostEnv = async (): Promise<{ appName: string; uriScheme: string }> =>
    (await import('vscode')).env;

  setup(async () => {
    // mkdtemp rather than a Date.now() suffix: two runs in the same millisecond would
    // otherwise share a directory and delete each other's fixtures.
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-kiro-e2e-'));
    kiroMcpPath = path.join(tmpRoot, '.kiro', 'settings', 'mcp.json');
    await fsExtra.ensureDir(path.dirname(kiroMcpPath));

    const globals = global as unknown as Record<string, unknown>;
    savedWorkspaceFolders = globals[WORKSPACE_FOLDERS_GLOBAL];
    globals[WORKSPACE_FOLDERS_GLOBAL] = [
      { uri: { fsPath: tmpRoot }, name: 'workspace', index: 0 }
    ];

    const env = await hostEnv();
    savedAppName = env.appName;
    savedUriScheme = env.uriScheme;
    env.appName = 'Kiro';
    env.uriScheme = 'kiro';
  });

  teardown(async () => {
    // Restore in a finally chain: if any single restore throws, the rest still run.
    // Leaving appName as 'Kiro' would silently repoint host detection for every
    // subsequent suite in the run.
    try {
      const globals = global as unknown as Record<string, unknown>;
      globals[WORKSPACE_FOLDERS_GLOBAL] = savedWorkspaceFolders;
    } finally {
      try {
        const env = await hostEnv();
        env.appName = savedAppName;
        env.uriScheme = savedUriScheme;
      } finally {
        await fsExtra.remove(tmpRoot);
      }
    }
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
