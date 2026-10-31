/**
 * Contract tests for the extension-only storage port (BR24.2, NFR1.7):
 * the per-profile bundle-record folders keep their names under the
 * extension's global storage, and records an earlier release wrote there
 * are read as before.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  ExtensionAppStorage,
} from '../../src/storage/extension-app-storage';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  VsCodeAppStorage,
} from '../../src/storage/vscode-app-storage';
import type {
  InstalledBundle,
} from '../../src/types/registry';

suite('ExtensionAppStorage', () => {
  let globalStorage: string;
  let context: vscode.ExtensionContext;

  setup(() => {
    globalStorage = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-app-storage-')));
    context = {
      globalStorageUri: vscode.Uri.file(globalStorage),
      globalState: { get: <T>(_key: string, defaultValue: T) => defaultValue, update: () => Promise.resolve() }
    } as unknown as vscode.ExtensionContext;
  });

  teardown(() => {
    fs.rmSync(globalStorage, { recursive: true, force: true });
  });

  test('VsCodeAppStorage keeps the per-profile record folders under global storage', () => {
    const storage: ExtensionAppStorage = new VsCodeAppStorage(context);
    const paths = storage.getPaths();

    assert.strictEqual(paths.installed, path.join(globalStorage, 'installed'));
    assert.strictEqual(paths.userInstalled, path.join(globalStorage, 'installed', 'user'));
    assert.strictEqual(paths.profilesInstalled, path.join(globalStorage, 'installed', 'profiles'));
  });

  test('a default-built RegistryStorage lists user and workspace records an earlier release wrote', async () => {
    const record = (bundleId: string, scope: 'user' | 'workspace'): InstalledBundle => ({
      bundleId,
      version: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      scope,
      installPath: path.join(globalStorage, 'bundles', bundleId),
      manifest: {} as InstalledBundle['manifest'],
      sourceId: 'github-abc123'
    });
    const userRecord = record('owner/user-bundle', 'user');
    const workspaceRecord = record('workspace-bundle', 'workspace');
    // Earlier releases wrote one JSON file per bundle, named by its sanitized id.
    fs.mkdirSync(path.join(globalStorage, 'installed', 'user'), { recursive: true });
    fs.writeFileSync(path.join(globalStorage, 'installed', 'user', 'owner_user-bundle.json'), JSON.stringify(userRecord, null, 2));
    fs.writeFileSync(path.join(globalStorage, 'installed', 'workspace-bundle.json'), JSON.stringify(workspaceRecord, null, 2));

    const storage = new RegistryStorage(context);

    assert.deepStrictEqual(await storage.getInstalledBundles('user'), [userRecord]);
    assert.deepStrictEqual(await storage.getInstalledBundles('workspace'), [workspaceRecord]);
    assert.deepStrictEqual(await storage.getInstalledBundle('owner/user-bundle', 'user'), userRecord);
    assert.deepStrictEqual(await storage.getInstalledBundle('workspace-bundle', 'workspace'), workspaceRecord);
  });
});
