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
  promptGitHubAccountSelection,
} from '../../src/utils/github-account-prompt';

suite('promptGitHubAccountSelection', () => {
  let sandbox: sinon.SinonSandbox;
  let getSessionStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    getSessionStub = sandbox.stub(vscode.authentication, 'getSession');
  });

  teardown(() => {
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

  test('propagates errors from getSession (user cancel or unexpected failure)', async () => {
    getSessionStub.rejects(new Error('User did not consent'));

    await assert.rejects(
      () => promptGitHubAccountSelection(),
      /User did not consent/
    );
  });
});
