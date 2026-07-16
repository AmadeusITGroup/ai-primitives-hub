import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  CompositeTokenProvider,
} from '../../src/auth/composite-token-provider';

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
