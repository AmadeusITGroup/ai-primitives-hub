import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  AuthEvent,
} from '../../src/auth/auth-event';
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

function fakeProvider(fn: (host: string) => Promise<string | undefined>): TokenProvider {
  return { getToken: fn };
}

describe('CompositeTokenProvider', () => {
  it('returns the first provider that resolves a token', async () => {
    const calls: string[] = [];
    const provider = new CompositeTokenProvider([
      fakeProvider(async () => {
        calls.push('first');
        return undefined;
      }),
      fakeProvider(async () => {
        calls.push('second');
        return 'token-from-second';
      }),
      fakeProvider(async () => {
        calls.push('third');
        return 'token-from-third';
      })
    ]);

    await expect(provider.getToken('github.com')).resolves.toBe('token-from-second');
    expect(calls).toEqual(['first', 'second']);
  });

  it('stops at the first provider, never calling later ones', async () => {
    const calls: string[] = [];
    const provider = new CompositeTokenProvider([
      fakeProvider(async () => {
        calls.push('first');
        return 'token-from-first';
      }),
      fakeProvider(async () => {
        calls.push('second');
        return 'token-from-second';
      })
    ]);

    await expect(provider.getToken('github.com')).resolves.toBe('token-from-first');
    expect(calls).toEqual(['first']);
  });

  it('returns undefined when every provider returns undefined', async () => {
    const provider = new CompositeTokenProvider([
      fakeProvider(async () => undefined),
      fakeProvider(async () => undefined)
    ]);

    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('returns undefined for an empty provider list', async () => {
    const provider = new CompositeTokenProvider([]);
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('passes the same host through to every provider', async () => {
    const seenHosts: string[] = [];
    const provider = new CompositeTokenProvider([
      fakeProvider(async (host) => {
        seenHosts.push(host);
        return undefined;
      }),
      fakeProvider(async (host) => {
        seenHosts.push(host);
        return undefined;
      })
    ]);

    await provider.getToken('api.github.com');
    expect(seenHosts).toEqual(['api.github.com', 'api.github.com']);
  });
});

describe('CompositeTokenProvider auth events', () => {
  const capture = (): { events: AuthEvent[]; handler: (event: AuthEvent) => void } => {
    const events: AuthEvent[] = [];
    return { events, handler: (event) => events.push(event) };
  };

  it('announces the planned origins before consulting anything', async () => {
    const { events, handler } = capture();
    const provider = new CompositeTokenProvider([
      new StaticTokenProvider('', handler),
      new GhCliTokenProvider(async () => ({ stdout: 'gho_abc' }), handler)
    ], handler);

    await provider.getToken('github.com');

    expect(events[0]).toEqual({
      kind: 'chain-start',
      host: 'github.com',
      plannedOrigins: ['configured-token', 'gh-cli']
    });
  });

  it('lets the winning origin report the resolution and emits no chain-exhausted', async () => {
    const { events, handler } = capture();
    const provider = new CompositeTokenProvider([
      new StaticTokenProvider('', handler),
      new GhCliTokenProvider(async () => ({ stdout: 'ghp_abc' }), handler)
    ], handler);

    await expect(provider.getToken('github.com')).resolves.toBe('ghp_abc');

    expect(events.map((event) => event.kind)).toEqual([
      'chain-start',
      'attempt',
      'skipped',
      'attempt',
      'resolved'
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'resolved', origin: 'gh-cli', tokenType: 'ghp_' });
  });

  it('short-circuits, so later origins narrate nothing', async () => {
    const { events, handler } = capture();
    const provider = new CompositeTokenProvider([
      new StaticTokenProvider('ghp_first', handler),
      new GhCliTokenProvider(async () => ({ stdout: 'gho_second' }), handler)
    ], handler);

    await expect(provider.getToken('github.com')).resolves.toBe('ghp_first');

    const origins = events.map((event) => ('origin' in event ? event.origin : undefined));
    expect(origins).not.toContain('gh-cli');
  });

  it('reports chain-exhausted listing every origin tried, in order', async () => {
    const { events, handler } = capture();
    const ghFailure = Object.assign(new Error('gh auth login required'), { code: 1 });
    const provider = new CompositeTokenProvider([
      new StaticTokenProvider('', handler),
      new EnvTokenProvider({}, handler),
      new GhCliTokenProvider(() => Promise.reject(ghFailure), handler)
    ], handler);

    await expect(provider.getToken('github.com')).resolves.toBeUndefined();

    const exhausted = events.at(-1);
    expect(exhausted).toMatchObject({
      kind: 'chain-exhausted',
      host: 'github.com',
      triedOrigins: ['configured-token', 'env-var', 'gh-cli']
    });
  });

  it('lets a consumer pair each origin with the reason it declined', async () => {
    // This is what the delivery-layer formatter does to render
    // "tried: configured-token(not-set), env-var(not-set), gh-cli(gh-not-authenticated)".
    const { events, handler } = capture();
    const ghFailure = Object.assign(new Error('gh auth login required'), { code: 1 });
    const provider = new CompositeTokenProvider([
      new StaticTokenProvider('', handler),
      new EnvTokenProvider({}, handler),
      new GhCliTokenProvider(() => Promise.reject(ghFailure), handler)
    ], handler);

    await provider.getToken('github.com');

    const reasons = new Map(
      events
        .filter((event) => event.kind === 'skipped' || event.kind === 'failed')
        .map((event) => [event.origin, event.reason])
    );
    expect(Object.fromEntries(reasons)).toEqual({
      'configured-token': 'not-set',
      'env-var': 'not-set',
      'gh-cli': 'gh-not-authenticated'
    });
  });

  it('omits unlabelled providers from the planned origins', async () => {
    const { events, handler } = capture();
    const provider = new CompositeTokenProvider([
      fakeProvider(async () => undefined),
      new EnvTokenProvider({}, handler)
    ], handler);

    await provider.getToken('github.com');

    expect(events[0]).toMatchObject({ kind: 'chain-start', plannedOrigins: ['env-var'] });
  });

  it('stays silent when no handler is supplied', async () => {
    const provider = new CompositeTokenProvider([new StaticTokenProvider('ghp_abc')]);
    await expect(provider.getToken('github.com')).resolves.toBe('ghp_abc');
  });
});
