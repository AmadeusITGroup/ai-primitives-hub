/**
 * Auth-failure reporting: the failure is always shown, and an
 * authentication problem always offers Diagnose + Reset GitHub Token.
 */

import * as assert from 'node:assert';
import {
  RegistryError,
} from '@ai-primitives-hub/core';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  isAuthFailure,
  showAuthFailure,
  showOperationFailure,
} from '../../src/utils/show-auth-failure';

const DIAGNOSE = 'Diagnose';
const RESET_TOKEN = 'Reset GitHub Token';

function authError(code = 'AUTH.TOKEN_REJECTED'): RegistryError {
  return new RegistryError({
    code,
    message: 'Failed to fetch hub config: HTTP 404',
    hint: 'GitHub rejected the credential itself (401 on /user)',
    context: { url: 'https://raw.githubusercontent.com/acme/hub/main/hub-config.yml' }
  });
}

suite('showAuthFailure', () => {
  let sandbox: sinon.SinonSandbox;
  let showErrorStub: sinon.SinonStub;
  let executeCommandStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    showErrorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('shows the caller\'s message, so the failure is never swallowed', async () => {
    await showAuthFailure('Failed to install bundle: HTTP 404', authError());

    const [message] = showErrorStub.firstCall.args as [string, ...string[]];
    assert.ok(message.startsWith('Failed to install bundle:'), message);
  });

  test('appends the credential verdict to the message', async () => {
    await showAuthFailure('Failed to install bundle: HTTP 404', authError());

    const [message] = showErrorStub.firstCall.args as [string, ...string[]];
    assert.ok(message.includes('GitHub rejected the credential itself'), message);
  });

  test('offers Diagnose and Reset GitHub Token', async () => {
    await showAuthFailure('Failed to install bundle: HTTP 404', authError());

    const actions = showErrorStub.firstCall.args.slice(1) as string[];
    assert.ok(actions.includes(DIAGNOSE), actions.join(', '));
    assert.ok(actions.includes(RESET_TOKEN), actions.join(', '));
  });

  test('runs the diagnose command against the URL the error recorded', async () => {
    showErrorStub.resolves(DIAGNOSE);

    await showAuthFailure('Failed to install bundle: HTTP 404', authError(), { label: 'acme.bundle' });

    assert.ok(executeCommandStub.calledWith('promptregistry.diagnoseGitHubAuth', {
      label: 'acme.bundle',
      url: 'https://raw.githubusercontent.com/acme/hub/main/hub-config.yml'
    }));
  });

  test('runs the force-auth command when the user resets the token', async () => {
    showErrorStub.resolves(RESET_TOKEN);

    await showAuthFailure('Failed to install bundle: HTTP 404', authError());

    assert.ok(executeCommandStub.calledWith('promptregistry.forceGitHubAuth'));
  });
});

suite('showOperationFailure', () => {
  let sandbox: sinon.SinonSandbox;
  let showErrorStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    showErrorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('offers the auth actions for an authentication failure', async () => {
    await showOperationFailure('Failed to install bundle: HTTP 404', authError('AUTH.NO_REPO_ACCESS'));

    const actions = showErrorStub.firstCall.args.slice(1) as string[];
    assert.ok(actions.includes(DIAGNOSE));
  });

  test('shows a plain error for a non-auth failure', async () => {
    await showOperationFailure('Failed to install bundle: disk full', new Error('disk full'));

    const [message, ...actions] = showErrorStub.firstCall.args as [string, ...string[]];
    assert.strictEqual(message, 'Failed to install bundle: disk full');
    assert.deepStrictEqual(actions, []);
  });

  test('classifies only AUTH.* codes as auth failures', () => {
    assert.strictEqual(isAuthFailure(authError('AUTH.MISSING_SCOPE')), true);
    assert.strictEqual(isAuthFailure(authError('HUB.FETCH_FAILED')), false);
    assert.strictEqual(isAuthFailure(new Error('boom')), false);
  });
});
