/**
 * VsCodeSessionTokenProvider Tests
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  VsCodeSessionTokenProvider,
} from '../../src/adapters/vscode-session-token-provider';

suite('VsCodeSessionTokenProvider', () => {
  let sandbox: sinon.SinonSandbox;
  let getSessionStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    getSessionStub = sandbox.stub(vscode.authentication, 'getSession');
  });

  teardown(() => {
    sandbox.restore();
  });

  test('returns undefined without calling VS Code auth for a non-GitHub host', async () => {
    const provider = new VsCodeSessionTokenProvider();
    const token = await provider.getToken('example.com');

    assert.strictEqual(token, undefined);
    assert.ok(getSessionStub.notCalled);
  });

  test('returns the session access token, labelled with the account it belongs to', async () => {
    getSessionStub.resolves({
      accessToken: 'gho_abc123',
      account: { id: 'test', label: 'octocat' },
      id: 'session-id',
      scopes: ['repo']
    });

    const provider = new VsCodeSessionTokenProvider();
    const credential = await provider.getToken('github.com');

    assert.deepStrictEqual(credential, {
      token: 'gho_abc123',
      origin: { kind: 'vscode-session', detail: 'octocat' }
    });
  });

  test('accepts any GitHub-owned host (api, raw content)', async () => {
    getSessionStub.resolves({
      accessToken: 'gho_abc123',
      account: { id: 'test', label: 'test' },
      id: 'session-id',
      scopes: ['repo']
    });

    const provider = new VsCodeSessionTokenProvider();

    assert.strictEqual((await provider.getToken('api.github.com'))?.token, 'gho_abc123');
    assert.strictEqual((await provider.getToken('raw.githubusercontent.com'))?.token, 'gho_abc123');
  });

  test('returns undefined when no session is available', async () => {
    getSessionStub.resolves(undefined);

    const provider = new VsCodeSessionTokenProvider();
    const token = await provider.getToken('github.com');

    assert.strictEqual(token, undefined);
  });

  test('returns undefined, rather than throwing, when VS Code auth rejects', async () => {
    getSessionStub.rejects(new Error('auth failed'));

    const provider = new VsCodeSessionTokenProvider();
    const token = await provider.getToken('github.com');

    assert.strictEqual(token, undefined);
  });

  test('defaults createIfNone to true', async () => {
    getSessionStub.resolves(undefined);

    const provider = new VsCodeSessionTokenProvider();
    await provider.getToken('github.com');

    assert.ok(getSessionStub.calledWith('github', ['repo'], { createIfNone: true }));
  });

  test('passes a caller-supplied createIfNone through to vscode.authentication.getSession', async () => {
    getSessionStub.resolves(undefined);

    const provider = new VsCodeSessionTokenProvider(false);
    await provider.getToken('github.com');

    assert.ok(getSessionStub.calledWith('github', ['repo'], { createIfNone: false }));
  });
});
