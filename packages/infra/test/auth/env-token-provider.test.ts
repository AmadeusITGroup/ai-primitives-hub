import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  AuthEvent,
} from '../../src/auth/auth-event';
import {
  EnvTokenProvider,
} from '../../src/auth/env-token-provider';

describe('EnvTokenProvider', () => {
  it('prefers GITHUB_TOKEN over GH_TOKEN', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'from-github-token', GH_TOKEN: 'from-gh-token' });
    await expect(provider.getToken('github.com')).resolves.toBe('from-github-token');
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is unset', async () => {
    const provider = new EnvTokenProvider({ GH_TOKEN: 'from-gh-token' });
    await expect(provider.getToken('github.com')).resolves.toBe('from-gh-token');
  });

  it('returns undefined when neither env var is set', async () => {
    const provider = new EnvTokenProvider({});
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('returns undefined when the token is an empty string', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: '' });
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('returns undefined for a non-GitHub host', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'secret' });
    await expect(provider.getToken('example.com')).resolves.toBeUndefined();
  });

  it('accepts any GitHub-owned host (api, raw content)', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'secret' });
    await expect(provider.getToken('api.github.com')).resolves.toBe('secret');
    await expect(provider.getToken('raw.githubusercontent.com')).resolves.toBe('secret');
  });
});

describe('EnvTokenProvider auth events', () => {
  const capture = (): { events: AuthEvent[]; handler: (event: AuthEvent) => void } => {
    const events: AuthEvent[] = [];
    return { events, handler: (event) => events.push(event) };
  };

  it('declares the env-var origin', () => {
    expect(new EnvTokenProvider({}).origin).toBe('env-var');
  });

  it('names the variable it consulted and reports the token type', async () => {
    const { events, handler } = capture();
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'ghp_abc123' }, handler);

    await provider.getToken('github.com');

    expect(events.map((event) => event.kind)).toEqual(['attempt', 'resolved']);
    expect(events[0]).toMatchObject({ kind: 'attempt', detail: 'GITHUB_TOKEN' });
    expect(events[1]).toMatchObject({ kind: 'resolved', origin: 'env-var', tokenType: 'ghp_' });
  });

  it('names GH_TOKEN when GITHUB_TOKEN is absent', async () => {
    const { events, handler } = capture();
    const provider = new EnvTokenProvider({ GH_TOKEN: 'ghp_abc123' }, handler);

    await provider.getToken('github.com');

    expect(events[0]).toMatchObject({ kind: 'attempt', detail: 'GH_TOKEN' });
  });

  it('reports not-set when neither variable holds a value', async () => {
    const { events, handler } = capture();
    const provider = new EnvTokenProvider({}, handler);

    await provider.getToken('github.com');

    expect(events.map((event) => event.kind)).toEqual(['attempt', 'skipped']);
    expect(events[1]).toMatchObject({ kind: 'skipped', reason: 'not-set' });
  });

  it('reports non-github-host without reporting an attempt', async () => {
    const { events, handler } = capture();
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'ghp_abc123' }, handler);

    await provider.getToken('example.com');

    expect(events.map((event) => event.kind)).toEqual(['skipped']);
    expect(events[0]).toMatchObject({ reason: 'non-github-host' });
  });

  it('never places token material in an event', async () => {
    const { events, handler } = capture();
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'ghp_SuperSecretMaterial' }, handler);

    await provider.getToken('github.com');

    expect(JSON.stringify(events)).not.toContain('SuperSecretMaterial');
  });
});
