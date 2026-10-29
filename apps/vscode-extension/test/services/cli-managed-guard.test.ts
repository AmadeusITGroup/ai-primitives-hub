/**
 * CLI-managed guard contract (BR5.6, NFR4.3).
 *
 * Repository items read from a 3.0.0 install record are refused by
 * uninstall, update, move to user scope and the commit-mode switch, with
 * nothing changed on disk and no success message. The same id at user scope
 * is not refused. Uses a real temp git root; `RegistryStorage`, the installer
 * and the VS Code notification API are stubbed.
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
  InstalledBundle,
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

suite('CLI-managed guard (install-record items)', () => {
  let sandbox: sinon.SinonSandbox;
  let manager: RegistryManager;
  let storage: sinon.SinonStubbedInstance<RegistryStorage>;
  let installer: { uninstall: sinon.SinonStub; update: sinon.SinonStub; uninstallSkillSymlink: sinon.SinonStub };
  let root: string;
  let showWarning: sinon.SinonStub;
  let showInfo: sinon.SinonStub;

  const scopeCommands = (): BundleScopeCommands => new BundleScopeCommands(
    manager,
    sandbox.createStubInstance(ScopeConflictResolver),
    sandbox.createStubInstance(RepositoryScopeService)
  );

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.realpathSync(createTestWorkspace());
    initGitRoot(root);
    writeInstallRecord(root, RECORD_FILE, {
      [CLI_BUNDLE]: { vscode: { version: '1.0.0', installedAt: '2026-10-28T10:00:00.000Z', file: '.github/prompts/cli.prompt.md' } }
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
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    (RegistryManager as any).instance = undefined;
    cleanupTestWorkspace(root);
  });

  /** Each command shows exactly the CLI-managed refusal (no confirmation dialog first). */
  const assertRefusalShown = (): void => {
    assert.strictEqual(showWarning.callCount, 1);
    assert.ok(String(showWarning.firstCall.args[0]).includes('was installed with the ai-primitives-hub CLI'));
  };

  const refusedActions: [string, () => Promise<unknown>][] = [
    ['uninstall', () => manager.uninstallBundle(CLI_BUNDLE, 'repository').then(
      () => assert.fail('uninstall should be refused'),
      (error: { code?: string }) => assert.strictEqual(error.code, 'RECORD.CLI_MANAGED')
    )],
    ['update', async () => {
      sandbox.stub(manager, 'getBundleDetails').rejects(new Error('not in a source'));
      assert.strictEqual(await new BundleUpdateCommands(manager).updateBundle(CLI_BUNDLE), false);
      assertRefusalShown();
    }],
    ['move to user scope', async () => {
      await scopeCommands().moveToUser(CLI_BUNDLE);
      assertRefusalShown();
    }],
    ['commit-mode switch', async () => {
      await scopeCommands().switchCommitMode(CLI_BUNDLE, 'local-only');
      assertRefusalShown();
    }]
  ];

  refusedActions.forEach(([action, run]) => {
    test(`repository-scope ${action} is refused with the tree unchanged and no success message`, async () => {
      const before = snapshotTree(root);

      await run();

      assert.ok(installer.uninstall.notCalled && installer.update.notCalled);
      assert.ok(showInfo.notCalled, 'no success message');
      assert.deepStrictEqual(snapshotTree(root), before);
    });
  });

  test('the same id at user scope is uninstalled', async () => {
    const userItem = { bundleId: CLI_BUNDLE, version: '1.0.0', scope: 'user', installPath: '/mock/user/x' } as InstalledBundle;
    storage.getInstalledBundles.resolves([userItem]);
    storage.getInstalledBundle.withArgs(CLI_BUNDLE, 'user').resolves(userItem);

    await manager.uninstallBundle(CLI_BUNDLE, 'user');

    assert.strictEqual(installer.uninstall.callCount, 1);
    assert.strictEqual(installer.uninstall.firstCall.args[0].scope, 'user');
  });

  test('batch uninstall reports refused ids as skipped and uninstalls the others', async () => {
    writeOldLockfile(root, 'prompt-registry.lock.json', { 'old-bundle': '1.0.0' });

    await manager.uninstallBundles([CLI_BUNDLE, 'old-bundle'], 'repository');

    assert.deepStrictEqual(installer.uninstall.getCalls().map((call) => call.args[0].bundleId), ['old-bundle']);
    const message = String(showWarning.firstCall.args[0]);
    assert.ok(message.startsWith('Skipped 1 bundle(s)') && message.includes(CLI_BUNDLE), message);
  });
});
