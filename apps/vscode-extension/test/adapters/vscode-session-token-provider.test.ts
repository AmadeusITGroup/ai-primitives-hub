/**
 * VsCodeSessionTokenProvider Tests
 */

import * as assert from 'node:assert';
import type {
  AuthEvent,
  AuthEventHandler,
} from '@ai-primitives-hub/infra';
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
});

suite('VsCodeSessionTokenProvider auth events', () => {
  let sandbox: sinon.SinonSandbox;
  let getSessionStub: sinon.SinonStub;
  let events: AuthEvent[];
  let handler: AuthEventHandler;

  const session = {
    accessToken: 'gho_SuperSecretMaterial',
    account: { id: 'test', label: 'octocat' },
    id: 'session-id',
    scopes: ['repo', 'read:user']
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    VsCodeSessionTokenProvider.clearCache();
    getSessionStub = sandbox.stub(vscode.authentication, 'getSession');
    events = [];
    handler = (event) => events.push(event);
  });

  teardown(() => {
    VsCodeSessionTokenProvider.clearCache();
    sandbox.restore();
  });

  test('declares the ide-session origin', () => {
    assert.strictEqual(new VsCodeSessionTokenProvider(true, handler).origin, 'ide-session');
  });

  test('reports the resolved token type and the session scopes', async () => {
    getSessionStub.resolves(session);

    await new VsCodeSessionTokenProvider(true, handler).getToken('api.github.com');

    assert.deepStrictEqual(events.map((event) => event.kind), ['attempt', 'resolved']);
    const resolved = events[1];
    assert.strictEqual(resolved.kind, 'resolved');
    assert.strictEqual(resolved.origin, 'ide-session');
    assert.strictEqual(resolved.tokenType, 'gho_');
    assert.deepStrictEqual(resolved.scopes, ['repo', 'read:user']);
  });

  test('reports a cache hit rather than staying silent', async () => {
    getSessionStub.resolves(session);
    const provider = new VsCodeSessionTokenProvider(true, handler);

    await provider.getToken('github.com');
    events.length = 0;
    await provider.getToken('github.com');

    assert.strictEqual(getSessionStub.callCount, 1, 'second call should be served from cache');
    assert.deepStrictEqual(events.map((event) => event.kind), ['attempt', 'resolved']);
    assert.ok(events.every((event) => 'cached' in event && event.cached === true));
  });

  test('preserves the session scopes across a cache hit', async () => {
    getSessionStub.resolves(session);
    const provider = new VsCodeSessionTokenProvider(true, handler);

    await provider.getToken('github.com');
    events.length = 0;
    await provider.getToken('github.com');

    const resolved = events[1];
    assert.strictEqual(resolved.kind, 'resolved');
    assert.deepStrictEqual(resolved.scopes, ['repo', 'read:user']);
  });

  test('reports no-session when the user is not signed in', async () => {
    getSessionStub.resolves(undefined);

    await new VsCodeSessionTokenProvider(true, handler).getToken('github.com');

    assert.deepStrictEqual(events.map((event) => event.kind), ['attempt', 'skipped']);
    const skipped = events[1];
    assert.strictEqual(skipped.kind, 'skipped');
    assert.strictEqual(skipped.reason, 'no-session');
  });

  test('reports a failure with its message when VS Code auth rejects', async () => {
    getSessionStub.rejects(new Error('auth failed'));

    await new VsCodeSessionTokenProvider(true, handler).getToken('github.com');

    const failed = events.at(-1);
    assert.strictEqual(failed?.kind, 'failed');
    assert.strictEqual(failed.message, 'auth failed');
  });

  test('reports non-github-host without reporting an attempt', async () => {
    await new VsCodeSessionTokenProvider(true, handler).getToken('example.com');

    assert.deepStrictEqual(events.map((event) => event.kind), ['skipped']);
    const skipped = events[0];
    assert.strictEqual(skipped.kind, 'skipped');
    assert.strictEqual(skipped.reason, 'non-github-host');
  });

  test('records the createIfNone policy, which differs for skills sources', async () => {
    getSessionStub.resolves(undefined);

    await new VsCodeSessionTokenProvider(false, handler).getToken('github.com');

    const attempt = events[0];
    assert.strictEqual(attempt.kind, 'attempt');
    assert.ok(attempt.detail?.includes('createIfNone=false'));
  });

  test('reports a joined in-flight request as cached', async () => {
    let release!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    getSessionStub.callsFake(async () => {
      await sessionReady;
      return session;
    });

    const provider = new VsCodeSessionTokenProvider(true, handler);
    const requests = [provider.getToken('github.com'), provider.getToken('github.com')];
    await Promise.resolve();
    release();
    await Promise.all(requests);

    const joined = events.filter((event) => event.kind === 'attempt' && event.cached === true);
    assert.strictEqual(joined.length, 1);
  });

  test('reports the token type for a request that joined an in-flight one', async () => {
    // Hub resolution consults api.github.com and raw.githubusercontent.com in
    // quick succession, so the second call joins the first. It must still
    // report an outcome, or its host logs an attempt and nothing else.
    let release!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    getSessionStub.callsFake(async () => {
      await sessionReady;
      return session;
    });

    const provider = new VsCodeSessionTokenProvider(true, handler);
    const first = provider.getToken('api.github.com');
    const joiner = provider.getToken('raw.githubusercontent.com');
    await Promise.resolve();
    release();
    await Promise.all([first, joiner]);

    const joinedHostEvents = events.filter((event) => event.host === 'raw.githubusercontent.com');
    assert.deepStrictEqual(joinedHostEvents.map((event) => event.kind), ['attempt', 'resolved']);
    const resolved = joinedHostEvents[1];
    assert.strictEqual(resolved.kind, 'resolved');
    assert.strictEqual(resolved.tokenType, 'gho_');
    assert.deepStrictEqual(resolved.scopes, ['repo', 'read:user']);
  });

  test('reports no-session for a joiner when the in-flight request finds nothing', async () => {
    let release!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    getSessionStub.callsFake(async () => {
      await sessionReady;
      return undefined;
    });

    const provider = new VsCodeSessionTokenProvider(true, handler);
    const first = provider.getToken('api.github.com');
    const joiner = provider.getToken('raw.githubusercontent.com');
    await Promise.resolve();
    release();
    await Promise.all([first, joiner]);

    const joinedHostEvents = events.filter((event) => event.host === 'raw.githubusercontent.com');
    assert.deepStrictEqual(joinedHostEvents.map((event) => event.kind), ['attempt', 'skipped']);
    const skipped = joinedHostEvents[1];
    assert.strictEqual(skipped.kind, 'skipped');
    assert.strictEqual(skipped.reason, 'no-session');
  });

  test('always follows an attempt with exactly one terminal event', async () => {
    getSessionStub.resolves(session);
    const provider = new VsCodeSessionTokenProvider(true, handler);

    await provider.getToken('github.com');
    await provider.getToken('api.github.com');

    const attempts = events.filter((event) => event.kind === 'attempt').length;
    const terminals = events.filter(
      (event) => event.kind === 'resolved' || event.kind === 'skipped' || event.kind === 'failed'
    ).length;
    assert.strictEqual(attempts, terminals);
  });

  test('never places token material in an event', async () => {
    getSessionStub.resolves(session);

    await new VsCodeSessionTokenProvider(true, handler).getToken('github.com');

    assert.ok(!JSON.stringify(events).includes('SuperSecretMaterial'));
  });

  test('never places the account label in an event', async () => {
    getSessionStub.resolves(session);

    await new VsCodeSessionTokenProvider(true, handler).getToken('github.com');

    assert.ok(!JSON.stringify(events).includes('octocat'));
  });
});
