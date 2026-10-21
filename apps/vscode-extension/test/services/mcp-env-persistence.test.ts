import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  McpServerManager,
} from '../../src/services/mcp-server-manager';
import type {
  McpServersManifest,
} from '../../src/types/mcp';

const WORKSPACE_FOLDERS_GLOBAL = '__mockWorkspaceFolders';

suite('MCP environment persistence', () => {
  for (const scope of ['user', 'repository'] as const) {
    for (const exported of [true, false]) {
      for (const disabled of [true, false]) {
        test(`Kiro ${scope}: exported=${exported}, disabled=${disabled} writes references, not environment values`, async () => {
          const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-env-'));
          const sandbox = sinon.createSandbox();
          const globals = global as unknown as Record<string, unknown>;
          const folders = globals[WORKSPACE_FOLDERS_GLOBAL];
          const env = vscode.env as { appName: string; uriScheme: string };
          const appName = env.appName;
          const uriScheme = env.uriScheme;
          const original = process.env.APH_TEST_MCP_TOKEN;
          try {
            // Redirect only the home boundary; retain real host/layout resolution and writers.
            sandbox.stub(os, 'homedir').returns(root);
            globals[WORKSPACE_FOLDERS_GLOBAL] = [{ uri: { fsPath: root }, name: 'workspace', index: 0 }];
            env.appName = 'Kiro';
            env.uriScheme = 'kiro';
            if (exported) {
              process.env.APH_TEST_MCP_TOKEN = 'synthetic-regression-sentinel';
            } else {
              delete process.env.APH_TEST_MCP_TOKEN;
            }
            const manifest: McpServersManifest = {
              gateway: {
                type: 'http', url: 'https://example.invalid/mcp', disabled,
                headers: {
                  'x-token': '${env:APH_TEST_MCP_TOKEN}',
                  Authorization: 'Token ${env:APH_TEST_MCP_TOKEN}',
                  'x-empty': '${env:APH_TEST_MCP_TOKEN:-}',
                  'x-default': '${env:APH_TEST_MCP_TOKEN:-anonymous}'
                }
              }
            };
            const manager = new McpServerManager();
            const result = scope === 'user'
              ? await manager.installServers('bundle-env', '1.0.0', root, manifest,
                { scope: 'user', overwrite: false, skipOnConflict: false })
              : await manager.installServersToWorkspace('bundle-env', '1.0.0', root, manifest,
                { commitMode: 'commit' });
            assert.strictEqual(result.success, true, result.errors?.join(', '));
            const content = await fs.readFile(path.join(root, '.kiro', 'settings', 'mcp.json'), 'utf8');
            assert.ok(!content.includes('synthetic-regression-sentinel'), 'installer environment value must not reach disk');
            const written = JSON.parse(content) as {
              mcpServers: Record<string, { headers: Record<string, string>; disabled: boolean }>;
            };
            assert.deepStrictEqual(written.mcpServers['prompt-registry:bundle-env:gateway'], {
              type: 'http', url: 'https://example.invalid/mcp', disabled,
              headers: {
                'x-token': '${APH_TEST_MCP_TOKEN}',
                Authorization: 'Token ${APH_TEST_MCP_TOKEN}',
                'x-empty': '${APH_TEST_MCP_TOKEN:-}',
                'x-default': '${APH_TEST_MCP_TOKEN:-anonymous}'
              }
            });
            const tracking = await fs.readFile(path.join(root, '.kiro', 'settings', 'prompt-registry-mcp-tracking.json'), 'utf8');
            assert.ok(!tracking.includes('synthetic-regression-sentinel'), 'tracking must not persist environment values');
          } finally {
            if (original === undefined) {
              delete process.env.APH_TEST_MCP_TOKEN;
            } else {
              process.env.APH_TEST_MCP_TOKEN = original;
            }
            env.appName = appName;
            env.uriScheme = uriScheme;
            globals[WORKSPACE_FOLDERS_GLOBAL] = folders;
            sandbox.restore();
            await fs.rm(root, { recursive: true, force: true });
          }
        });
      }
    }
  }
});
