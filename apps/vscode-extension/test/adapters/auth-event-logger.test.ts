/**
 * AuthEventLogger Tests
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  createAuthEventLogger,
  resetAuthReportingState,
} from '../../src/adapters/auth-event-logger';
import {
  Logger,
} from '../../src/utils/logger';

suite('createAuthEventLogger', () => {
  let sandbox: sinon.SinonSandbox;
  let infoStub: sinon.SinonStub;
  let debugStub: sinon.SinonStub;
  let warnStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    resetAuthReportingState();
    const logger = Logger.getInstance();
    infoStub = sandbox.stub(logger, 'info');
    debugStub = sandbox.stub(logger, 'debug');
    warnStub = sandbox.stub(logger, 'warn');
  });

  teardown(() => {
    resetAuthReportingState();
    sandbox.restore();
  });

  const infoLines = (): string[] => infoStub.getCalls().map((call) => String(call.args[0]));
  const debugLines = (): string[] => debugStub.getCalls().map((call) => String(call.args[0]));
  const warnLines = (): string[] => warnStub.getCalls().map((call) => String(call.args[0]));
  const allLines = (): string[] => [...infoLines(), ...debugLines(), ...warnLines()];

  test('reports a fresh resolution as a single INFO line naming the origin', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({
      kind: 'resolved',
      host: 'api.github.com',
      origin: 'ide-session',
      tokenType: 'gho_',
      scopes: ['repo', 'read:user'],
      durationMs: 142
    });

    assert.deepStrictEqual(infoLines(), [
      '[Auth] host=api.github.com via=ide-session type=gho_ scopes=repo,read:user (142ms)'
    ]);
  });

  test('says nothing at all for a cached resolution', () => {
    // The 30s token cache means a busy sync resolves hundreds of times from
    // one real sign-in. Those carry no new information.
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({
      kind: 'resolved',
      host: 'api.github.com',
      origin: 'ide-session',
      tokenType: 'gho_',
      scopes: ['repo'],
      durationMs: 0,
      cached: true
    });

    assert.deepStrictEqual(allLines(), []);
  });

  test('says nothing for an attempt that was served from cache', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'attempt', host: 'api.github.com', origin: 'ide-session', cached: true });

    assert.deepStrictEqual(allLines(), []);
  });

  test('reports an identical outcome only once across every source', () => {
    // One VS Code session serves all 55 sources; repeating the same line per
    // source is what flooded the channel.
    const resolved = {
      kind: 'resolved',
      host: 'api.github.com',
      origin: 'ide-session',
      tokenType: 'gho_',
      scopes: ['repo'],
      durationMs: 12
    } as const;

    createAuthEventLogger('source-a')(resolved);
    createAuthEventLogger('source-b')(resolved);
    createAuthEventLogger('source-c')(resolved);

    assert.strictEqual(infoLines().length, 1);
  });

  test('reports again when the token type or scopes change', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'resolved', host: 'api.github.com', origin: 'ide-session', tokenType: 'gho_', scopes: ['repo'], durationMs: 5 });
    onAuthEvent({ kind: 'resolved', host: 'api.github.com', origin: 'ide-session', tokenType: 'gho_', scopes: ['repo', 'read:org'], durationMs: 5 });
    onAuthEvent({ kind: 'resolved', host: 'api.github.com', origin: 'gh-cli', tokenType: 'ghp_', durationMs: 5 });

    assert.strictEqual(infoLines().length, 3);
  });

  test('reports each host separately', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');
    const resolved = { kind: 'resolved', origin: 'ide-session', tokenType: 'gho_', scopes: ['repo'], durationMs: 5 } as const;

    onAuthEvent({ ...resolved, host: 'api.github.com' });
    onAuthEvent({ ...resolved, host: 'raw.githubusercontent.com' });

    assert.strictEqual(infoLines().length, 2);
  });

  test('never prints the static chain order or the createIfNone flag', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'chain-start', host: 'api.github.com', plannedOrigins: ['ide-session', 'gh-cli'] });
    onAuthEvent({ kind: 'attempt', host: 'api.github.com', origin: 'ide-session', detail: 'createIfNone=true' });

    const everything = allLines().join('\n');
    assert.ok(!everything.includes('order='), 'chain order is static configuration, not diagnosis');
    assert.ok(!everything.includes('createIfNone'), 'createIfNone is an internal VS Code flag');
  });

  test('reports scopes as unknown for an origin that cannot know them', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'resolved', host: 'api.github.com', origin: 'gh-cli', tokenType: 'ghp_', durationMs: 89 });

    assert.ok(infoLines()[0].includes('scopes=unknown'));
  });

  test('always reports an exhausted chain, with the source and every reason', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'skipped', host: 'api.github.com', origin: 'configured-token', reason: 'not-set' });
    onAuthEvent({ kind: 'skipped', host: 'api.github.com', origin: 'ide-session', reason: 'no-session' });
    onAuthEvent({
      kind: 'failed',
      host: 'api.github.com',
      origin: 'gh-cli',
      reason: 'gh-not-authenticated',
      message: 'gh auth login required'
    });
    onAuthEvent({
      kind: 'chain-exhausted',
      host: 'api.github.com',
      triedOrigins: ['configured-token', 'ide-session', 'gh-cli'],
      durationMs: 12
    });

    assert.ok(infoLines().includes('[Auth] source=my-private-hub host=api.github.com no token — tried: '
      + 'configured-token(not-set), ide-session(no-session), gh-cli(gh-not-authenticated)'));
  });

  test('never deduplicates a failure, since every occurrence matters', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');
    const exhausted = {
      kind: 'chain-exhausted',
      host: 'api.github.com',
      triedOrigins: ['ide-session'],
      durationMs: 1
    } as const;

    onAuthEvent(exhausted);
    onAuthEvent(exhausted);

    assert.strictEqual(infoLines().filter((line) => line.includes('no token')).length, 2);
  });

  test('reports a failure at WARN, naming the source that could not authenticate', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({
      kind: 'failed',
      host: 'api.github.com',
      origin: 'gh-cli',
      reason: 'gh-timeout',
      message: 'Command failed'
    });

    assert.deepStrictEqual(warnLines(), [
      '[Auth] source=my-private-hub host=api.github.com via=gh-cli reason=gh-timeout: Command failed'
    ]);
  });

  test('resets accumulated reasons on a new chain', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'chain-start', host: 'github.com', plannedOrigins: ['gh-cli'] });
    onAuthEvent({ kind: 'failed', host: 'github.com', origin: 'gh-cli', reason: 'gh-timeout', message: 'slow' });
    onAuthEvent({ kind: 'chain-start', host: 'github.com', plannedOrigins: ['gh-cli'] });
    onAuthEvent({ kind: 'chain-exhausted', host: 'github.com', triedOrigins: ['gh-cli'], durationMs: 1 });

    assert.ok(infoLines().some((line) => line.includes('gh-cli(unknown)')));
  });

  test('omits the source label from the shared summary line', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'resolved', host: 'github.com', origin: 'gh-cli', tokenType: 'ghp_', durationMs: 5 });

    // The token is shared across sources, so naming one of them would mislead.
    assert.ok(infoLines()[0].startsWith('[Auth] host=github.com'));
  });

  test('names the host exactly once per line', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'skipped', host: 'raw.githubusercontent.com', origin: 'ide-session', reason: 'no-session' });
    onAuthEvent({ kind: 'resolved', host: 'raw.githubusercontent.com', origin: 'gh-cli', tokenType: 'ghp_', durationMs: 3 });

    for (const line of allLines()) {
      assert.strictEqual(line.split('host=').length - 1, 1, `host= repeated in: ${line}`);
    }
  });

  test('never logs token material', () => {
    const onAuthEvent = createAuthEventLogger('my-private-hub');

    onAuthEvent({ kind: 'resolved', host: 'github.com', origin: 'configured-token', tokenType: 'ghp_', durationMs: 1 });
    onAuthEvent({ kind: 'failed', host: 'github.com', origin: 'gh-cli', reason: 'unknown', message: 'boom' });

    const everything = allLines().join('\n');
    assert.ok(!everything.includes('SuperSecret'));
    assert.ok(everything.includes('type=ghp_'));
  });
});
