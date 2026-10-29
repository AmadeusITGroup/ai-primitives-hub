/**
 * Install record listing tests (BR5.1, BR5.2, BR5.4, BR5.5).
 *
 * Drives `RegistryManager.listInstalledBundles('repository')` against a real
 * temp git root holding the 3.0.0 records and the prompt-registry lockfiles;
 * only `RegistryStorage`, `getWorkspaceRoot()` and the VS Code notification
 * API are stubbed.
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
  Logger,
} from '../../src/utils/logger';
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
  let logWarn: sinon.SinonSpy;

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
    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(root);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    logWarn = sandbox.spy(Logger.getInstance(), 'warn');
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    (RegistryManager as any).instance = undefined;
    cleanupTestWorkspace(root);
  });

  test('merges the new record with the old lockfile, the new record winning for the same id', async () => {
    writeInstallRecord(root, RECORD_FILE, {
      shared: { vscode: { version: '2.0.0', installedAt: '2026-10-28T10:00:00.000Z', files: ['.github/prompts/shared.prompt.md'] } }
    });
    writeOldLockfile(root, 'prompt-registry.lock.json', { shared: '1.0.0', 'old-only': '1.5.0' });

    const items = await manager.listInstalledBundles('repository');

    assert.deepStrictEqual(items.map((item) => item.bundleId).toSorted(), ['old-only', 'shared']);
    const shared = items.find((item) => item.bundleId === 'shared')!;
    assert.strictEqual(shared.version, '2.0.0');
    assert.strictEqual(shared.recordOrigin, 'install-record');
    const oldOnly = items.find((item) => item.bundleId === 'old-only')!;
    assert.strictEqual(oldOnly.version, '1.5.0');
    assert.strictEqual(oldOnly.recordOrigin, undefined);
    assert.ok(showWarning.notCalled, 'a clean merge reports nothing');
  });

  test('sets every field from the latest tool entry, with installPath at .github', async () => {
    writeInstallRecord(root, RECORD_FILE, {
      acme: {
        vscode: { version: '1.0.0', installedAt: '2026-10-27T10:00:00.000Z', files: ['.github/prompts/acme.prompt.md'] },
        kiro: {
          version: '1.1.0',
          installedAt: '2026-10-28T10:00:00.000Z',
          files: ['.kiro/steering/acme.md'],
          sourceId: 'kiro-source',
          sourceType: 'local'
        }
      }
    });

    const [item] = await manager.listInstalledBundles('repository');

    assert.strictEqual(item.bundleId, 'acme');
    assert.strictEqual(item.version, '1.1.0');
    assert.strictEqual(item.installedAt, '2026-10-28T10:00:00.000Z');
    assert.strictEqual(item.sourceId, 'kiro-source');
    assert.strictEqual(item.sourceType, 'local');
    assert.strictEqual(item.scope, 'repository');
    assert.strictEqual(item.commitMode, 'commit');
    assert.strictEqual(item.filesMissing, false);
    assert.strictEqual(item.recordOrigin, 'install-record');
    assert.strictEqual(item.installPath, path.join(root, '.github'));
    assert.ok(item.installPath.endsWith(`${path.sep}.github`));
    assert.notStrictEqual(item.installPath, root, 'never the git root itself');
    assert.deepStrictEqual(item.manifest.common.files, ['.kiro/steering/acme.md']);
    assert.strictEqual(item.manifest.metadata.description, 'Repository bundle: acme');
  });

  test('takes commitMode from the file and flags missing files', async () => {
    writeInstallRecord(root, LOCAL_RECORD_FILE, {
      local: {
        vscode: {
          version: '1.0.0',
          installedAt: '2026-10-28T10:00:00.000Z',
          files: ['.github/prompts/present.prompt.md'],
          missing: ['.github/prompts/gone.prompt.md']
        }
      }
    });

    const [item] = await manager.listInstalledBundles('repository');

    assert.strictEqual(item.commitMode, 'local-only');
    assert.strictEqual(item.filesMissing, true);
  });

  test('lists a bundle whose tools are split across the two files as one item from the latest entry, with no warning', async () => {
    writeInstallRecord(root, RECORD_FILE, {
      split: { vscode: { version: '1.0.0', installedAt: '2026-10-27T10:00:00.000Z', files: ['.github/prompts/split.prompt.md'] } }
    });
    writeInstallRecord(root, LOCAL_RECORD_FILE, {
      split: { kiro: { version: '1.1.0', installedAt: '2026-10-28T10:00:00.000Z', files: ['.kiro/steering/split.md'] } }
    });

    const items = await manager.listInstalledBundles('repository');

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].bundleId, 'split');
    assert.strictEqual(items[0].version, '1.1.0');
    assert.strictEqual(items[0].commitMode, 'local-only', 'commitMode comes from the file holding the latest entry');
    assert.deepStrictEqual(items[0].manifest.common.files, ['.kiro/steering/split.md']);
    assert.ok(showWarning.notCalled, 'a split bundle is not a conflict');
    assert.strictEqual(logWarn.getCalls().filter((call) => String(call.args[0]).includes('"split"')).length, 0);

    // The latest entry in the committed file gives commit.
    writeInstallRecord(root, RECORD_FILE, {
      split: { vscode: { version: '2.0.0', installedAt: '2026-10-29T10:00:00.000Z', files: ['.github/prompts/split.prompt.md'] } }
    });
    const [item] = await manager.listInstalledBundles('repository');
    assert.strictEqual(item.version, '2.0.0');
    assert.strictEqual(item.commitMode, 'commit');
    assert.ok(showWarning.notCalled);
  });

  test('lists the same bundle and tool in both new files from the committed file and reports it once', async () => {
    writeInstallRecord(root, RECORD_FILE, {
      dup: { vscode: { version: '1.0.0', installedAt: '2026-10-27T10:00:00.000Z', files: ['.github/prompts/dup.prompt.md'] } }
    });
    writeInstallRecord(root, LOCAL_RECORD_FILE, {
      dup: { vscode: { version: '9.0.0', installedAt: '2026-10-28T10:00:00.000Z', files: ['.github/prompts/dup-local.prompt.md'] } }
    });

    const first = await manager.listInstalledBundles('repository');
    const second = await manager.listInstalledBundles('repository');

    for (const items of [first, second]) {
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].version, '1.0.0');
      assert.strictEqual(items[0].commitMode, 'commit');
    }
    assert.strictEqual(showWarning.callCount, 1, 'shown once for the same files and content');
    const message = String(showWarning.firstCall.args[0]);
    assert.ok(message.includes('"dup"') && message.includes(RECORD_FILE) && message.includes(LOCAL_RECORD_FILE), message);
    const logged = logWarn.getCalls().filter((call) => String(call.args[0]).includes('"dup"'));
    assert.strictEqual(logged.length, 2, 'logged on every refresh');
  });

  test('shows a malformed new file once, still lists the old entries, and shows it again after it changes', async () => {
    const recordPath = path.join(root, RECORD_FILE);
    fs.writeFileSync(recordPath, '{ not json');
    writeOldLockfile(root, 'prompt-registry.lock.json', { legacy: '1.0.0' });

    const first = await manager.listInstalledBundles('repository');
    const second = await manager.listInstalledBundles('repository');

    for (const items of [first, second]) {
      assert.deepStrictEqual(items.map((item) => item.bundleId), ['legacy']);
    }
    assert.strictEqual(showWarning.callCount, 1);
    const message = String(showWarning.firstCall.args[0]);
    assert.ok(message.includes('RECORD.MALFORMED') && message.includes(RECORD_FILE), message);
    assert.strictEqual(fs.readFileSync(recordPath, 'utf8'), '{ not json', 'the file is left unchanged');

    fs.writeFileSync(recordPath, '{ still not json');
    await manager.listInstalledBundles('repository');
    assert.strictEqual(showWarning.callCount, 2, 'new content is shown again');
  });

  test('reports a record from a newer release and lists the other file', async () => {
    fs.writeFileSync(path.join(root, RECORD_FILE), JSON.stringify({ version: '4.0.0', bundles: {} }));
    writeInstallRecord(root, LOCAL_RECORD_FILE, {
      ok: { kiro: { version: '1.0.0', installedAt: '2026-10-28T10:00:00.000Z', files: ['.kiro/steering/ok.md'] } }
    });

    const items = await manager.listInstalledBundles('repository');

    assert.deepStrictEqual(items.map((item) => item.bundleId), ['ok']);
    assert.ok(String(showWarning.firstCall.args[0]).includes('RECORD.NEWER_FORMAT'));
  });

  test('combined listing keeps storage items before repository items', async () => {
    writeInstallRecord(root, RECORD_FILE, {
      repo: { vscode: { version: '1.0.0', installedAt: '2026-10-28T10:00:00.000Z', files: ['.github/prompts/repo.prompt.md'] } }
    });
    const storage = (manager as any).storage as sinon.SinonStubbedInstance<RegistryStorage>;
    storage.getInstalledBundles.resolves([{
      bundleId: 'user-one', version: '1.0.0', installedAt: '', scope: 'user', installPath: '/x', manifest: {} as any
    }]);

    const items = await manager.listInstalledBundles();

    assert.deepStrictEqual(items.map((item) => item.bundleId), ['user-one', 'repo']);
  });
});
