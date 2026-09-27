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
    VsCodeSessionTokenProvider.clearCache();
    getSessionStub = sandbox.stub(vscode.authentication, 'getSession');
  });

  teardown(() => {
    VsCodeSessionTokenProvider.clearCache();
    sandbox.restore();
  });

  test('returns undefined without calling VS Code auth for a non-GitHub host', async () => {
    const provider = new VsCodeSessionTokenProvider();
    const token = await provider.getToken('example.com');

    assert.strictEqual(token, undefined);
    assert.ok(getSessionStub.notCalled);
  });

  test('returns the session access token for a GitHub host', async () => {
    getSessionStub.resolves({
      accessToken: 'gho_abc123',
      account: { id: 'test', label: 'test' },
      id: 'session-id',
      scopes: ['repo']
    });

    const provider = new VsCodeSessionTokenProvider();
    const token = await provider.getToken('github.com');

    assert.strictEqual(token, 'gho_abc123');
  });

  test('accepts any GitHub-owned host (api, raw content)', async () => {
    getSessionStub.resolves({
      accessToken: 'gho_abc123',
      account: { id: 'test', label: 'test' },
      id: 'session-id',
      scopes: ['repo']
    });

    const provider = new VsCodeSessionTokenProvider();

    assert.strictEqual(await provider.getToken('api.github.com'), 'gho_abc123');
    assert.strictEqual(await provider.getToken('raw.githubusercontent.com'), 'gho_abc123');
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

  test('deduplicates concurrent GitHub session requests across provider instances', async () => {
    let release!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    getSessionStub.callsFake(async () => {
      await sessionReady;
      return {
        accessToken: 'gho_shared',
        account: { id: 'test', label: 'test' },
        id: 'session-id',
        scopes: ['repo']
      };
    });

    const requests = Array.from({ length: 20 }, () => new VsCodeSessionTokenProvider().getToken('github.com'));
    await Promise.resolve();
    assert.strictEqual(getSessionStub.callCount, 1);
    release();

    const tokens = await Promise.all(requests);
    assert.ok(tokens.every((token) => token === 'gho_shared'));
  });

  test('releases a stalled authentication request so later attempts can recover', async () => {
    const clock = sandbox.useFakeTimers();
    getSessionStub.onFirstCall().returns(new Promise(() => {}));
    getSessionStub.onSecondCall().resolves({ accessToken: 'recovered' });
    const provider = new VsCodeSessionTokenProvider();
    const first = provider.getToken('github.com');
    await clock.tickAsync(60_001);
    assert.strictEqual(await first, undefined);
    assert.strictEqual(await provider.getToken('github.com'), 'recovered');
  });

  test('an old session completing after reset cannot overwrite the new cached token', async () => {
    let release!: (session: { accessToken: string }) => void;
    getSessionStub.onFirstCall().returns(new Promise((resolve) => {
      release = resolve;
    }));
    getSessionStub.onSecondCall().resolves({ accessToken: 'new' });
    const provider = new VsCodeSessionTokenProvider();
    const old = provider.getToken('github.com');
    VsCodeSessionTokenProvider.clearCache();
    assert.strictEqual(await provider.getToken('github.com'), 'new');
    release({ accessToken: 'old' });
    await old;
    assert.strictEqual(await provider.getToken('github.com'), 'new');
  });
});
