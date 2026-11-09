/**
 * RepositoryActivationService: offers the sources the install records and
 * old lockfiles name, in a real temp git root; `RegistryStorage`,
 * `HubManager` and notifications are stubbed.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  RecordSourceInput,
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
  IMPORT_HUB_ACTION,
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
  recordEntry,
  snapshotTree,
  writeOldEntry,
} from '../helpers/install-record-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';

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

  const recordBundle = (commitMode: 'commit' | 'local-only', bundleId: string, source: RecordSourceInput): Promise<void> =>
    recordEntry(adapter, root, { bundleId, tool: 'vscode', files: [`.github/prompts/${bundleId}.prompt.md`], commitMode, source });

  /** Old `prompt-registry.lock.json` naming `old-src` and hub `old-hub`. */
  const writeOldFile = (): Promise<void> => writeOldEntry(root, 'old-bundle', {
    source: { id: 'old-src', type: 'github', url: 'https://github.com/acme/old' },
    hubs: { 'old-hub': { name: 'Old Hub', url: 'https://example.com/hub.yml' } }
  });

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
    await recordBundle('commit', 'outside-skills-bundle', { sourceId: 'outside-skills', type: 'local-skills', url: '../outside' });
    await writeOldFile();
  });

  teardown(() => {
    sandbox.restore();
    RepositoryActivationService.resetInstance();
    cleanupTestWorkspace(workspace);
  });

  test('lists sources of both record files and the old lockfile, but no local or local-* source outside the root', async () => {
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

  test('lists the unconfigured sources and hubs with credentialRef by name, and changes no config or record', async () => {
    storage.getSources.resolves([{ id: 'inside-local', name: 'Inside', type: 'local', url: 'bundles/inside', enabled: true, priority: 1 }]);
    const before = snapshotTree(root);

    await createService().checkAndPromptActivation();

    assert.strictEqual(showInfo.callCount, 1);
    const message = String(showInfo.firstCall.args[0]);
    assert.ok(message.startsWith('4 sources and hubs from the install records are not configured: acme-github, local-only-src, old-src, old-hub.'), message);
    assert.ok(message.includes('acme-github-token'), message);
    assert.strictEqual(showInfo.firstCall.args.length, 1, 'no action that does nothing');
    for (const write of ['addSource', 'updateSource', 'removeSource', 'saveConfig'] as const) {
      assert.ok(storage[write].notCalled, write);
    }
    assert.ok(hubManager.importHub.notCalled);
    assert.deepStrictEqual(snapshotTree(root), before);
  });

  suite('a hub the record names', () => {
    const HUB_SOURCE: RecordSourceInput = { sourceId: 'hub-src', type: 'github', url: 'https://github.com/acme/hub-tools', hubId: 'acme-hub' };
    const recordHub = (hub: Record<string, string>): Promise<void> => recordEntry(adapter, root, {
      bundleId: 'hub-bundle', tool: 'vscode', files: ['.github/prompts/hub-bundle.prompt.md'], source: HUB_SOURCE, hub: { id: 'acme-hub', ...hub } as never
    });
    const importPrompts = (): sinon.SinonSpyCall[] => showInfo.getCalls().filter((call) => call.args.includes(IMPORT_HUB_ACTION));

    setup(() => {
      hubManager.importHub.resolves('acme-hub');
    });

    test('is listed from the record by name and imported from the shown reference after confirmation', async () => {
      await recordHub({ name: 'Acme Hub', type: 'github', location: 'acme/hub', ref: 'main' });
      showInfo.callsFake((_message: string, ...actions: string[]) => Promise.resolve(actions.includes(IMPORT_HUB_ACTION) ? IMPORT_HUB_ACTION : undefined));

      const recorded = await createService().readRepositorySources();
      const result = await createService().checkAndOfferMissingSources(recorded!);

      assert.deepStrictEqual({ ...recorded?.hubs?.['acme-hub'] as object }, { name: 'Acme Hub', type: 'github', location: 'acme/hub', ref: 'main' });
      const prompts = importPrompts();
      assert.strictEqual(prompts.length, 1);
      assert.ok(String(prompts[0].args[0]).includes('"Acme Hub" (acme-hub)'), String(prompts[0].args[0]));
      assert.ok(String(prompts[0].args[0]).includes('github acme/hub @ main'), String(prompts[0].args[0]));
      assert.ok(hubManager.importHub.calledOnceWithExactly({ type: 'github', location: 'acme/hub', ref: 'main' }, 'acme-hub'));
      assert.deepStrictEqual(result.importedHubs, ['acme-hub']);
      assert.ok(!String(showInfo.firstCall.args[0]).includes('hub-src'), 'a source of the offered hub is not listed again');
    });

    test('is not imported when the user does not confirm', async () => {
      await recordHub({ name: 'Acme Hub', type: 'github', location: 'acme/hub' });

      await createService().checkAndPromptActivation();

      assert.strictEqual(importPrompts().length, 1);
      assert.ok(hubManager.importHub.notCalled);
    });

    const notOffered: { name: string; hub: Record<string, string>; arrange?: () => void }[] = [
      { name: 'the workspace is not trusted', hub: { name: 'Acme Hub', type: 'github', location: 'acme/hub' }, arrange: () => sandbox.stub(vscode.workspace, 'isTrusted').value(false) },
      { name: 'its reference is plain HTTP', hub: { name: 'Web Hub', type: 'url', location: 'http://hubs.example/hub-config.yml' } }
    ];
    notOffered.forEach((testCase) => {
      test(`is not offered for import when ${testCase.name}`, async () => {
        await recordHub(testCase.hub);
        testCase.arrange?.();
        showInfo.resolves(IMPORT_HUB_ACTION);

        await createService().checkAndPromptActivation();

        assert.strictEqual(importPrompts().length, 0);
        assert.ok(hubManager.importHub.notCalled);
        assert.ok(String(showInfo.firstCall.args[0]).includes('acme-hub'), String(showInfo.firstCall.args[0]));
      });
    });
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
