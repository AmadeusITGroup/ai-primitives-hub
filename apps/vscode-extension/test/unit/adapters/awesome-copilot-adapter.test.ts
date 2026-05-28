import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  AwesomeCopilotAdapter,
} from '../../../src/adapters/awesome-copilot-adapter';
import {
  RegistrySource,
} from '../../../src/types/registry';

suite('AwesomeCopilotAdapter', () => {
  let sandbox: sinon.SinonSandbox;
  let adapter: AwesomeCopilotAdapter;
  let getSessionStub: sinon.SinonStub;

  const mockSource: RegistrySource = {
    id: 'test-source',
    name: 'Test Source',
    type: 'awesome-copilot',
    url: 'https://github.com/test/repo',
    enabled: true,
    priority: 0
  };

  setup(() => {
    sandbox = sinon.createSandbox();

    // Stub vscode.authentication.getSession
    // Note: mocha.setup.js defines vscode.authentication as an object,
    // so we can stub its methods directly.
    getSessionStub = sandbox.stub(vscode.authentication, 'getSession');

    adapter = new AwesomeCopilotAdapter(mockSource);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('forceAuthentication should clear cache and force new session', async () => {
    // Setup successful session return
    const mockSession = {
      id: 'id',
      accessToken: 'new-token',
      account: { id: 'acc', label: 'acc' },
      scopes: ['repo']
    };
    getSessionStub.resolves(mockSession);

    await adapter.forceAuthentication();

    // Verify call args
    assert.ok(getSessionStub.calledOnce, 'getSession should be called');
    assert.strictEqual(getSessionStub.firstCall.args[0], 'github');
    assert.deepStrictEqual(getSessionStub.firstCall.args[2], {
      forceNewSession: true
    });
  });

  test('forceAuthentication should throw if session creation fails', async () => {
    getSessionStub.rejects(new Error('Auth failed'));

    await assert.rejects(
      adapter.forceAuthentication(),
      /Auth failed/
    );
  });
});
