/**
 * BundleCommands.cleanupStaleLockfileEntries: old lockfiles are migrated
 * first, then stale record entries are removed, never a file, in a real temp
 * git root; `RegistryStorage`, the workspace lookup and notifications are stubbed.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleCommands,
} from '../../src/commands/bundle-commands';
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
  readRecordView,
  RECORD_FILE,
  recordEntry,
  writeInstallRecord,
  writeOldEntry,
} from '../helpers/install-record-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';

const OLD_LOCKFILE = 'prompt-registry.lock.json';

suite('BundleCommands.cleanupStaleLockfileEntries', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let manager: RegistryManager;
  let commands: BundleCommands;
  let showWarning: sinon.SinonStub;
  let showInfo: sinon.SinonStub;

  const exists = (relative: string): boolean => fs.existsSync(path.join(root, relative));
  const readJson = (file: string): any => readRecordView(path.join(root, file));

  // Record a bundle for a tool, then delete the files named in `remove`.
  const recordBundle = async (bundleId: string, tool: string, files: string[], remove: string[] = files): Promise<void> => {
    await recordEntry(manager.getRecordAdapter(), root, { bundleId, tool, files });
    remove.forEach((relative) => fs.rmSync(path.join(root, relative)));
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.realpathSync.native(createTestWorkspace());
    initGitRoot(root);
    RegistryManager.resetInstance();
    manager = RegistryManager.getInstance(createMockContext(sandbox));
    const storage = sandbox.createStubInstance(RegistryStorage);
    storage.getSources.resolves([]);
    storage.getInstalledBundles.resolves([]);
    (manager as any).storage = storage;
    sandbox.stub(require('../../src/utils/scope-selection-ui'), 'getWorkspaceRoot').returns(root);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Remove' as any);
    showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    commands = new BundleCommands(manager);
  });

  teardown(() => {
    sandbox.restore();
    RegistryManager.resetInstance();
    cleanupTestWorkspace(root);
  });

  test('migrates the old lockfile first, then removes entries with all files missing for any tool; never offers an unknown or file-less entry', async () => {
    await recordBundle('stale-vscode', 'vscode', ['.github/prompts/stale-vscode.prompt.md']);
    await recordBundle('stale-kiro', 'kiro', ['.kiro/steering/stale-kiro.md']);
    await recordBundle('partial', 'vscode', ['.github/prompts/partial-a.prompt.md', '.github/prompts/partial-b.prompt.md'], ['.github/prompts/partial-a.prompt.md']);
    await recordBundle('no-files', 'vscode', []);
    await writeOldEntry(root, 'old-stale', { missing: ['.github/prompts/old-stale.prompt.md'] });

    await commands.cleanupStaleLockfileEntries();

    const offered = String(showWarning.firstCall.args[0]);
    for (const label of ['stale-vscode (vscode)', 'stale-kiro (kiro)']) {
      assert.ok(offered.includes(label), offered);
    }
    for (const bundleId of ['partial', 'no-files', 'old-stale']) {
      assert.ok(!offered.includes(bundleId), offered);
    }
    const bundles = readJson(RECORD_FILE).bundles;
    assert.deepStrictEqual(Object.keys(bundles).toSorted(), ['no-files', 'old-stale', 'partial']);
    assert.deepStrictEqual(Object.keys(bundles['old-stale'].tools), ['unknown'], 'the old entry was migrated, not removed');
    assert.ok(!exists(OLD_LOCKFILE), 'the old lockfile was migrated');
    assert.ok(exists('.github/prompts/partial-b.prompt.md'), 'no file is deleted');
    assert.ok(String(showInfo.lastCall.args[0]).includes('Successfully removed 2'));
  });

  test('lists an entry in both record files (an interrupted move) once and removes both copies', async () => {
    const spec = { 'moved-bundle': { vscode: { version: '1.0.0', installedAt: '2026-10-28T10:00:00.000Z', file: '.github/prompts/moved.prompt.md' } } };
    writeInstallRecord(root, RECORD_FILE, spec);
    writeInstallRecord(root, LOCAL_RECORD_FILE, spec);
    fs.rmSync(path.join(root, '.github/prompts/moved.prompt.md'));

    await commands.cleanupStaleLockfileEntries();

    const offered = String(showWarning.firstCall.args[0]);
    assert.strictEqual(offered.split('moved-bundle (vscode)').length - 1, 1, offered);
    assert.ok(!exists(RECORD_FILE) && !exists(LOCAL_RECORD_FILE), 'both copies are removed');
    assert.ok(String(showInfo.lastCall.args[0]).includes('Successfully removed 1'));
  });

  test('does not offer an entry in both record files when the other copy still has its files', async () => {
    const entry = (file: string) => ({ 'split-bundle': { vscode: { version: '1.0.0', installedAt: '2026-10-28T10:00:00.000Z', file } } });
    writeInstallRecord(root, RECORD_FILE, entry('.github/prompts/gone.prompt.md'));
    writeInstallRecord(root, LOCAL_RECORD_FILE, entry('.github/prompts/kept.prompt.md'));
    fs.rmSync(path.join(root, '.github/prompts/gone.prompt.md'));

    await commands.cleanupStaleLockfileEntries();

    assert.ok(showWarning.notCalled, String(showWarning.firstCall?.args[0]));
    assert.ok(exists(RECORD_FILE) && exists(LOCAL_RECORD_FILE), 'both copies are kept');
  });

  test('a malformed record file mid-batch stops the batch and reports removed and not-attempted rows', async () => {
    await recordBundle('first', 'vscode', ['.github/prompts/first.prompt.md']);
    await recordBundle('second', 'kiro', ['.kiro/steering/second.md']);
    const service = manager.getRecordAdapter().service;
    const recordUninstall = service.recordUninstall.bind(service);
    sandbox.stub(service, 'recordUninstall').callsFake(async (input) => {
      const result = await recordUninstall(input);
      fs.writeFileSync(path.join(root, LOCAL_RECORD_FILE), '{ not json');
      return result;
    });

    await commands.cleanupStaleLockfileEntries();

    const report = String(showWarning.lastCall.args[0]);
    assert.ok(report.startsWith('Stale cleanup stopped: RECORD.MALFORMED.'), report);
    assert.ok(report.includes('Removed: first (vscode).'), report);
    assert.ok(report.includes('Not attempted: second (kiro).'), report);
    assert.deepStrictEqual(Object.keys(readJson(RECORD_FILE).bundles), ['second']);
  });
});
