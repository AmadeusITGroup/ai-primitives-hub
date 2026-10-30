/**
 * RegistryManager.remapBundleSource contract tests (BR11.9).
 *
 * The remap rewrites the source id in both install record files and in the
 * old `prompt-registry` lockfile of the open workspace, and the installation
 * records in storage. An unresolvable replacement rejects before anything is
 * written. Records are written through `InstallRecordService`, the old
 * lockfile through app's `writeLockfile`, in a real temp git root; only
 * `RegistryStorage`, `getWorkspaceRoot()` and the logger are stubbed.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  emptyLockfile,
  getLockfilePathForMode,
  type LockfileFs,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from '@ai-primitives-hub/app';
import * as sinon from 'sinon';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  InstalledBundle,
  RegistrySource,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';
import {
  createMockContext,
  initGitRoot,
  LOCAL_RECORD_FILE,
  RECORD_FILE,
  snapshotTree,
} from '../helpers/install-record-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';

const OLD_SOURCE_ID = 'old-source-id';
const NEW_SOURCE_ID = 'new-source-id';
const OLD_LOCKFILE = 'prompt-registry.lock.json';

const nodeLockfileFs: LockfileFs = {
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  writeFile: (file, contents) => fs.promises.writeFile(file, contents),
  exists: async (file) => fs.existsSync(file)
};

suite('RegistryManager.remapBundleSource', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let manager: RegistryManager;
  let storage: sinon.SinonStubbedInstance<RegistryStorage>;

  const makeSource = (overrides: Partial<RegistrySource> = {}): RegistrySource => ({
    id: NEW_SOURCE_ID,
    name: 'Renamed Collection',
    type: 'github',
    url: 'https://github.com/org/renamed',
    enabled: true,
    priority: 1,
    hubId: 'hub-a',
    config: { branch: 'main' },
    ...overrides
  });

  const userBundle = (bundleId: string, sourceId: string): InstalledBundle => ({
    bundleId,
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00Z',
    scope: 'user',
    installPath: `/mock/user/${bundleId}`,
    sourceId,
    sourceType: 'github',
    manifest: { id: bundleId, name: bundleId, version: '1.0.0' } as any
  });

  const readJson = (file: string): any => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

  /**
   * Record `bundleId` for vscode from the old source in one record file.
   * @param commitMode
   * @param bundleId
   */
  const recordFromOldSource = async (commitMode: 'commit' | 'local-only', bundleId: string): Promise<void> => {
    const relative = `.github/prompts/${bundleId}.prompt.md`;
    fs.mkdirSync(path.join(root, '.github', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(root, relative), `# ${bundleId}\n`);
    const adapter = manager.getRecordAdapter();
    const [committed, localOnly] = await adapter.locations(root);
    await adapter.service.recordInstall({
      location: commitMode === 'commit' ? committed : localOnly,
      bundleId,
      version: '1.0.0',
      tool: 'vscode',
      source: { sourceId: OLD_SOURCE_ID, type: 'github', url: 'https://github.com/org/old' },
      sourceType: 'github',
      writtenPaths: [path.join(root, relative)],
      syncSiblings: false
    });
  };

  setup(async () => {
    sandbox = sinon.createSandbox();
    root = fs.realpathSync.native(createTestWorkspace());
    initGitRoot(root);
    const logger = Logger.getInstance();
    for (const level of ['info', 'debug', 'warn'] as const) {
      sandbox.stub(logger, level);
    }

    RegistryManager.resetInstance();
    manager = RegistryManager.getInstance(createMockContext(sandbox));
    storage = sandbox.createStubInstance(RegistryStorage);
    storage.getSources.resolves([]);
    storage.getInstalledBundles.resolves([]);
    storage.recordInstallation.resolves();
    (manager as any).storage = storage;
    sandbox.stub(require('../../src/utils/scope-selection-ui'), 'getWorkspaceRoot').returns(root);

    await recordFromOldSource('commit', 'committed-bundle');
    await recordFromOldSource('local-only', 'local-bundle');
    let lock = upsertBundleEntry(emptyLockfile('prompt-registry@1.0.0'), 'old-bundle', {
      version: '1.0.0', sourceId: OLD_SOURCE_ID, sourceType: 'github', installedAt: '2026-10-28T10:00:00.000Z', files: []
    });
    lock = upsertSource(lock, OLD_SOURCE_ID, { type: 'github', url: 'https://github.com/org/old' });
    await writeLockfile(getLockfilePathForMode(root, 'commit'), lock, nodeLockfileFs);
  });

  teardown(() => {
    sandbox.restore();
    RegistryManager.resetInstance();
    cleanupTestWorkspace(root);
  });

  test('remaps both record files, the old lockfile and the stored installation records', async () => {
    storage.getSources.resolves([makeSource({ id: OLD_SOURCE_ID, url: 'https://github.com/org/old' }), makeSource()]);
    storage.getInstalledBundles.withArgs('user').resolves([userBundle('user-bundle', OLD_SOURCE_ID), userBundle('other', 'unrelated')]);

    await manager.remapBundleSource(OLD_SOURCE_ID, NEW_SOURCE_ID);

    for (const [file, bundleId] of [[RECORD_FILE, 'committed-bundle'], [LOCAL_RECORD_FILE, 'local-bundle']]) {
      const record = readJson(file);
      assert.deepStrictEqual(Object.keys(record.sources), [NEW_SOURCE_ID], file);
      assert.strictEqual(record.sources[NEW_SOURCE_ID].url, 'https://github.com/org/renamed', file);
      assert.strictEqual(record.bundles[bundleId].tools.vscode.sourceId, NEW_SOURCE_ID, file);
    }
    const old = readJson(OLD_LOCKFILE);
    assert.deepStrictEqual(Object.keys(old.sources), [NEW_SOURCE_ID]);
    assert.strictEqual(old.bundles['old-bundle'].sourceId, NEW_SOURCE_ID);
    assert.deepStrictEqual(storage.recordInstallation.getCalls().map((call) => [call.args[0].bundleId, call.args[0].sourceId]), [['user-bundle', NEW_SOURCE_ID]]);
  });

  test('rejects, naming the replacement, and writes nothing when the replacement source is absent', async () => {
    storage.getSources.resolves([makeSource({ id: OLD_SOURCE_ID, url: 'https://github.com/org/old' })]);
    storage.getInstalledBundles.withArgs('user').resolves([userBundle('user-bundle', OLD_SOURCE_ID)]);
    const before = snapshotTree(root);

    await assert.rejects(manager.remapBundleSource(OLD_SOURCE_ID, NEW_SOURCE_ID), (error: Error) => error.message.includes(NEW_SOURCE_ID));

    assert.deepStrictEqual(snapshotTree(root), before);
    assert.ok(storage.recordInstallation.notCalled);
  });
});
