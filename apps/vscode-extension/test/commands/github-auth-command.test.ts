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
import {
  Logger,
} from '../../src/utils/logger';

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
    sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('network token=secret'));
    const success = sandbox.stub(vscode.window, 'showInformationMessage');
    const failure = sandbox.stub(vscode.window, 'showErrorMessage');
    const registry = { forceAuthentication: async () => {} } as unknown as RegistryManager;
    await new GitHubAuthCommand(registry).execute();
    assert.ok(success.notCalled);
    assert.ok(failure.calledWithMatch('VS Code could not obtain a GitHub session'));
    assert.ok(!JSON.stringify(failure.args).includes('secret'));
  });

  test('offers logs after failure and opens the output channel when selected', async () => {
    sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('connection failed'));
    sandbox.stub(vscode.window, 'showErrorMessage').resolves('Show Logs' as any);
    const show = sandbox.stub(Logger.getInstance(), 'show');
    await new GitHubAuthCommand({ forceAuthentication: async () => {} } as unknown as RegistryManager).execute();
    assert.ok(show.calledOnce);
  });

  test('reports proxy access denied as failure rather than user cancellation', async () => {
    sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('Proxy access denied'));
    const info = sandbox.stub(vscode.window, 'showInformationMessage');
    const error = sandbox.stub(vscode.window, 'showErrorMessage');
    await new GitHubAuthCommand({ forceAuthentication: async () => {} } as unknown as RegistryManager).execute();
    assert.ok(error.calledOnce);
    assert.ok(info.notCalled);
  });

  test('reloads only when the user selects the recovery action', async () => {
    sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('connection failed'));
    sandbox.stub(vscode.window, 'showErrorMessage').resolves('Reload Window' as any);
    const execute = sandbox.stub(vscode.commands, 'executeCommand').resolves();
    await new GitHubAuthCommand({ forceAuthentication: async () => {} } as unknown as RegistryManager).execute();
    assert.ok(execute.calledOnceWithExactly('workbench.action.reloadWindow'));
  });

  test('treats user cancellation as information rather than an authentication error', async () => {
    sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('User did not consent'));
    const info = sandbox.stub(vscode.window, 'showInformationMessage');
    const error = sandbox.stub(vscode.window, 'showErrorMessage');
    await new GitHubAuthCommand({ forceAuthentication: async () => {} } as unknown as RegistryManager).execute();
    assert.ok(info.calledWithMatch('cancelled'));
    assert.ok(error.notCalled);
  });
});
