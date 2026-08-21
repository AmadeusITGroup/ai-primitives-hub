import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  AuthEvent,
} from '../../src/auth/auth-event';
import {
  StaticTokenProvider,
} from '../../src/auth/static-token-provider';

const SECRET = 'ghp_SuperSecretMaterial';

describe('StaticTokenProvider', () => {
  it('returns the token for a GitHub host', async () => {
    const provider = new StaticTokenProvider(SECRET);
    await expect(provider.getToken('github.com')).resolves.toBe(SECRET);
  });

  it('returns the token for an Azure DevOps host', async () => {
    const provider = new StaticTokenProvider(SECRET);
    await expect(provider.getToken('dev.azure.com')).resolves.toBe(SECRET);
  });

  it('returns undefined for an unrelated host', async () => {
    const provider = new StaticTokenProvider(SECRET);
    await expect(provider.getToken('example.com')).resolves.toBeUndefined();
  });

  it('returns undefined for an empty token', async () => {
    const provider = new StaticTokenProvider('');
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('declares the configured-token origin', () => {
    expect(new StaticTokenProvider(SECRET).origin).toBe('configured-token');
  });

  describe('auth events', () => {
    it('reports an attempt then a resolution carrying the token type', async () => {
      const events: AuthEvent[] = [];
      const provider = new StaticTokenProvider(SECRET, (event) => events.push(event));

      await provider.getToken('api.github.com');

      expect(events.map((event) => event.kind)).toEqual(['attempt', 'resolved']);
      expect(events[1]).toMatchObject({
        kind: 'resolved',
        origin: 'configured-token',
        host: 'api.github.com',
        tokenType: 'ghp_'
      });
    });

    it('reports not-set when no token is configured', async () => {
      const events: AuthEvent[] = [];
      const provider = new StaticTokenProvider('', (event) => events.push(event));

      await provider.getToken('github.com');

      expect(events.map((event) => event.kind)).toEqual(['attempt', 'skipped']);
      expect(events[1]).toMatchObject({ kind: 'skipped', reason: 'not-set' });
    });

    it('reports non-github-host without reporting an attempt', async () => {
      const events: AuthEvent[] = [];
      const provider = new StaticTokenProvider(SECRET, (event) => events.push(event));

      await provider.getToken('example.com');

      expect(events.map((event) => event.kind)).toEqual(['skipped']);
      expect(events[0]).toMatchObject({ kind: 'skipped', reason: 'non-github-host' });
    });

    it('never places token material in an event', async () => {
      const events: AuthEvent[] = [];
      const provider = new StaticTokenProvider(SECRET, (event) => events.push(event));

      await provider.getToken('github.com');

      expect(JSON.stringify(events)).not.toContain('SuperSecretMaterial');
    });
  });
});
