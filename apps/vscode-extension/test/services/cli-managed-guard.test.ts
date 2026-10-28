/**
 * CLI-managed guard tests (BR5.6, NFR4.3).
 *
 * Repository items read from a 3.0.0 install record are refused by update,
 * uninstall, move to user scope and the commit-mode switch, with one warning,
 * no success message and nothing changed on disk. User-scope items with the
 * same id are never refused. Uses a real temp git root; `RegistryStorage`,
 * the installer and the VS Code notification API are stubbed.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleScopeCommands,
} from '../../src/commands/bundle-scope-commands';
import {
  BundleUpdateCommands,
} from '../../src/commands/bundle-update-commands';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RepositoryScopeService,
} from '../../src/services/repository-scope-service';
import {
  ScopeConflictResolver,
} from '../../src/services/scope-conflict-resolver';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import type {
  Bundle,
  InstalledBundle,
  RegistrySource,
} from '../../src/types/registry';
import {
  createMockContext,
  initGitRoot,
  RECORD_FILE,
  snapshotTree,
  writeInstallRecord,
  writeOldLockfile,
} from '../helpers/install-record-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';

const CLI_BUNDLE = 'cli-bundle';

const userItem = (bundleId: string): InstalledBundle => ({
  bundleId,
  version: '1.0.0',
  installedAt: '2026-10-20T10:00:00.000Z',
  scope: 'user',
  installPath: '/mock/user/bundles/x',
  sourceId: 'user-source',
  sourceType: 'local',
  manifest: {
    common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
    bundle_settings: { include_common_in_environment_bundles: false, create_common_bundle: false, compression: 'none', naming: { environment_bundle: bundleId } },
    metadata: { manifest_version: '1.0.0', description: 'user bundle' }
  }
});

suite('CLI-managed guard (install-record items)', () => {
  let sandbox: sinon.SinonSandbox;
  let manager: RegistryManager;
  let storage: sinon.SinonStubbedInstance<RegistryStorage>;
  let installer: { uninstall: sinon.SinonStub; update: sinon.SinonStub; uninstallSkillSymlink: sinon.SinonStub };
  let root: string;
  let showWarning: sinon.SinonStub;
  let showInfo: sinon.SinonStub;
  let showError: sinon.SinonStub;

  const assertCliManaged = async (promise: Promise<unknown>, action: string): Promise<void> => {
    await assert.rejects(promise, (error: unknown) => {
      const registryError = error as { code?: string; context?: Record<string, unknown> };
      assert.strictEqual(registryError.code, 'RECORD.CLI_MANAGED');
      assert.deepStrictEqual(registryError.context, { bundleId: CLI_BUNDLE, action });
      return true;
    });
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.realpathSync(createTestWorkspace());
    initGitRoot(root);
    writeInstallRecord(root, RECORD_FILE, {
      [CLI_BUNDLE]: { vscode: { version: '1.0.0', installedAt: '2026-10-28T10:00:00.000Z', files: ['.github/prompts/cli.prompt.md'] } }
    });
    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance(createMockContext(sandbox));
    storage = sandbox.createStubInstance(RegistryStorage);
    storage.getInstalledBundles.resolves([]);
    storage.getSources.resolves([]);
    storage.getInstalledBundle.resolves(undefined);
    (manager as any).storage = storage;
    installer = { uninstall: sandbox.stub().resolves(), update: sandbox.stub(), uninstallSkillSymlink: sandbox.stub().resolves() };
    (manager as any).installer = installer;
    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(root);
    sandbox.stub(scopeSelectionUI, 'hasOpenWorkspace').returns(true);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    (RegistryManager as any).instance = undefined;
    cleanupTestWorkspace(root);
  });

  const scopeCommands = (): {
    commands: BundleScopeCommands;
    repositoryScopeService: sinon.SinonStubbedInstance<RepositoryScopeService>;
    resolver: sinon.SinonStubbedInstance<ScopeConflictResolver>;
  } => {
    const repositoryScopeService = sandbox.createStubInstance(RepositoryScopeService);
    const resolver = sandbox.createStubInstance(ScopeConflictResolver);
    return { commands: new BundleScopeCommands(manager, resolver, repositoryScopeService), repositoryScopeService, resolver };
  };

  suite('repository scope is refused', () => {
    test('uninstall leaves the tree unchanged', async () => {
      const before = snapshotTree(root);

      await assertCliManaged(manager.uninstallBundle(CLI_BUNDLE, 'repository'), 'uninstall');

      assert.ok(installer.uninstall.notCalled);
      assert.deepStrictEqual(snapshotTree(root), before);
    });

    test('a bundle in both the new and the old record resolves to the new item and is refused', async () => {
      writeOldLockfile(root, 'prompt-registry.lock.json', { [CLI_BUNDLE]: '0.9.0' });
      const before = snapshotTree(root);

      await assertCliManaged(manager.uninstallBundle(CLI_BUNDLE, 'repository'), 'uninstall');

      assert.ok(installer.uninstall.notCalled, 'old-store files are never handed to the installer');
      assert.deepStrictEqual(snapshotTree(root), before);
    });

    test('update from the update command shows one warning and no success message', async () => {
      const before = snapshotTree(root);
      sandbox.stub(manager, 'getBundleDetails').rejects(new Error('not in a source'));
      const commands = new BundleUpdateCommands(manager);

      const updated = await commands.updateBundle(CLI_BUNDLE);

      assert.strictEqual(updated, false);
      assert.ok(installer.update.notCalled);
      assert.strictEqual(showWarning.callCount, 1);
      assert.ok(String(showWarning.firstCall.args[0]).includes(`To update it, run "ai-primitives-hub install ${CLI_BUNDLE}" again.`));
      assert.ok(showInfo.notCalled, 'no success message');
      assert.ok(showError.notCalled);
      assert.deepStrictEqual(snapshotTree(root), before);
      await assertCliManaged(manager.updateBundle(CLI_BUNDLE), 'update');
    });

    test('move to user scope stops before any dialog and changes nothing', async () => {
      const before = snapshotTree(root);
      const { commands, resolver } = scopeCommands();

      await commands.moveToUser(CLI_BUNDLE);

      assert.strictEqual(showWarning.callCount, 1, 'only the refusal; no confirmation dialog');
      const message = String(showWarning.firstCall.args[0]);
      assert.ok(message.includes("The extension can't move it to user scope yet"), message);
      assert.ok(resolver.migrateBundle.notCalled);
      assert.ok(showInfo.notCalled && showError.notCalled);
      assert.deepStrictEqual(snapshotTree(root), before);
    });

    test('commit-mode switch leaves info/exclude and both records unchanged', async () => {
      const before = snapshotTree(root);
      const { commands, repositoryScopeService } = scopeCommands();

      await commands.switchCommitMode(CLI_BUNDLE, 'local-only');

      assert.strictEqual(showWarning.callCount, 1);
      assert.ok(String(showWarning.firstCall.args[0]).includes("The extension can't change its commit mode yet"));
      assert.ok(repositoryScopeService.switchCommitMode.notCalled);
      assert.ok(showInfo.notCalled && showError.notCalled);
      assert.deepStrictEqual(snapshotTree(root), before);
    });

    test('batch uninstall reports refused ids as skipped and uninstalls the others', async () => {
      writeOldLockfile(root, 'prompt-registry.lock.json', { 'old-bundle': '1.0.0' });
      const uninstalledEvents: string[][] = [];
      manager.onBundlesUninstalled((ids) => uninstalledEvents.push(ids));

      await manager.uninstallBundles([CLI_BUNDLE, 'old-bundle'], 'repository');

      assert.deepStrictEqual(installer.uninstall.getCalls().map((call) => call.args[0].bundleId), ['old-bundle']);
      assert.deepStrictEqual(uninstalledEvents, [['old-bundle']]);
      assert.strictEqual(showWarning.callCount, 1);
      const message = String(showWarning.firstCall.args[0]);
      assert.ok(message.startsWith('Skipped 1 bundle(s)') && message.includes(CLI_BUNDLE), message);
    });
  });

  suite('the same id at user scope is never refused', () => {
    const source: RegistrySource = { id: 'user-source', name: 'User', type: 'local', url: '/mock/source', enabled: true, priority: 0 };
    const latest = { id: CLI_BUNDLE, name: 'CLI bundle', version: '2.0.0', sourceId: 'user-source' } as Bundle;

    setup(() => {
      storage.getInstalledBundles.resolves([userItem(CLI_BUNDLE)]);
      storage.getInstalledBundle.withArgs(CLI_BUNDLE, 'user').resolves(userItem(CLI_BUNDLE));
      storage.getSources.resolves([source]);
      storage.recordInstallation.resolves();
      sandbox.stub(manager, 'getBundleDetails').resolves(latest);
      sandbox.stub(manager as any, 'getAdapter').returns({ downloadBundle: sandbox.stub().resolves(Buffer.from('zip')) });
      installer.update.callsFake((current: InstalledBundle) => Promise.resolve({ ...current, version: '2.0.0' }));
    });

    test('user-scope uninstall proceeds', async () => {
      await manager.uninstallBundle(CLI_BUNDLE, 'user');

      assert.strictEqual(installer.uninstall.callCount, 1);
      assert.strictEqual(installer.uninstall.firstCall.args[0].scope, 'user');
    });

    test('user-scope update proceeds on the storage item', async () => {
      await manager.updateBundle(CLI_BUNDLE);

      assert.strictEqual(installer.update.callCount, 1);
      assert.strictEqual(installer.update.firstCall.args[0].scope, 'user');
    });

    test('auto-update of the storage item succeeds', async () => {
      const results = await (manager as any).performBundleUpdates([userItem(CLI_BUNDLE)], [latest]);

      assert.deepStrictEqual(results, { succeeded: [CLI_BUNDLE], failed: [], skipped: [] });
    });

    test('move to repository proceeds (its uninstall targets user scope)', async () => {
      showWarning.resolves('Move');
      sandbox.stub(manager, 'installBundle').resolves();
      const { commands, resolver } = scopeCommands();
      resolver.migrateBundle.callsFake(async (bundleId, fromScope, toScope, uninstall) => {
        await uninstall(userItem(CLI_BUNDLE));
        return { success: true, bundleId, fromScope, toScope };
      });

      await commands.moveToRepository(CLI_BUNDLE, 'commit');

      assert.strictEqual(installer.uninstall.callCount, 1);
      assert.strictEqual(installer.uninstall.firstCall.args[0].scope, 'user');
      assert.ok(showInfo.calledOnce, 'the move reports success');
    });

    test('repository-scope actions on the same id are still refused', async () => {
      await assertCliManaged(manager.uninstallBundle(CLI_BUNDLE, 'repository'), 'uninstall');
      await assertCliManaged(manager.assertNotCliManaged(CLI_BUNDLE, 'repository', 'move-to-user'), 'move-to-user');
      await assertCliManaged(manager.assertNotCliManaged(CLI_BUNDLE, 'repository', 'switch-commit-mode'), 'switch-commit-mode');
      assert.ok(installer.uninstall.notCalled);
    });
  });
});
