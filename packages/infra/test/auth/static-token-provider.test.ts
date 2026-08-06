import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  StaticTokenProvider,
} from '../../src/auth/static-token-provider';

describe('StaticTokenProvider', () => {
  it('reports an explicit origin by default', async () => {
    const provider = new StaticTokenProvider('gho_secret');
    await expect(provider.getToken('github.com')).resolves.toEqual({
      token: 'gho_secret',
      origin: { kind: 'explicit' }
    });
  });

  it('carries a caller-supplied origin, so an injected token can name its source', async () => {
    const provider = new StaticTokenProvider('gho_secret', { kind: 'setting', detail: 'promptregistry.githubToken' });
    await expect(provider.getToken('github.com')).resolves.toEqual({
      token: 'gho_secret',
      origin: { kind: 'setting', detail: 'promptregistry.githubToken' }
    });
  });

  it('returns undefined for an empty token', async () => {
    const provider = new StaticTokenProvider('');
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('refuses to hand a GitHub token to an unrelated host', async () => {
    const provider = new StaticTokenProvider('gho_secret');
    await expect(provider.getToken('example.com')).resolves.toBeUndefined();
  });

  it('accepts any GitHub-owned host (api, raw content)', async () => {
    const provider = new StaticTokenProvider('gho_secret');
    await expect(provider.getToken('api.github.com')).resolves.toMatchObject({ token: 'gho_secret' });
    await expect(provider.getToken('raw.githubusercontent.com')).resolves.toMatchObject({ token: 'gho_secret' });
  });
});
