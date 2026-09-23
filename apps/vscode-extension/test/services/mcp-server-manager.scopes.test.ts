/**
 * Tests for host/scope behaviour in McpServerManager.
 *
 * Covers the cases the review flagged as untested:
 * - repository-scope install on a host with no workspace-level MCP file must fail
 *   rather than silently retargeting the user's home config
 * - the .git/info/exclude pattern must use forward slashes and the host's real
 *   filename, not a hardcoded `mcp.json`
 * - a bundle whose servers reference `${input:id}` is installed with a warning on
 *   hosts that cannot resolve inputs, so the user can configure the value manually
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsExtra from 'fs-extra';
import * as sinon from 'sinon';
import {
  McpServerManager,
} from '../../src/services/mcp-server-manager';
import type {
  McpServersManifest,
} from '../../src/types/mcp';

/** Global the vscode test mock reads `workspace.workspaceFolders` from. */
const WORKSPACE_FOLDERS_GLOBAL = '__mockWorkspaceFolders';

const hostEnv = async (): Promise<{ appName: string; uriScheme: string }> =>
  (await import('vscode')).env;

suite('McpServerManager — host and scope behaviour', () => {
  let tmpRoot: string;
  let savedWorkspaceFolders: unknown;
  let savedAppName: string;
  let savedUriScheme: string;

  setup(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-scopes-'));
    await fsExtra.ensureDir(path.join(tmpRoot, '.git', 'info'));

    const globals = global as unknown as Record<string, unknown>;
    savedWorkspaceFolders = globals[WORKSPACE_FOLDERS_GLOBAL];
    globals[WORKSPACE_FOLDERS_GLOBAL] = [
      { uri: { fsPath: tmpRoot }, name: 'workspace', index: 0 }
    ];

    const env = await hostEnv();
    savedAppName = env.appName;
    savedUriScheme = env.uriScheme;
  });

  teardown(async () => {
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

  /**
   * Point host detection at a given editor.
   * @param appName - Value for vscode.env.appName.
   * @param uriScheme - Value for vscode.env.uriScheme.
   */
  const setHost = async (appName: string, uriScheme: string): Promise<void> => {
    const env = await hostEnv();
    env.appName = appName;
    env.uriScheme = uriScheme;
  };

  const simpleManifest: McpServersManifest = {
    'my-server': { command: 'npx', args: ['-y', 'my-mcp-server'] }
  };

  const inputReferencingManifest: McpServersManifest = {
    'needs-input': {
      command: 'npx',
      args: ['-y', 'my-mcp-server'],
      env: { API_KEY: '${input:api-key}' }
    }
  };

  suite('repository scope on a host with no workspace-level MCP file', () => {
    test('Windsurf: install fails instead of writing to the user config', async () => {
      await setHost('Windsurf', 'windsurf');

      const result = await new McpServerManager().installServersToWorkspace(
        'bundle-a', '1.0.0', tmpRoot, simpleManifest, { commitMode: 'commit' }
      );

      assert.strictEqual(result.success, false, 'install must not report success');
      assert.ok(result.errors && result.errors.length > 0, 'an error must be reported');
      assert.match(result.errors.join(' '), /workspace-level MCP configuration file/i,
        'the error should explain that the host has no workspace-level MCP file');
    });

    test('Windsurf: nothing is written into the workspace', async () => {
      await setHost('Windsurf', 'windsurf');

      await new McpServerManager().installServersToWorkspace(
        'bundle-a', '1.0.0', tmpRoot, simpleManifest, { commitMode: 'commit' }
      );

      const stray = await fsExtra.pathExists(path.join(tmpRoot, '.vscode', 'mcp.json'));
      assert.strictEqual(stray, false, 'no fallback .vscode/mcp.json should be created');
    });
  });

  suite('git exclude pattern', () => {
    test('Kiro: uses forward slashes so git can match it on Windows', async () => {
      await setHost('Kiro', 'kiro');

      await new McpServerManager().installServersToWorkspace(
        'bundle-a', '1.0.0', tmpRoot, simpleManifest, { commitMode: 'local-only' }
      );

      const exclude = await fs.promises.readFile(
        path.join(tmpRoot, '.git', 'info', 'exclude'), 'utf8'
      );
      assert.ok(exclude.includes('.kiro/settings/mcp.json'),
        `exclude should contain a forward-slash path, got: ${exclude}`);
      assert.ok(!exclude.includes('\\'),
        'exclude must not contain backslashes; git treats them as escapes');
    });

    test('VS Code: excludes .vscode/mcp.json with forward slashes', async () => {
      // VS Code is the fallback host, so this is the path most users hit.
      await setHost('Visual Studio Code', 'vscode');

      await new McpServerManager().installServersToWorkspace(
        'bundle-a', '1.0.0', tmpRoot, simpleManifest, { commitMode: 'local-only' }
      );

      const exclude = await fs.promises.readFile(
        path.join(tmpRoot, '.git', 'info', 'exclude'), 'utf8'
      );
      assert.ok(exclude.includes('.vscode/mcp.json'),
        `exclude should contain a forward-slash path, got: ${exclude}`);
      assert.ok(!exclude.includes('\\'),
        'exclude must not contain backslashes; git treats them as escapes');
    });
  });

  suite('inputs on hosts that cannot resolve them', () => {
    test('Kiro: a server referencing ${input:...} installs with a warning', async () => {
      await setHost('Kiro', 'kiro');

      const result = await new McpServerManager().installServersToWorkspace(
        'bundle-a',
        '1.0.0',
        tmpRoot,
        inputReferencingManifest,
        { commitMode: 'commit' },
        [{ id: 'api-key', type: 'promptString', description: 'API key' }]
      );

      assert.strictEqual(result.success, true,
        `the server should still be written so the user can supply the value manually, errors: ${result.errors?.join(', ')}`);
      assert.match(result.warnings?.join(' ') ?? '', /api-key/,
        'a warning should name the input the host cannot prompt for');

      const written = await fsExtra.readJson(
        path.join(tmpRoot, '.kiro', 'settings', 'mcp.json')
      ) as Record<string, unknown>;
      assert.ok(written.mcpServers, 'the server entry should be present in the Kiro file');
      assert.strictEqual(written.inputs, undefined,
        'no input declaration should be synthesised for a host that never resolves inputs');
    });

    test('Kiro: a server with no input references still installs', async () => {
      await setHost('Kiro', 'kiro');

      const result = await new McpServerManager().installServersToWorkspace(
        'bundle-a', '1.0.0', tmpRoot, simpleManifest, { commitMode: 'commit' }
      );

      assert.strictEqual(result.success, true,
        `install without inputs should succeed, errors: ${result.errors?.join(', ')}`);
      const written = await fsExtra.readJson(
        path.join(tmpRoot, '.kiro', 'settings', 'mcp.json')
      ) as Record<string, unknown>;
      assert.ok(written.mcpServers, 'Kiro file should use the mcpServers key');
    });
  });

  suite('installServers (user scope) on hosts that cannot resolve inputs', () => {
    test('Kiro user scope: input-referencing server installs with a warning', async () => {
      await setHost('Kiro', 'kiro');

      // Stub McpConfigLocator for user-scope resolution to point at our temp dir
      const { McpConfigLocator } = await import('../../src/utils/mcp-config-locator');
      const mockConfigPath = path.join(tmpRoot, 'mcp.json');
      const mockTrackingPath = path.join(tmpRoot, 'mcp-tracking.json');
      const localSandbox = sinon.createSandbox();
      localSandbox.stub(McpConfigLocator, 'getMcpConfigLocation').returns({
        configPath: mockConfigPath,
        trackingPath: mockTrackingPath,
        exists: false,
        serversKey: 'mcpServers',
        supportsInputs: false
      });
      localSandbox.stub(McpConfigLocator, 'ensureConfigDirectory').resolves();

      try {
        const result = await new McpServerManager().installServers(
          'bundle-user',
          '1.0.0',
          tmpRoot,
          inputReferencingManifest,
          { scope: 'user', overwrite: false, skipOnConflict: false },
          [{ id: 'api-key', type: 'promptString', description: 'API key' }]
        );

        assert.strictEqual(result.success, true,
          `user-scope install should succeed with a warning, errors: ${result.errors?.join(', ')}`);
        assert.match(result.warnings?.join(' ') ?? '', /api-key/,
          'a warning should name the input the host cannot prompt for');

        const written = JSON.parse(await fs.promises.readFile(mockConfigPath, 'utf8')) as Record<string, unknown>;
        assert.ok(written.mcpServers, 'the server entry should be present');
        assert.strictEqual(written.inputs, undefined,
          'no input declaration should be synthesised for a host that never resolves inputs');
      } finally {
        localSandbox.restore();
      }
    });
  });
});
