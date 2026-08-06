import type {
  ResolvedToken,
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

function fakeProvider(fn: (host: string) => Promise<ResolvedToken | undefined>): TokenProvider {
  return { getToken: fn };
}

function resolved(token: string, kind: ResolvedToken['origin']['kind'] = 'explicit'): ResolvedToken {
  return { token, origin: { kind } };
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
        return resolved('token-from-second');
      }),
      fakeProvider(async () => {
        calls.push('third');
        return resolved('token-from-third');
      })
    ]);

    await expect(provider.getToken('github.com')).resolves.toMatchObject({ token: 'token-from-second' });
    expect(calls).toEqual(['first', 'second']);
  });

  it('preserves the winning provider\'s origin, so provenance survives the chain', async () => {
    const provider = new CompositeTokenProvider([
      fakeProvider(async () => undefined),
      fakeProvider(async () => ({
        token: 'gho_session',
        origin: { kind: 'vscode-session', detail: 'octocat' }
      }))
    ]);

    await expect(provider.getToken('github.com')).resolves.toEqual({
      token: 'gho_session',
      origin: { kind: 'vscode-session', detail: 'octocat' }
    });
  });

  it('stops at the first provider, never calling later ones', async () => {
    const calls: string[] = [];
    const provider = new CompositeTokenProvider([
      fakeProvider(async () => {
        calls.push('first');
        return resolved('token-from-first');
      }),
      fakeProvider(async () => {
        calls.push('second');
        return resolved('token-from-second');
      })
    ]);

    await expect(provider.getToken('github.com')).resolves.toMatchObject({ token: 'token-from-first' });
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
