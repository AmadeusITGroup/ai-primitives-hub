/**
 * LocalModificationWarningService: modified files of the host tool's record
 * entry or the old lockfile entry, which is read but never migrated, in a
 * real temp git root; only the dialog and `openExternal` are stubbed.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getLockfilePathForMode,
} from '@ai-primitives-hub/app';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  ExtensionRecordAdapter,
} from '../../src/services/extension-record-adapter';
import {
  InstallRecordListing,
} from '../../src/services/install-record-listing';
import {
  LocalModificationWarningService,
} from '../../src/services/local-modification-warning-service';
import {
  initGitRoot,
  recordEntry,
  writeOldEntry,
} from '../helpers/install-record-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';

const BUNDLE_ID = 'warn-bundle';
const FILE = '.github/prompts/warn.prompt.md';

suite('LocalModificationWarningService', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let adapter: ExtensionRecordAdapter;
  let service: LocalModificationWarningService;
  let showWarning: sinon.SinonStub;
  let openExternal: sinon.SinonStub;

  const writeFile = (relative: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };

  /** Install `FILE` for the host tool through the record service. */
  const recordInstall = (): Promise<void> => recordEntry(adapter, root, { bundleId: BUNDLE_ID, files: [FILE], content: '# original\n' });

  /** Install `FILE` through an old `prompt-registry.lock.json` entry (bare-hex checksum). */
  const oldInstall = (): Promise<void> => writeOldEntry(root, BUNDLE_ID, { files: { [FILE]: '# original\n' } });

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.realpathSync.native(createTestWorkspace());
    initGitRoot(root);
    adapter = new ExtensionRecordAdapter({ sources: { listSources: async () => [] }, hostTool: 'vscode' });
    service = new LocalModificationWarningService(adapter, root);
    showWarning = sandbox.stub(vscode.window, 'showWarningMessage');
    if (!vscode.env.openExternal) {
      (vscode.env as any).openExternal = () => Promise.resolve(true);
    }
    openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
  });

  teardown(() => {
    sandbox.restore();
    cleanupTestWorkspace(root);
  });

  const cases: { name: string; install: () => Promise<void>; change: () => void; expected: { path: string; modificationType: string }[] }[] = [
    { name: 'record entry, unchanged', install: recordInstall, change: () => undefined, expected: [] },
    { name: 'record entry, edited', install: recordInstall, change: () => writeFile(FILE, '# edited\n'), expected: [{ path: FILE, modificationType: 'modified' }] },
    { name: 'record entry, missing', install: recordInstall, change: () => fs.rmSync(path.join(root, FILE)), expected: [{ path: FILE, modificationType: 'missing' }] },
    { name: 'old lockfile entry, unchanged', install: oldInstall, change: () => undefined, expected: [] },
    { name: 'old lockfile entry, edited', install: oldInstall, change: () => writeFile(FILE, '# edited\n'), expected: [{ path: FILE, modificationType: 'modified' }] }
  ];
  cases.forEach((testCase) => {
    test(`checkForModifications: ${testCase.name}`, async () => {
      await testCase.install();
      testCase.change();

      assert.deepStrictEqual(await service.checkForModifications(BUNDLE_ID), testCase.expected);
    });
  });

  test('the repository listing and checkForModifications read an old lockfile without migrating or changing it', async () => {
    await oldInstall();
    writeFile(FILE, '# edited\n');
    const oldFile = getLockfilePathForMode(root, 'commit');
    const before = fs.readFileSync(oldFile);

    const listed = await new InstallRecordListing({ showProblem: () => undefined }).listRepositoryBundles(root, () => adapter.listOldBundles(root));
    const modified = await service.checkForModifications(BUNDLE_ID);

    assert.deepStrictEqual(listed.map((bundle) => bundle.bundleId), [BUNDLE_ID]);
    assert.deepStrictEqual(modified, [{ path: FILE, modificationType: 'modified' }]);
    assert.deepStrictEqual(fs.readFileSync(oldFile), before);
    assert.ok(!fs.existsSync(path.join(root, 'ai-primitives-hub.lock.json')), 'no new record is written');
  });

  test('checkAndWarn returns null without a dialog when the bundle has no entry or no change', async () => {
    assert.strictEqual(await service.checkAndWarn('not-installed'), null);
    await recordInstall();
    assert.strictEqual(await service.checkAndWarn(BUNDLE_ID), null);
    assert.ok(showWarning.notCalled);
  });

  test('checkAndWarn lists the modified file and returns the choice; "Contribute Changes" opens the repository', async () => {
    await recordInstall();
    writeFile(FILE, '# edited\n');
    const repoUrl = 'https://github.com/acme/tools';

    showWarning.resolves('Override');
    assert.strictEqual(await service.checkAndWarn(BUNDLE_ID, repoUrl), 'override');
    assert.ok(String(showWarning.firstCall.args[0]).includes(FILE));
    assert.deepStrictEqual(showWarning.firstCall.args.slice(1), ['Contribute Changes', 'Override', 'Cancel']);

    showWarning.resolves('Contribute Changes');
    assert.strictEqual(await service.checkAndWarn(BUNDLE_ID, repoUrl), 'contribute');
    assert.strictEqual(String(openExternal.firstCall.args[0]), repoUrl);
  });
});
