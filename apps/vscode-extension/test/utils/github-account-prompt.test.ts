/**
 * Unit tests for promptGitHubAccountSelection.
 *
 * Verifies that the utility forces VS Code's native GitHub account picker
 * (clearSessionPreference: true), returns normally on success, and throws
 * on user cancel so the caller can route to SetupState.INCOMPLETE.
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  VsCodeSessionTokenProvider,
} from '../../src/adapters/vscode-session-token-provider';
import {
  ensureGitHubAccountSelection,
  offerGitHubAccountSelection,
  promptGitHubAccountSelection,
} from '../../src/utils/github-account-prompt';

suite('promptGitHubAccountSelection', () => {
  let sandbox: sinon.SinonSandbox;
  let getSessionStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    VsCodeSessionTokenProvider.clearCache();
    getSessionStub = sandbox.stub(vscode.authentication, 'getSession');
  });

  teardown(() => {
    VsCodeSessionTokenProvider.clearCache();
    sandbox.restore();
  });

  test('calls getSession with clearSessionPreference and createIfNone', async () => {
    getSessionStub.resolves({
      accessToken: 'gho_test',
      account: { id: 'id-1', label: 'alice' },
      id: 'session-1',
      scopes: ['repo']
    } as any);

    await promptGitHubAccountSelection();

    const [providerId, scopes, options] = getSessionStub.firstCall.args;
    assert.strictEqual(providerId, 'github');
    assert.deepStrictEqual(scopes, ['repo']);
    assert.strictEqual(options.clearSessionPreference, true, 'must force picker');
    assert.strictEqual(options.createIfNone, true, 'must trigger sign-in if no accounts');
  });

  test('uses the newly selected account after replacing a cached GitHub session', async () => {
    const firstSession = {
      accessToken: 'gho_first',
      account: { id: 'id-1', label: 'first' },
      id: 'session-1',
      scopes: ['repo']
    };
    const selectedSession = {
      accessToken: 'gho_second',
      account: { id: 'id-2', label: 'second' },
      id: 'session-2',
      scopes: ['repo']
    };
    getSessionStub.onCall(0).resolves(firstSession as any);
    getSessionStub.onCall(1).resolves(selectedSession as any);
    getSessionStub.onCall(2).resolves(selectedSession as any);
    const provider = new VsCodeSessionTokenProvider(false);

    assert.strictEqual(await provider.getToken('github.com'), 'gho_first');
    await promptGitHubAccountSelection();
    assert.strictEqual(await provider.getToken('github.com'), 'gho_second');
  });

  test('propagates errors from getSession (user cancel or unexpected failure)', async () => {
    getSessionStub.rejects(new Error('User did not consent'));

    await assert.rejects(
      () => promptGitHubAccountSelection(),
      /cancelled or access was declined/
    );
  });

  test('bounds a first-run account picker that never settles', async () => {
    const clock = sandbox.useFakeTimers();
    let release!: (value: undefined) => void;
    getSessionStub.returns(new Promise((resolve) => {
      release = resolve;
    }));
    const result = assert.rejects(promptGitHubAccountSelection(), /5 minutes/);
    await clock.tickAsync(300_001);
    await result;
    release(undefined);
    await clock.tickAsync(0);
  });

  test('lets first-run users continue without GitHub for Artifactory or local hubs', async () => {
    getSessionStub.resolves(undefined);
    const showMessageStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves('Continue without GitHub' as any);

    assert.strictEqual(await offerGitHubAccountSelection(), false);
    assert.match(showMessageStub.firstCall.args[0], /GitHub hubs/);
    assert.match(showMessageStub.firstCall.args[0], /Artifactory or local hubs/);
    assert.deepStrictEqual(showMessageStub.firstCall.args.slice(1), ['Continue without GitHub', 'Sign in']);
    assert.strictEqual(getSessionStub.calledOnce, true);
  });

  test('skips the optional prompt when another GitHub auth provider is available', async () => {
    const showMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');

    assert.strictEqual(await offerGitHubAccountSelection(async () => true), true);
    assert.strictEqual(showMessageStub.called, false);
    assert.strictEqual(getSessionStub.called, false);
  });

  test('opens GitHub sign-in only after the user chooses Sign in', async () => {
    const session = {
      accessToken: 'gho_test',
      account: { id: 'id-1', label: 'alice' },
      id: 'session-1',
      scopes: ['repo']
    };
    getSessionStub.onCall(0).resolves(undefined);
    getSessionStub.onCall(1).resolves(session as any);
    const showMessageStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves('Sign in' as any);

    assert.strictEqual(await offerGitHubAccountSelection(), true);
    assert.ok(showMessageStub.calledOnce);
    assert.ok(getSessionStub.calledWith('github', ['repo'], { clearSessionPreference: true, createIfNone: true }));
  });

  test('keeps an optional first-run prompt dismissible when the native sign-in is cancelled', async () => {
    getSessionStub.onCall(0).resolves(undefined);
    getSessionStub.onCall(1).rejects(new Error('User did not consent'));
    sandbox.stub(vscode.window, 'showInformationMessage').resolves('Sign in' as any);

    assert.strictEqual(await offerGitHubAccountSelection(), false);
  });

  test('requires sign-in after a user chooses a GitHub hub', async () => {
    getSessionStub.resolves(undefined);
    const showMessageStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves('Cancel import' as any);

    await assert.rejects(() => ensureGitHubAccountSelection(), /GitHub sign-in is required/);
    assert.ok(showMessageStub.calledOnce);
    assert.deepStrictEqual(showMessageStub.firstCall.args.slice(1), ['Cancel import', 'Sign in']);
  });
});
