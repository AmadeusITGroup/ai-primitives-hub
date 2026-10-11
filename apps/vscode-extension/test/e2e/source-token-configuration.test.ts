import assert from 'node:assert';
import {
  NodeHttpClient,
} from '@ai-primitives-hub/infra';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  SourceCommands,
} from '../../src/commands/source-commands';
import {
  SourceTokenVault,
} from '../../src/services/source-token-vault';
import {
  RegistrySource,
} from '../../src/types/registry';
import {
  createE2ETestContext,
  E2ETestContext,
  generateTestId,
} from '../helpers/e2e-test-helpers';

suite('E2E: Source Token Configuration', () => {
  let sandbox: sinon.SinonSandbox;
  let testContext: E2ETestContext;
  let sourceCommands: SourceCommands;
  let secretValues: Map<string, string>;
  let source: RegistrySource;

  const storedToken = (): string | undefined => secretValues.get(SourceTokenVault.key(source.id));
  const persistedSource = async (): Promise<RegistrySource | undefined> =>
    (await testContext.registryManager.listSources()).find((item) => item.id === source.id);

  setup(async () => {
    sandbox = sinon.createSandbox();
    testContext = await createE2ETestContext();
    sourceCommands = new SourceCommands(testContext.registryManager);

    source = {
      id: generateTestId('token-source'),
      name: 'Token Source',
      type: 'local',
      url: testContext.tempStoragePath,
      enabled: true,
      priority: 1,
      private: true
    };
    secretValues = new Map([[SourceTokenVault.key(source.id), 'old-token']]);

    const secrets = testContext.mockContext.secrets;
    sandbox.stub(secrets, 'get').callsFake((key: string) => Promise.resolve(secretValues.get(key)));
    sandbox.stub(secrets, 'store').callsFake((key: string, value: string) => {
      secretValues.set(key, value);
      return Promise.resolve();
    });
    sandbox.stub(secrets, 'delete').callsFake((key: string) => {
      secretValues.delete(key);
      return Promise.resolve();
    });
    await testContext.storage.addSource(source);

    sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Configure Token', value: 'token' } as any);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
  });

  teardown(async () => {
    sandbox.restore();
    await testContext.cleanup();
  });

  test('removes the stored token and marks the source public when the prompt is left empty', async () => {
    sandbox.stub(vscode.window, 'showInputBox').resolves('');

    await sourceCommands.editSource(source.id);

    assert.strictEqual(storedToken(), undefined);
    assert.strictEqual((await persistedSource())?.private, false);
  });

  test('replaces the stored token with the entered value and marks the source private', async () => {
    sandbox.stub(vscode.window, 'showInputBox').resolves('  new-token  ');

    await sourceCommands.editSource(source.id);

    assert.strictEqual(storedToken(), 'new-token');
    assert.strictEqual((await persistedSource())?.private, true);
  });

  test('keeps the stored token when the prompt is cancelled', async () => {
    sandbox.stub(vscode.window, 'showInputBox').resolves(undefined);

    await sourceCommands.editSource(source.id);

    assert.strictEqual(storedToken(), 'old-token');
    assert.strictEqual((await persistedSource())?.private, true);
  });
});

suite('E2E: Artifactory Source Enrollment', () => {
  let sandbox: sinon.SinonSandbox;
  let context: E2ETestContext;
  let secrets: Map<string, string>;
  let requests: string[];
  let responseStatus: number;
  const root = 'https://artifactory.example/repo/source';
  const proposed = (): RegistrySource => ({ id: 'artifact', name: 'Artifact', type: 'artifactory', url: root,
    enabled: true, priority: 1, private: true, token: 'reader-token', config: { authMode: 'bearer' } });

  setup(async () => {
    sandbox = sinon.createSandbox();
    context = await createE2ETestContext();
    secrets = new Map();
    requests = [];
    responseStatus = 200;
    sandbox.stub(context.mockContext.secrets, 'get').callsFake((key: string) => Promise.resolve(secrets.get(key)));
    sandbox.stub(context.mockContext.secrets, 'store').callsFake((key: string, value: string) => {
      secrets.set(key, value);
      return Promise.resolve();
    });
    sandbox.stub(context.mockContext.secrets, 'delete').callsFake((key: string) => {
      secrets.delete(key);
      return Promise.resolve();
    });
    sandbox.stub(NodeHttpClient.prototype, 'fetch').callsFake((request) => {
      assert.strictEqual(request.url, `${root}/index-v1.json`);
      requests.push(request.headers?.Authorization ?? 'anonymous');
      return Promise.resolve({ statusCode: responseStatus, headers: {}, finalUrl: request.url,
        body: new TextEncoder().encode(JSON.stringify({ formatVersion: 1, source: { id: 'artifact', name: 'Artifact', updatedAt: '2026-01-01T00:00:00Z' }, bundles: [] })) });
    });
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'withProgress').callsFake(async (_options, task) => await task({ report: () => {} }, {} as any));
  });

  teardown(async () => {
    sandbox.restore();
    await context.cleanup();
  });

  const wizard = async (access: boolean | undefined, token: string | undefined, priority: string | undefined) => {
    const picker = sandbox.stub(vscode.window, 'showQuickPick');
    picker.onFirstCall().resolves({ label: 'Artifactory', value: 'artifactory' } as any);
    picker.onSecondCall().resolves(access === undefined ? undefined : { label: access ? 'Private' : 'Public', description: '', value: access } as any);
    const input = sandbox.stub(vscode.window, 'showInputBox');
    input.onCall(0).resolves('Artifact');
    input.onCall(1).resolves(root);
    input.onCall(2).resolves('index-v1.json');
    if (access) {
      input.onCall(3).resolves(token);
      input.onCall(4).resolves(priority);
    } else {
      input.onCall(3).resolves(priority);
    }
    await new SourceCommands(context.registryManager).addSource();
  };

  test('adds a protected source with a vault token but no serialized secret', async () => {
    await wizard(true, 'reader-token', '10');
    const sources = await context.storage.getSources();
    assert.strictEqual(sources.length, 1);
    assert.strictEqual(sources[0].private, true);
    assert.strictEqual(sources[0].config?.authMode, 'bearer');
    assert.strictEqual(secrets.get(SourceTokenVault.key(sources[0].id)), 'reader-token');
    assert.ok(requests.length > 0 && requests.every((value) => value === 'Bearer reader-token'));
    assert.ok(!JSON.stringify(await context.storage.loadConfig()).includes('reader-token'));
  });

  test('adds an anonymous source without credentials', async () => {
    await wizard(false, undefined, '10');
    const sources = await context.storage.getSources();
    assert.strictEqual(sources.length, 1);
    assert.strictEqual(sources[0].config?.authMode, 'anonymous');
    assert.strictEqual(secrets.size, 0);
    assert.ok(requests.length > 0 && requests.every((value) => value === 'anonymous'));
  });

  ([
    ['access cancellation', undefined, 'reader-token', '10'],
    ['token cancellation', true, undefined, '10'],
    ['priority cancellation', true, 'reader-token', undefined]
  ] as const).forEach(([name, access, token, priority]) => {
    test(`leaves no source or secret after ${name}`, async () => {
      await wizard(access, token, priority);
      assert.deepStrictEqual(await context.storage.getSources(), []);
      assert.strictEqual(secrets.size, 0);
      assert.deepStrictEqual(requests, []);
    });
  });

  test('does not retain credentials after authentication failure', async () => {
    responseStatus = 401;
    await wizard(true, 'reader-token', '10');
    assert.deepStrictEqual(await context.storage.getSources(), []);
    assert.strictEqual(secrets.size, 0);
  });

  test('Configure Token rotates a protected Artifactory credential without serializing it', async () => {
    await context.registryManager.addSource(proposed());
    sandbox.stub(vscode.window, 'showQuickPick').resolves({ label: 'Configure Token', value: 'token' } as any);
    sandbox.stub(vscode.window, 'showInputBox').resolves('new-reader-token');
    await new SourceCommands(context.registryManager).editSource('artifact');
    const source = (await context.storage.getSources())[0];
    const result = await context.registryManager.validateSource(source);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(requests.at(-1), 'Bearer new-reader-token');
    assert.strictEqual(secrets.get(SourceTokenVault.key(source.id)), 'new-reader-token');
    assert.ok(!JSON.stringify(await context.storage.loadConfig()).includes('new-reader-token'));
  });

  test('validation uses a supplied token without replacing an existing credential', async () => {
    const source = proposed();
    secrets.set(SourceTokenVault.key(source.id), 'old-token');
    const result = await context.registryManager.validateSource(source);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(requests, ['Bearer reader-token']);
    assert.strictEqual(secrets.get(SourceTokenVault.key(source.id)), 'old-token');
  });

  test('duplicate addition preserves the existing source and token', async () => {
    const source = proposed();
    await context.storage.addSource({ ...source, token: undefined });
    secrets.set(SourceTokenVault.key(source.id), 'old-token');
    await assert.rejects(context.registryManager.addSource(source), /already exists/);
    assert.strictEqual(secrets.get(SourceTokenVault.key(source.id)), 'old-token');
    assert.strictEqual((await context.storage.getSources()).length, 1);
  });

  test('declining source warnings saves neither the private token nor a source and shows no success', async () => {
    (NodeHttpClient.prototype.fetch as sinon.SinonStub).callsFake((request) => Promise.resolve({
      statusCode: 200, headers: {}, finalUrl: request.url,
      body: new TextEncoder().encode(JSON.stringify(request.url.endsWith('/releases') ? [] : { name: 'repo' }))
    }));
    const picker = sandbox.stub(vscode.window, 'showQuickPick');
    picker.onFirstCall().resolves({ label: 'GitHub', value: 'github' } as any);
    picker.onSecondCall().resolves({ label: 'Private', description: '', value: true } as any);
    const input = sandbox.stub(vscode.window, 'showInputBox');
    input.onCall(0).resolves('Private GitHub');
    input.onCall(1).resolves('https://github.com/owner/repo');
    input.onCall(2).resolves('reader-token');
    input.onCall(3).resolves('10');
    sandbox.stub(vscode.window, 'showWarningMessage').resolves('No' as any);
    await new SourceCommands(context.registryManager).addSource();
    assert.deepStrictEqual(await context.storage.getSources(), []);
    assert.strictEqual(secrets.size, 0);
    assert.ok(!(vscode.window.showInformationMessage as sinon.SinonStub).called);
  });

  test('removes a new secret when SecretStorage writes then rejects', async () => {
    (context.mockContext.secrets.store as sinon.SinonStub).callsFake((key: string, value: string) => {
      secrets.set(key, value);
      return Promise.reject(new Error('SecretStorage partial failure'));
    });
    await assert.rejects(context.registryManager.addSource(proposed()), /SecretStorage partial failure/);
    assert.deepStrictEqual(await context.storage.getSources(), []);
    assert.strictEqual(secrets.size, 0);
  });

  test('restores a preexisting credential after a partial failed write for a new source', async () => {
    const key = SourceTokenVault.key('artifact');
    secrets.set(key, 'preexisting-token');
    (context.mockContext.secrets.store as sinon.SinonStub).onFirstCall().callsFake((secretKey: string, value: string) => {
      secrets.set(secretKey, value);
      return Promise.reject(new Error('partial write'));
    });
    await assert.rejects(context.registryManager.addSource(proposed()), /partial write/);
    assert.deepStrictEqual(await context.storage.getSources(), []);
    assert.strictEqual(secrets.get(key), 'preexisting-token');
  });

  test('preserves the original storage error when secret rollback also fails', async () => {
    (context.mockContext.secrets.store as sinon.SinonStub).rejects(new Error('original SecretStorage failure'));
    (context.mockContext.secrets.delete as sinon.SinonStub).rejects(new Error('rollback failure'));
    await assert.rejects(context.registryManager.addSource(proposed()), /original SecretStorage failure/);
    assert.deepStrictEqual(await context.storage.getSources(), []);
  });

  test('rolls back the newly inserted source when SecretStorage fails', async () => {
    (context.mockContext.secrets.store as sinon.SinonStub).rejects(new Error('SecretStorage unavailable'));
    await assert.rejects(context.registryManager.addSource(proposed()), /SecretStorage unavailable/);
    assert.deepStrictEqual(await context.storage.getSources(), []);
    assert.strictEqual(secrets.size, 0);
  });
});
