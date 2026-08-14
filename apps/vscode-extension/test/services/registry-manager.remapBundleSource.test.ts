/**
 * RegistryManager.remapBundleSource Delegation Tests
 *
 * Feature: hub-source-orphan-remap (Cycle F)
 *
 * `remapBundleSource` is a thin delegator over the shared
 * `@ai-primitives-hub/app` use case: it wires the storage, lockfile, and
 * logging boundaries and holds no orchestration of its own. These tests
 * verify that contract through the delegator's observable behavior:
 *
 * - both source ids reach the remap, and the replacement's descriptor is
 *   resolved from stored sources before any store is written
 * - a start line and a completion line are recorded through
 *   `Logger.getInstance()`, each naming both ids
 * - a rejection raised by the use case reaches the caller, with nothing
 *   written — an unresolvable replacement must not half-migrate and then let
 *   the caller delete the orphan
 *
 * Only the storage and lockfile boundaries are mocked; the RegistryManager
 * under test is a real instance.
 *
 * Validates: Requirements 6.4, 7.2
 */

import * as assert from 'node:assert';
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
  InstalledBundle,
  RegistrySource,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';

suite('RegistryManager.remapBundleSource - delegates to the app use case', () => {
  const OLD_SOURCE_ID = 'old-source-id';
  const NEW_SOURCE_ID = 'new-source-id';
  const WORKSPACE_ROOT = '/mock/workspace';

  let sandbox: sinon.SinonSandbox;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let remapSourceIdStub: sinon.SinonStub;
  let loggedMessages: string[];

  const makeSource = (overrides: Partial<RegistrySource> = {}): RegistrySource => ({
    id: NEW_SOURCE_ID,
    name: 'Renamed Collection',
    type: 'github',
    url: 'https://github.com/org/renamed',
    enabled: true,
    priority: 1,
    hubId: 'hub-a',
    config: { branch: 'main', collectionsPath: 'collections' },
    ...overrides
  });

  const makeInstalledBundle = (
    bundleId: string,
    sourceId: string,
    scope: 'user' | 'workspace' = 'user'
  ): InstalledBundle => ({
    bundleId,
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00Z',
    scope,
    installPath: `/mock/${scope}/${bundleId}`,
    sourceId,
    sourceType: 'github',
    manifest: { id: bundleId, name: bundleId, version: '1.0.0' } as any
  });

  const createMockContext = (mockSandbox: sinon.SinonSandbox): vscode.ExtensionContext => ({
    globalState: {
      get: mockSandbox.stub(),
      update: mockSandbox.stub().resolves(),
      keys: mockSandbox.stub().returns([]),
      setKeysForSync: mockSandbox.stub()
    } as any,
    workspaceState: {
      get: mockSandbox.stub(),
      update: mockSandbox.stub().resolves(),
      keys: mockSandbox.stub().returns([]),
      setKeysForSync: mockSandbox.stub()
    } as any,
    subscriptions: [],
    extensionPath: '/mock/path',
    extensionUri: vscode.Uri.file('/mock/path'),
    storageUri: vscode.Uri.file('/mock/storage'),
    globalStorageUri: vscode.Uri.file('/mock/global'),
    asAbsolutePath: (p: string) => `/mock/path/${p}`
  } as any);

  setup(() => {
    sandbox = sinon.createSandbox();

    // Record every line the delegator writes through the shared logger,
    // whatever level it chooses.
    loggedMessages = [];
    const logger = Logger.getInstance();
    const capture = (message: string): void => {
      loggedMessages.push(message);
    };
    sandbox.stub(logger, 'info').callsFake(capture);
    sandbox.stub(logger, 'debug').callsFake(capture);
    sandbox.stub(logger, 'warn').callsFake(capture);

    RegistryManager.resetInstance();
    manager = RegistryManager.getInstance(createMockContext(sandbox));

    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([]);
    mockStorage.getInstalledBundles.resolves([]);
    mockStorage.recordInstallation.resolves();
    (manager as any).storage = mockStorage;

    // Lockfile boundary: a workspace is open, so the repository-scope port
    // is wired.
    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(WORKSPACE_ROOT);

    remapSourceIdStub = sandbox.stub().resolves();
    sandbox.stub(LockfileManager, 'getInstance').returns({
      remapSourceId: remapSourceIdStub
    } as any);
  });

  teardown(() => {
    sandbox.restore();
    RegistryManager.resetInstance();
  });

  test('forwards both source ids and the resolved replacement descriptor to every scope', async () => {
    const replacement = makeSource();
    mockStorage.getSources.resolves([
      makeSource({ id: OLD_SOURCE_ID, name: 'Pre-rename Collection', url: 'https://github.com/org/old' }),
      replacement
    ]);
    mockStorage.getInstalledBundles.withArgs('user').resolves([
      makeInstalledBundle('bundle-a', OLD_SOURCE_ID),
      makeInstalledBundle('bundle-untouched', 'unrelated-source')
    ]);
    mockStorage.getInstalledBundles.withArgs('workspace').resolves([
      makeInstalledBundle('bundle-b', OLD_SOURCE_ID, 'workspace')
    ]);

    await manager.remapBundleSource(OLD_SOURCE_ID, NEW_SOURCE_ID);

    assert.strictEqual(remapSourceIdStub.callCount, 1, 'repository scope should be remapped once');
    const [oldId, newId, descriptor] = remapSourceIdStub.firstCall.args;
    assert.strictEqual(oldId, OLD_SOURCE_ID, 'old source id should be forwarded');
    assert.strictEqual(newId, NEW_SOURCE_ID, 'new source id should be forwarded');
    assert.deepStrictEqual(
      descriptor,
      {
        type: replacement.type,
        url: replacement.url,
        branch: 'main',
        collectionsPath: 'collections'
      },
      'descriptor should be resolved from the replacement source'
    );

    const rewritten = mockStorage.recordInstallation.getCalls().map((call) => call.args[0]);
    assert.deepStrictEqual(
      rewritten.map((bundle) => bundle.bundleId).toSorted(),
      ['bundle-a', 'bundle-b'],
      'only records referencing the old source id should be rewritten'
    );
    assert.ok(
      rewritten.every((bundle) => bundle.sourceId === NEW_SOURCE_ID),
      'rewritten records should reference the new source id'
    );
  });

  test('records a start line and a completion line through Logger.getInstance()', async () => {
    mockStorage.getSources.resolves([
      makeSource({ id: OLD_SOURCE_ID, url: 'https://github.com/org/old' }),
      makeSource()
    ]);
    mockStorage.getInstalledBundles.withArgs('user').resolves([
      makeInstalledBundle('bundle-a', OLD_SOURCE_ID)
    ]);
    mockStorage.getInstalledBundles.withArgs('workspace').resolves([]);

    await manager.remapBundleSource(OLD_SOURCE_ID, NEW_SOURCE_ID);

    const namingBothIds = loggedMessages.filter(
      (message) => message.includes(OLD_SOURCE_ID) && message.includes(NEW_SOURCE_ID)
    );
    const completion = namingBothIds.filter((message) => /complete/i.test(message));
    const start = namingBothIds.filter((message) => !/complete/i.test(message));

    assert.strictEqual(
      start.length,
      1,
      `expected one start line naming both ids, got: ${JSON.stringify(loggedMessages)}`
    );
    assert.strictEqual(
      completion.length,
      1,
      `expected one completion line naming both ids, got: ${JSON.stringify(loggedMessages)}`
    );
  });

  test('propagates the use case rejection and writes nothing when the replacement source is absent', async () => {
    // The replacement id is not in storage: the shared use case rejects
    // before touching any store, so the caller can keep the orphan alive.
    mockStorage.getSources.resolves([
      makeSource({ id: OLD_SOURCE_ID, url: 'https://github.com/org/old' })
    ]);
    mockStorage.getInstalledBundles.withArgs('user').resolves([
      makeInstalledBundle('bundle-a', OLD_SOURCE_ID)
    ]);
    mockStorage.getInstalledBundles.withArgs('workspace').resolves([
      makeInstalledBundle('bundle-b', OLD_SOURCE_ID, 'workspace')
    ]);

    await assert.rejects(
      manager.remapBundleSource(OLD_SOURCE_ID, NEW_SOURCE_ID),
      (error: Error) => error.message.includes(NEW_SOURCE_ID),
      'an unresolvable replacement should reject, naming the missing source id'
    );

    assert.strictEqual(remapSourceIdStub.callCount, 0, 'the lockfile must not be rewritten');
    assert.strictEqual(
      mockStorage.recordInstallation.callCount,
      0,
      'no installation record must be rewritten'
    );
  });
});
