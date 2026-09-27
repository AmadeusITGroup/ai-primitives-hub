import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  VsCodeSessionTokenProvider,
} from '../../src/adapters/vscode-session-token-provider';
import {
  GitHubAuthCommand,
} from '../../src/commands/github-auth-command';
import type {
  RegistryManager,
} from '../../src/services/registry-manager';

suite('GitHubAuthCommand', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => {
    sandbox = sinon.createSandbox();
    VsCodeSessionTokenProvider.clearCache();
    sandbox.stub(vscode.window, 'withProgress').callsFake(async (_options, task) => task({ report: () => {} }, {} as vscode.CancellationToken));
  });
  teardown(() => {
    VsCodeSessionTokenProvider.clearCache();
    sandbox.restore();
  });

  test('requests a fresh GitHub session even when adapters have no auth hook', async () => {
    const session = sandbox.stub(vscode.authentication, 'getSession').resolves({ accessToken: 'fresh' } as vscode.AuthenticationSession);
    const success = sandbox.stub(vscode.window, 'showInformationMessage');
    const registry = { forceAuthentication: async () => {} } as unknown as RegistryManager;
    await new GitHubAuthCommand(registry).execute();
    assert.ok(session.calledWith('github', ['repo'], { forceNewSession: true }));
    assert.ok(success.calledOnce);
  });

  test('reports sign-in failure without displaying a success notification', async () => {
    sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('Sign-in cancelled'));
    const success = sandbox.stub(vscode.window, 'showInformationMessage');
    const failure = sandbox.stub(vscode.window, 'showErrorMessage');
    const registry = { forceAuthentication: async () => {} } as unknown as RegistryManager;
    await new GitHubAuthCommand(registry).execute();
    assert.ok(success.notCalled);
    assert.ok(failure.calledWithMatch('Sign-in cancelled'));
  });
});
