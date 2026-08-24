import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createAuthChainRecorder,
  describeAuthEvent,
  formatScopes,
  formatTriedOrigins,
} from '../../src/auth/auth-chain-recorder';
import {
  CompositeTokenProvider,
} from '../../src/auth/composite-token-provider';
import {
  EnvTokenProvider,
} from '../../src/auth/env-token-provider';
import {
  GhCliTokenProvider,
} from '../../src/auth/gh-cli-token-provider';
import {
  StaticTokenProvider,
} from '../../src/auth/static-token-provider';

describe('createAuthChainRecorder', () => {
  it('reports no outcome before anything happens', () => {
    expect(createAuthChainRecorder().outcome()).toBeUndefined();
  });

  it('reports the winning origin and its token type', async () => {
    const recorder = createAuthChainRecorder();
    const provider = new CompositeTokenProvider([
      new StaticTokenProvider('', recorder.onAuthEvent),
      new GhCliTokenProvider(async () => ({ stdout: 'ghp_abc' }), recorder.onAuthEvent)
    ], recorder.onAuthEvent);

    await provider.getToken('github.com');

    expect(recorder.outcome()).toMatchObject({
      kind: 'resolved',
      origin: 'gh-cli',
      tokenType: 'ghp_',
      cached: false
    });
  });

  it('pairs every tried origin with the reason it declined, in chain order', async () => {
    const recorder = createAuthChainRecorder();
    const ghFailure = Object.assign(new Error('gh auth login required'), { code: 1 });
    const provider = new CompositeTokenProvider([
      new StaticTokenProvider('', recorder.onAuthEvent),
      new EnvTokenProvider({}, recorder.onAuthEvent),
      new GhCliTokenProvider(() => Promise.reject(ghFailure), recorder.onAuthEvent)
    ], recorder.onAuthEvent);

    await provider.getToken('github.com');

    expect(recorder.outcome()).toMatchObject({
      kind: 'exhausted',
      tried: [
        { origin: 'configured-token', reason: 'not-set' },
        { origin: 'env-var', reason: 'not-set' },
        { origin: 'gh-cli', reason: 'gh-not-authenticated' }
      ]
    });
  });

  it('falls back to unknown for an origin that never stated a reason', () => {
    const recorder = createAuthChainRecorder();

    recorder.onAuthEvent({
      kind: 'chain-exhausted',
      host: 'github.com',
      triedOrigins: ['ide-session'],
      durationMs: 5
    });

    expect(recorder.outcome()).toMatchObject({
      kind: 'exhausted',
      tried: [{ origin: 'ide-session', reason: 'unknown' }]
    });
  });

  it('retains every event in order for per-step rendering', async () => {
    const recorder = createAuthChainRecorder();
    const provider = new CompositeTokenProvider(
      [new StaticTokenProvider('ghp_abc', recorder.onAuthEvent)],
      recorder.onAuthEvent
    );

    await provider.getToken('github.com');

    expect(recorder.events().map((event) => event.kind)).toEqual(['chain-start', 'attempt', 'resolved']);
  });

  it('never retains token material', async () => {
    const recorder = createAuthChainRecorder();
    const provider = new CompositeTokenProvider(
      [new StaticTokenProvider('ghp_SuperSecretMaterial', recorder.onAuthEvent)],
      recorder.onAuthEvent
    );

    await provider.getToken('github.com');

    expect(JSON.stringify([recorder.events(), recorder.outcome()])).not.toContain('SuperSecretMaterial');
  });
});

describe('formatTriedOrigins', () => {
  it('renders each origin with its reason', () => {
    expect(formatTriedOrigins([
      { origin: 'configured-token', reason: 'not-set' },
      { origin: 'ide-session', reason: 'no-session' },
      { origin: 'gh-cli', reason: 'gh-not-authenticated' }
    ])).toBe('configured-token(not-set), ide-session(no-session), gh-cli(gh-not-authenticated)');
  });

  it('renders none for an empty chain', () => {
    expect(formatTriedOrigins([])).toBe('none');
  });
});

describe('formatScopes', () => {
  it('renders unknown when the origin cannot know its scopes', () => {
    expect(formatScopes(undefined)).toBe('unknown');
  });

  it('renders none for an explicitly empty scope list', () => {
    expect(formatScopes([])).toBe('none');
  });

  it('renders a comma-separated list', () => {
    expect(formatScopes(['repo', 'read:user'])).toBe('repo,read:user');
  });
});

describe('describeAuthEvent', () => {
  it('describes a chain start with its planned order', () => {
    expect(describeAuthEvent({
      kind: 'chain-start',
      host: 'api.github.com',
      plannedOrigins: ['configured-token', 'gh-cli']
    })).toBe('chain-start host=api.github.com order=configured-token -> gh-cli');
  });

  it('describes a resolution with type, scopes, and duration', () => {
    expect(describeAuthEvent({
      kind: 'resolved',
      host: 'api.github.com',
      origin: 'ide-session',
      tokenType: 'gho_',
      scopes: ['repo'],
      durationMs: 142
    })).toBe('resolved via=ide-session host=api.github.com type=gho_ scopes=repo (142ms)');
  });

  it('marks a cached resolution', () => {
    expect(describeAuthEvent({
      kind: 'resolved',
      host: 'github.com',
      origin: 'ide-session',
      tokenType: 'gho_',
      durationMs: 0,
      cached: true
    })).toContain('cached=true');
  });

  it('describes a skip with its reason', () => {
    expect(describeAuthEvent({
      kind: 'skipped',
      host: 'github.com',
      origin: 'configured-token',
      reason: 'not-set'
    })).toBe('skipped via=configured-token host=github.com reason=not-set');
  });

  it('describes a failure with its reason and message', () => {
    expect(describeAuthEvent({
      kind: 'failed',
      host: 'github.com',
      origin: 'gh-cli',
      reason: 'gh-timeout',
      message: 'Command failed'
    })).toBe('failed via=gh-cli host=github.com reason=gh-timeout: Command failed');
  });

  it('describes an exhausted chain', () => {
    expect(describeAuthEvent({
      kind: 'chain-exhausted',
      host: 'github.com',
      triedOrigins: ['configured-token', 'gh-cli'],
      durationMs: 89
    })).toBe('chain-exhausted host=github.com tried=configured-token -> gh-cli (89ms)');
  });

  it('names the env variable an attempt consulted', () => {
    expect(describeAuthEvent({
      kind: 'attempt',
      host: 'github.com',
      origin: 'env-var',
      detail: 'GH_TOKEN'
    })).toBe('attempt via=env-var host=github.com detail=GH_TOKEN');
  });
});

describe('createAuthChainRecorder without a composite chain', () => {
  // `defaultTokenProvider` returns a bare `EnvTokenProvider` when
  // `AI_PRIMITIVES_HUB_DISABLE_GH_CLI=1`, so no `chain-exhausted` arrives.
  it('infers an exhausted outcome from a lone provider that declined', async () => {
    const recorder = createAuthChainRecorder();
    const provider = new EnvTokenProvider({}, recorder.onAuthEvent);

    await provider.getToken('github.com');

    expect(recorder.outcome()).toEqual({
      kind: 'exhausted',
      tried: [{ origin: 'env-var', reason: 'not-set' }],
      durationMs: 0
    });
  });

  it('still prefers a real resolution over an inferred failure', async () => {
    const recorder = createAuthChainRecorder();
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'ghp_abc' }, recorder.onAuthEvent);

    await provider.getToken('github.com');

    expect(recorder.outcome()).toMatchObject({ kind: 'resolved', origin: 'env-var' });
  });

  it('reports nothing when no provider ever declined', () => {
    expect(createAuthChainRecorder().outcome()).toBeUndefined();
  });
});
