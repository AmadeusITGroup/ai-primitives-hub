import assert from 'node:assert';
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
