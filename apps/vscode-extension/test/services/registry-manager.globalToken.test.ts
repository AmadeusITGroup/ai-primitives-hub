/**
 * RegistryManager - Global GitHub Token Rejection Behavior
 *
 * Covers the credential-diagnostics/anonymous-fallback feature's
 * extension-layer behavior (see PR 374 review, QA2): a configured
 * `promptregistry.githubToken` that GitHub rejects must not keep being
 * applied to sources, and the one-time validation probe must not repeat
 * on every source operation within a session.
 *
 * Tests only through public entry points (`addSource`, `validateSource`,
 * `initialize`) per apps/vscode-extension/test/AGENTS.md; the network
 * boundary (`api.github.com`) is mocked with `nock`, matching
 * `test/adapters/infra-adapter-factory.test.ts`.
 */
import * as assert from 'node:assert';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as InfraAdapterFactory from '../../src/adapters/infra-adapter-factory';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  RegistrySource,
} from '../../src/types/registry';

function makeContext(sandbox: sinon.SinonSandbox): vscode.ExtensionContext {
  return {
    globalState: {
      get: sandbox.stub(),
      update: sandbox.stub().resolves(),
      keys: sandbox.stub().returns([]),
      setKeysForSync: sandbox.stub()
    } as any,
    workspaceState: {
      get: sandbox.stub(),
      update: sandbox.stub().resolves(),
      keys: sandbox.stub().returns([]),
      setKeysForSync: sandbox.stub()
    } as any,
    subscriptions: [],
    extensionPath: '/mock/path',
    extensionUri: vscode.Uri.file('/mock/path'),
    storageUri: vscode.Uri.file('/mock/storage'),
    globalStorageUri: vscode.Uri.file('/mock/global'),
    asAbsolutePath: (p: string) => `/mock/path/${p}`
  } as any;
}

function makeGithubSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'gh-source',
    name: 'GH Source',
    type: 'github',
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

suite('RegistryManager - Global Token Rejection Behavior', () => {
  let sandbox: sinon.SinonSandbox;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let configStub: sinon.SinonStub;
  let warnMessageStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    (RegistryManager as any).resetInstance();

    // A configured global token that GitHub will reject (401 on /user).
    configStub = sandbox.stub(vscode.workspace, 'getConfiguration');
    configStub.withArgs('promptregistry').returns({
      get: sandbox.stub().withArgs('githubToken', '').returns('stale-token')
    } as any);

    warnMessageStub = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);

    manager = RegistryManager.getInstance(makeContext(sandbox));

    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([]);
    mockStorage.getProfiles.resolves([]);
    mockStorage.getInstalledBundles.resolves([]);
    mockStorage.addSource.resolves();
    (manager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
    nock.cleanAll();
  });

  test('does not apply a rejected global token to a newly added source', async () => {
    nock('https://api.github.com').get('/user').reply(401, { message: 'Bad credentials' });

    const mockAdapter = {
      validate: sandbox.stub().resolves({ valid: true, errors: [] }),
      fetchBundles: sandbox.stub().resolves([])
    };
    const factoryStub = sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

    const source = makeGithubSource();
    mockStorage.getSources.resolves([source]);

    await manager.addSource(source);

    assert.ok(factoryStub.called, 'Adapter factory should be called');
    const enrichedSource = factoryStub.firstCall.args[0];
    assert.strictEqual(enrichedSource.token, undefined, 'Rejected global token must not be applied to the source');

    // The user must be told why: a warning naming the rejected token.
    assert.ok(warnMessageStub.called, 'Should notify the user of the rejected token');
  });

  test('applies the global token to a newly added source when it is valid', async () => {
    nock('https://api.github.com').get('/user').reply(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo' });

    const mockAdapter = {
      validate: sandbox.stub().resolves({ valid: true, errors: [] }),
      fetchBundles: sandbox.stub().resolves([])
    };
    const factoryStub = sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

    const source = makeGithubSource();
    mockStorage.getSources.resolves([source]);

    await manager.addSource(source);

    const enrichedSource = factoryStub.firstCall.args[0];
    assert.strictEqual(enrichedSource.token, 'stale-token', 'A validated global token should still be applied');
    assert.ok(!warnMessageStub.called, 'Should not warn when the token is valid');
  });

  test('probes the global token only once across multiple operations (memoization)', async () => {
    const userScope = nock('https://api.github.com').get('/user').reply(401, { message: 'Bad credentials' });

    const mockAdapter = {
      validate: sandbox.stub().resolves({ valid: true, errors: [] }),
      fetchBundles: sandbox.stub().resolves([])
    };
    sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

    const source = makeGithubSource();
    mockStorage.getSources.resolves([source]);

    // addSource() and validateSource() both call ensureGlobalTokenChecked();
    // the second call must not re-probe api.github.com.
    await manager.addSource(source);
    await manager.validateSource(source);

    assert.strictEqual(userScope.pendingMocks().length, 0, 'The single /user mock should have been consumed exactly once');
    assert.strictEqual(warnMessageStub.callCount, 1, 'The rejection warning should only fire once per session');
  });

  test('leaves the source untouched when no global token is configured', async () => {
    configStub.withArgs('promptregistry').returns({
      get: sandbox.stub().withArgs('githubToken', '').returns('')
    } as any);

    const mockAdapter = {
      validate: sandbox.stub().resolves({ valid: true, errors: [] }),
      fetchBundles: sandbox.stub().resolves([])
    };
    const factoryStub = sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

    const source = makeGithubSource();
    mockStorage.getSources.resolves([source]);

    await manager.addSource(source);

    const enrichedSource = factoryStub.firstCall.args[0];
    assert.strictEqual(enrichedSource.token, undefined);
    assert.ok(!warnMessageStub.called);
  });
});
