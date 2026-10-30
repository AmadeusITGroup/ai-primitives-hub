/**
 * BundleCommands.cleanupStaleLockfileEntries contract tests (W13; BR12.2, BR12.5).
 *
 * Stale rows come from both install record files, for any tool, and from the
 * old `prompt-registry` lockfiles; a row is offered only when every file it
 * lists is missing. Confirming removes the entries only, never a file. A
 * `RECORD.*` error mid-batch stops the batch and one message names what was
 * removed and what was not attempted. Records are written through
 * `InstallRecordService` and the old lockfile through app's `writeLockfile`,
 * in a real temp git root; only `RegistryStorage`, `getWorkspaceRoot()` and
 * the VS Code notification API are stubbed.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  emptyLockfile,
  getLockfilePathForMode,
  type LockfileFs,
  upsertBundleEntry,
  writeLockfile,
} from '@ai-primitives-hub/app';
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
  RECORD_FILE,
} from '../helpers/install-record-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';

const OLD_LOCKFILE = 'prompt-registry.lock.json';

const nodeLockfileFs: LockfileFs = {
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  writeFile: (file, contents) => fs.promises.writeFile(file, contents),
  exists: async (file) => fs.existsSync(file)
};

suite('BundleCommands.cleanupStaleLockfileEntries', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let manager: RegistryManager;
  let commands: BundleCommands;
  let showWarning: sinon.SinonStub;
  let showInfo: sinon.SinonStub;

  const exists = (relative: string): boolean => fs.existsSync(path.join(root, relative));
  const readJson = (file: string): any => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

  /**
   * Record a bundle for a tool through the record service, then delete the listed files named in `remove`.
   * @param bundleId - Bundle id.
   * @param tool - Tool key.
   * @param files - Root-relative files the entry lists.
   * @param remove - Files to delete after recording.
   */
  const recordBundle = async (bundleId: string, tool: string, files: string[], remove: string[] = files): Promise<void> => {
    for (const relative of files) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), `# ${bundleId}\n`);
    }
    const adapter = manager.getRecordAdapter();
    const [committed] = await adapter.locations(root);
    await adapter.service.recordInstall({
      location: committed,
      bundleId,
      version: '1.0.0',
      tool,
      source: { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools' },
      sourceType: 'github',
      writtenPaths: files.map((relative) => path.join(root, relative)),
      syncSiblings: false
    });
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

  test('removes entries with all files missing for any tool and the old lockfile; keeps a partly missing entry and every file', async () => {
    await recordBundle('stale-vscode', 'vscode', ['.github/prompts/stale-vscode.prompt.md']);
    await recordBundle('stale-kiro', 'kiro', ['.kiro/steering/stale-kiro.md']);
    await recordBundle('partial', 'vscode', ['.github/prompts/partial-a.prompt.md', '.github/prompts/partial-b.prompt.md'], ['.github/prompts/partial-a.prompt.md']);
    const oldLock = upsertBundleEntry(emptyLockfile('prompt-registry@1.0.0'), 'old-stale', {
      version: '1.0.0', sourceId: 'acme-github', sourceType: 'github', installedAt: '2026-10-28T10:00:00.000Z',
      files: [{ path: '.github/prompts/old-stale.prompt.md', checksum: '0'.repeat(64) }]
    });
    await writeLockfile(getLockfilePathForMode(root, 'commit'), oldLock, nodeLockfileFs);

    await commands.cleanupStaleLockfileEntries();

    const offered = String(showWarning.firstCall.args[0]);
    for (const label of ['stale-vscode (vscode)', 'stale-kiro (kiro)', 'old-stale (old lockfile)']) {
      assert.ok(offered.includes(label), offered);
    }
    assert.ok(!offered.includes('partial'), offered);
    assert.deepStrictEqual(Object.keys(readJson(RECORD_FILE).bundles), ['partial']);
    assert.ok(!exists(OLD_LOCKFILE), 'the emptied old lockfile is removed');
    assert.ok(exists('.github/prompts/partial-b.prompt.md'), 'no file is deleted');
    assert.ok(String(showInfo.lastCall.args[0]).includes('Successfully removed 3'));
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
