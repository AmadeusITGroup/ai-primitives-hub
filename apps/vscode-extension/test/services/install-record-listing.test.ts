/**
 * Install record listing contract (BR5.1, BR5.2, BR5.4, BR5.5).
 *
 * Drives `RegistryManager.listInstalledBundles('repository')` against a real
 * temp git root; only `RegistryStorage`, `getWorkspaceRoot()` and the VS Code
 * notification API are stubbed.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  createMockContext,
  initGitRoot,
  LOCAL_RECORD_FILE,
  RECORD_FILE,
  writeInstallRecord,
  writeOldLockfile,
} from '../helpers/install-record-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';

suite('Install record listing (repository scope)', () => {
  let sandbox: sinon.SinonSandbox;
  let manager: RegistryManager;
  let root: string;
  let showWarning: sinon.SinonStub;

  const list = async (): Promise<{ bundleId: string; version: string }[]> =>
    (await manager.listInstalledBundles('repository')).map(({ bundleId, version }) => ({ bundleId, version }));

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.realpathSync.native(createTestWorkspace());
    initGitRoot(root);
    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance(createMockContext(sandbox));
    const storage = sandbox.createStubInstance(RegistryStorage);
    storage.getInstalledBundles.resolves([]);
    storage.getSources.resolves([]);
    (manager as any).storage = storage;
    sandbox.stub(require('../../src/utils/scope-selection-ui'), 'getWorkspaceRoot').returns(root);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    (RegistryManager as any).instance = undefined;
    cleanupTestWorkspace(root);
  });

  test('the new record wins over the old lockfile for the same bundle id', async () => {
    writeInstallRecord(root, RECORD_FILE, {
      shared: { vscode: { version: '2.0.0', installedAt: '2026-10-28T10:00:00.000Z', file: '.github/prompts/shared.prompt.md' } }
    });
    writeOldLockfile(root, 'prompt-registry.lock.json', { shared: '1.0.0', 'old-only': '1.5.0' });

    const items = await list();

    assert.deepStrictEqual(items.toSorted((a, b) => a.bundleId.localeCompare(b.bundleId)), [
      { bundleId: 'old-only', version: '1.5.0' },
      { bundleId: 'shared', version: '2.0.0' }
    ]);
    assert.ok(showWarning.notCalled);
  });

  test('tools of one bundle split across the two files list as one item without a warning', async () => {
    writeInstallRecord(root, RECORD_FILE, {
      split: { vscode: { version: '1.0.0', installedAt: '2026-10-27T10:00:00.000Z', file: '.github/prompts/split.prompt.md' } }
    });
    writeInstallRecord(root, LOCAL_RECORD_FILE, {
      split: { kiro: { version: '1.1.0', installedAt: '2026-10-28T10:00:00.000Z', file: '.kiro/steering/split.md' } }
    });

    assert.deepStrictEqual(await list(), [{ bundleId: 'split', version: '1.1.0' }]);
    assert.ok(showWarning.notCalled);
  });

  test('the same bundle and tool in both files is warned about once', async () => {
    writeInstallRecord(root, RECORD_FILE, {
      dup: { vscode: { version: '1.0.0', installedAt: '2026-10-27T10:00:00.000Z', file: '.github/prompts/dup.prompt.md' } }
    });
    writeInstallRecord(root, LOCAL_RECORD_FILE, {
      dup: { vscode: { version: '9.0.0', installedAt: '2026-10-28T10:00:00.000Z', file: '.github/prompts/dup-local.prompt.md' } }
    });

    await list();
    const items = await list();

    assert.deepStrictEqual(items, [{ bundleId: 'dup', version: '1.0.0' }]);
    assert.strictEqual(showWarning.callCount, 1);
    assert.ok(String(showWarning.firstCall.args[0]).includes('"dup"'));
  });

  test('a malformed record is warned about once and the old entries are still listed', async () => {
    fs.writeFileSync(path.join(root, RECORD_FILE), '{ not json');
    writeOldLockfile(root, 'prompt-registry.lock.json', { legacy: '1.0.0' });

    await list();
    const items = await list();

    assert.deepStrictEqual(items, [{ bundleId: 'legacy', version: '1.0.0' }]);
    assert.strictEqual(showWarning.callCount, 1);
    assert.ok(String(showWarning.firstCall.args[0]).includes('RECORD.MALFORMED'));
    assert.strictEqual(fs.readFileSync(path.join(root, RECORD_FILE), 'utf8'), '{ not json');
  });
});
