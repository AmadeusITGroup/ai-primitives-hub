/** Install record listing through `RegistryManager.listInstalledBundles('repository')` on a real temp git root. */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
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
  type RecordSpec,
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
  });

  teardown(() => {
    sandbox.restore();
    (RegistryManager as any).instance = undefined;
    cleanupTestWorkspace(root);
  });

  test('the install record wins over the old lockfile for the same bundle id', async () => {
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

  const versionCases: { name: string; record: RecordSpec; old?: Record<string, string>; expected: { bundleId: string; version: string }[] }[] = [
    {
      name: 'an old lockfile holding 1.0.0 next to a record holding 2.0.0 of a versioned id lists the record\'s',
      record: { 'acme-tools-coll-2.0.0': { vscode: { version: '2.0.0', installedAt: '2026-10-28T10:00:00.000Z', file: '.github/prompts/coll.prompt.md' } } },
      old: { 'acme-tools-coll-1.0.0': '1.0.0' },
      expected: [{ bundleId: 'acme-tools-coll-2.0.0', version: '2.0.0' }]
    },
    {
      name: 'two versioned keys of one bundle for the same tool list the latest installed',
      record: {
        'acme-tools-coll-1.0.0': { vscode: { version: '1.0.0', installedAt: '2026-10-28T10:00:00.000Z', file: '.github/prompts/coll-1.prompt.md' } },
        'acme-tools-coll-2.0.0': { vscode: { version: '2.0.0', installedAt: '2026-10-27T10:00:00.000Z', file: '.github/prompts/coll-2.prompt.md' } }
      },
      expected: [{ bundleId: 'acme-tools-coll-1.0.0', version: '1.0.0' }]
    },
    {
      name: 'versioned keys of one bundle held by different tools both list',
      record: {
        'acme-tools-coll-1.0.0': { kiro: { version: '1.0.0', installedAt: '2026-10-27T10:00:00.000Z', file: '.kiro/steering/coll.md' } },
        'acme-tools-coll-2.0.0': { vscode: { version: '2.0.0', installedAt: '2026-10-28T10:00:00.000Z', file: '.github/prompts/coll.prompt.md' } }
      },
      expected: [{ bundleId: 'acme-tools-coll-1.0.0', version: '1.0.0' }, { bundleId: 'acme-tools-coll-2.0.0', version: '2.0.0' }]
    }
  ];

  versionCases.forEach(({ name, record, old, expected }) => {
    test(name, async () => {
      writeInstallRecord(root, RECORD_FILE, record);
      if (old !== undefined) {
        writeOldLockfile(root, 'prompt-registry.lock.json', old);
      }

      const items = await list();

      assert.deepStrictEqual(items.toSorted((a, b) => a.bundleId.localeCompare(b.bundleId)), expected);
    });
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
