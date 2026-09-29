/**
 * VsCodeSessionTokenProvider Tests
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  VsCodeSessionTokenProvider,
} from '../../src/adapters/vscode-session-token-provider';
import {
  Logger,
} from '../../src/utils/logger';

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
    let release!: (session: undefined) => void;
    const stuck = new Promise((resolve) => {
      release = resolve;
    });
    // Model VS Code's TaskSingler: identical options share the native request.
    getSessionStub.callsFake((_provider, _scopes, options) => options.silent
      ? Promise.resolve({ accessToken: 'recovered' })
      : stuck);
    const provider = new VsCodeSessionTokenProvider();
    const first = provider.getToken('github.com');
    await clock.tickAsync(60_001);
    assert.strictEqual(await first, undefined);
    const retry = provider.getToken('github.com');
    await clock.tickAsync(60_001);
    try {
      assert.strictEqual(await retry, 'recovered');
    } finally {
      release(undefined);
      await clock.tickAsync(0);
    }
  });

  test('ordinary reads during forced sign-in share the fresh session', async () => {
    let release!: (session: { accessToken: string }) => void;
    const fresh = new Promise((resolve) => {
      release = resolve;
    });
    getSessionStub.callsFake((_provider, _scopes, options) => options.forceNewSession
      ? fresh
      : Promise.resolve({ accessToken: 'previous' }));
    const force = VsCodeSessionTokenProvider.forceAuthentication();
    const reads = [new VsCodeSessionTokenProvider(true).getToken('github.com'), new VsCodeSessionTokenProvider(false).getToken('github.com')];
    release({ accessToken: 'fresh' });
    await force;
    assert.deepStrictEqual(await Promise.all(reads), ['fresh', 'fresh']);
    assert.strictEqual(await new VsCodeSessionTokenProvider(false).getToken('github.com'), 'fresh');
  });

  test('a stalled silent recovery falls back immediately on later calls without warning spam', async () => {
    const clock = sandbox.useFakeTimers();
    const releases: ((value: undefined) => void)[] = [];
    getSessionStub.callsFake(() => new Promise((resolve) => {
      releases.push(resolve);
    }));
    const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
    const provider = new VsCodeSessionTokenProvider();
    for (let i = 0; i < 2; i++) {
      const attempt = provider.getToken('github.com');
      await clock.tickAsync(60_001);
      assert.strictEqual(await attempt, undefined);
    }
    assert.strictEqual(await provider.getToken('github.com'), undefined);
    assert.strictEqual(getSessionStub.callCount, 2);
    assert.ok(warning.calledOnce);
    releases.forEach((release) => release(undefined));
    await clock.tickAsync(0);
  });

  test('explicit recovery bypasses a shared pending forced request using account selection', async () => {
    const clock = sandbox.useFakeTimers();
    let release!: (value: undefined) => void;
    const stuck = new Promise((resolve) => {
      release = resolve;
    });
    getSessionStub.callsFake((_provider, _scopes, options) => options.clearSessionPreference
      ? Promise.resolve({ accessToken: 'recovered' })
      : stuck);
    const first = assert.rejects(VsCodeSessionTokenProvider.forceAuthentication(), /60 seconds/);
    await clock.tickAsync(60_001);
    await first;
    await VsCodeSessionTokenProvider.forceAuthentication();
    assert.strictEqual(await new VsCodeSessionTokenProvider().getToken('github.com'), 'recovered');
    release(undefined);
    await clock.tickAsync(0);
  });

  test('concurrent forced requests share one sign-in', async () => {
    getSessionStub.resolves({ accessToken: 'fresh' });
    await Promise.all([VsCodeSessionTokenProvider.forceAuthentication(), VsCodeSessionTokenProvider.forceAuthentication()]);
    assert.ok(getSessionStub.calledOnce);
  });

  (['select', 'force'] as const).forEach((firstMode) => {
    test(`does not substitute ${firstMode} for a different interactive operation`, async () => {
      let release!: (session: { accessToken: string }) => void;
      getSessionStub.returns(new Promise((resolve) => {
        release = resolve;
      }));
      const first = firstMode === 'select' ? VsCodeSessionTokenProvider.selectAccount() : VsCodeSessionTokenProvider.forceAuthentication();
      const second = firstMode === 'select' ? VsCodeSessionTokenProvider.forceAuthentication() : VsCodeSessionTokenProvider.selectAccount();
      // Observe rejection before releasing the active request, without leaving an unhandled rejection.
      const rejected = assert.rejects(second, /already in progress/);
      release({ accessToken: 'existing' });
      await first;
      await rejected;
      getSessionStub.resolves({ accessToken: 'fresh' });
      if (firstMode === 'select') {
        await VsCodeSessionTokenProvider.forceAuthentication();
        assert.ok(getSessionStub.lastCall.args[2].forceNewSession);
      } else {
        await VsCodeSessionTokenProvider.selectAccount();
        assert.ok(getSessionStub.lastCall.args[2].clearSessionPreference);
      }
    });
  });

  test('a blocked forced retry preserves a session recovered after earlier timeouts', async () => {
    const clock = sandbox.useFakeTimers();
    const releases: ((value: undefined) => void)[] = [];
    getSessionStub.callsFake((_provider, _scopes, options) => options.forceNewSession
      ? new Promise((resolve) => {
        releases.push(resolve);
      })
      : Promise.resolve({ accessToken: 'usable' }));
    try {
      for (let i = 0; i < 2; i++) {
        const result = assert.rejects(VsCodeSessionTokenProvider.forceAuthentication(), /60 seconds/);
        await clock.tickAsync(60_001);
        await result;
      }
      const provider = new VsCodeSessionTokenProvider();
      assert.strictEqual(await provider.getToken('github.com'), 'usable');
      getSessionStub.resolves(undefined);
      await assert.rejects(VsCodeSessionTokenProvider.forceAuthentication(), /still running/);
      assert.strictEqual(await provider.getToken('github.com'), 'usable');
    } finally {
      releases.forEach((release) => release(undefined));
      await clock.tickAsync(0);
    }
  });

  test('failed forced refresh cannot leave an ordinary old token in the cache', async () => {
    let reject!: (error: Error) => void;
    getSessionStub.callsFake((_provider, _scopes, options) => options.forceNewSession
      ? new Promise((_resolve, fail) => {
        reject = fail;
      })
      : Promise.resolve({ accessToken: 'old' }));
    const force = assert.rejects(VsCodeSessionTokenProvider.forceAuthentication(), /cancelled/);
    const read = new VsCodeSessionTokenProvider().getToken('github.com');
    await Promise.resolve();
    reject(new Error('cancelled'));
    await force;
    assert.strictEqual(await read, undefined);
    getSessionStub.resolves({ accessToken: 'new' });
    assert.strictEqual(await new VsCodeSessionTokenProvider().getToken('github.com'), 'new');
  });

  test('auth diagnostics do not include provider secrets', async () => {
    const warn = sandbox.stub(Logger.getInstance(), 'warn');
    getSessionStub.rejects(new Error('token=gho_secret callback=https://host/?code=secret'));
    await new VsCodeSessionTokenProvider().getToken('github.com');
    assert.ok(JSON.stringify(warn.args).includes('outcome=FAILED'));
    assert.ok(!JSON.stringify(warn.args).includes('secret'));
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
