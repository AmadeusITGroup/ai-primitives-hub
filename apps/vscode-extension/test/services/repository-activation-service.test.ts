/**
 * RepositoryActivationService contract tests (W14; BR12.4, NFR4.14).
 *
 * On workspace open the service lists the sources both install record files
 * and the old `prompt-registry` lockfiles name, skips a `local` source whose
 * folder resolves outside the repository root, shows a source's
 * `credentialRef` by name, and offers to add the unconfigured ones without
 * changing the configuration. Records are written through
 * `InstallRecordService` and old lockfiles through app's `writeLockfile`, in
 * a real temp git root; only `RegistryStorage`, `HubManager` and the VS Code
 * notification API are stubbed.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  emptyLockfile,
  getLockfilePathForMode,
  type LockfileFs,
  type RecordSourceInput,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from '@ai-primitives-hub/app';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  ExtensionRecordAdapter,
} from '../../src/services/extension-record-adapter';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  RepositoryActivationService,
} from '../../src/services/repository-activation-service';
import {
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  initGitRoot,
  snapshotTree,
} from '../helpers/install-record-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';

const nodeLockfileFs: LockfileFs = {
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  writeFile: (file, contents) => fs.promises.writeFile(file, contents),
  exists: async (file) => fs.existsSync(file)
};

suite('RepositoryActivationService', () => {
  let sandbox: sinon.SinonSandbox;
  let workspace: string;
  let root: string;
  let outside: string;
  let adapter: ExtensionRecordAdapter;
  let storage: sinon.SinonStubbedInstance<RegistryStorage>;
  let hubManager: sinon.SinonStubbedInstance<HubManager>;
  let declined: string[];
  let showInfo: sinon.SinonStub;

  /**
   * Record one bundle for vscode from `source` through the record service.
   * @param commitMode - Which record file.
   * @param bundleId - Bundle id.
   * @param source - Source the entry names.
   */
  const recordBundle = async (commitMode: 'commit' | 'local-only', bundleId: string, source: RecordSourceInput): Promise<void> => {
    const relative = `.github/prompts/${bundleId}.prompt.md`;
    fs.mkdirSync(path.join(root, '.github', 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(root, relative), `# ${bundleId}\n`);
    const [committed, localOnly] = await adapter.locations(root);
    await adapter.service.recordInstall({
      location: commitMode === 'commit' ? committed : localOnly,
      bundleId,
      version: '1.0.0',
      tool: 'vscode',
      source,
      sourceType: source.type,
      writtenPaths: [path.join(root, relative)],
      syncSiblings: false
    });
  };

  /** Old `prompt-registry.lock.json` naming `old-src` and hub `old-hub`. */
  const writeOldFile = async (): Promise<void> => {
    let lock = upsertBundleEntry(emptyLockfile('prompt-registry@1.0.0'), 'old-bundle', {
      version: '1.0.0', sourceId: 'old-src', sourceType: 'github', installedAt: '2026-10-28T10:00:00.000Z', files: []
    });
    lock = upsertSource(lock, 'old-src', { type: 'github', url: 'https://github.com/acme/old' });
    lock.hubs = { 'old-hub': { name: 'Old Hub', url: 'https://example.com/hub.yml' } };
    await writeLockfile(getLockfilePathForMode(root, 'commit'), lock, nodeLockfileFs);
  };

  const createService = (setupStateManager?: SetupStateManager): RepositoryActivationService =>
    new RepositoryActivationService(adapter, hubManager, storage, root, undefined, setupStateManager);

  setup(async () => {
    sandbox = sinon.createSandbox();
    workspace = fs.realpathSync.native(createTestWorkspace());
    root = path.join(workspace, 'repo');
    outside = path.join(workspace, 'outside');
    fs.mkdirSync(path.join(root, 'bundles', 'inside'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    initGitRoot(root);

    adapter = new ExtensionRecordAdapter({ sources: { listSources: async () => [] }, hostTool: 'vscode' });
    storage = sandbox.createStubInstance(RegistryStorage);
    storage.getSources.resolves([]);
    declined = [];
    storage.getContext.returns({ globalState: { get: (_key: string, fallback: unknown) => declined.length > 0 ? declined : fallback } } as any);
    hubManager = sandbox.createStubInstance(HubManager);
    hubManager.listHubs.resolves([]);
    showInfo = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    RepositoryActivationService.resetInstance();

    await recordBundle('commit', 'gh-bundle', { sourceId: 'acme-github', type: 'github', url: 'https://github.com/acme/tools', credentialRef: 'acme-github-token' });
    await recordBundle('local-only', 'private-bundle', { sourceId: 'local-only-src', type: 'github', url: 'https://github.com/acme/private' });
    await recordBundle('commit', 'inside-bundle', { sourceId: 'inside-local', type: 'local', url: 'bundles/inside' });
    await recordBundle('commit', 'outside-bundle', { sourceId: 'outside-local', type: 'local', url: '../outside' });
    await writeOldFile();
  });

  teardown(() => {
    sandbox.restore();
    RepositoryActivationService.resetInstance();
    cleanupTestWorkspace(workspace);
  });

  test('lists sources of both record files and the old lockfile, but not a local source outside the root', async () => {
    const recorded = await createService().readRepositorySources();

    assert.ok(recorded);
    assert.deepStrictEqual(Object.keys(recorded.sources).toSorted(), ['acme-github', 'inside-local', 'local-only-src', 'old-src']);
    assert.deepStrictEqual(Object.keys(recorded.hubs ?? {}), ['old-hub']);
  });

  test('does not list a local source inside the root that is a symlink pointing out', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    fs.symlinkSync(outside, path.join(root, 'bundles', 'link'), 'dir');
    await recordBundle('commit', 'link-bundle', { sourceId: 'link-local', type: 'local', url: 'bundles/link' });

    const recorded = await createService().readRepositorySources();

    assert.ok(recorded);
    assert.ok(!Object.hasOwn(recorded.sources, 'link-local'));
    assert.ok(Object.hasOwn(recorded.sources, 'inside-local'));
  });

  test('offers the unconfigured sources with credentialRef by name; "Add Sources" leaves the config and records unchanged', async () => {
    storage.getSources.resolves([{ id: 'inside-local', name: 'Inside', type: 'local', url: 'bundles/inside', enabled: true, priority: 1 }]);
    showInfo.resolves('Add Sources');
    const before = snapshotTree(root);

    await createService().checkAndPromptActivation();

    assert.strictEqual(showInfo.callCount, 1);
    const message = String(showInfo.firstCall.args[0]);
    assert.ok(message.startsWith('4 sources and hubs from the install records are not configured.'), message);
    assert.ok(message.includes('acme-github-token'), message);
    for (const write of ['addSource', 'updateSource', 'removeSource', 'saveConfig'] as const) {
      assert.ok(storage[write].notCalled, write);
    }
    assert.ok(hubManager.importHub.notCalled);
    assert.deepStrictEqual(snapshotTree(root), before);
  });

  const quietCases: { name: string; arrange: () => SetupStateManager | undefined }[] = [
    {
      name: 'the repository was declined',
      arrange: () => {
        declined = [root];
        return undefined;
      }
    },
    {
      name: 'first-run setup is not complete',
      arrange: () => ({ isComplete: async () => false }) as unknown as SetupStateManager
    }
  ];
  quietCases.forEach((quiet) => {
    test(`shows nothing when ${quiet.name}`, async () => {
      const setupStateManager = quiet.arrange();

      await createService(setupStateManager).checkAndPromptActivation();

      assert.ok(showInfo.notCalled);
    });
  });
});
