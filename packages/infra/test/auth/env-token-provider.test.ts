import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  EnvTokenProvider,
} from '../../src/auth/env-token-provider';

describe('EnvTokenProvider', () => {
  it('prefers GITHUB_TOKEN over GH_TOKEN, and says which one it used', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'from-github-token', GH_TOKEN: 'from-gh-token' });
    await expect(provider.getToken('github.com')).resolves.toEqual({
      token: 'from-github-token',
      origin: { kind: 'env', detail: 'GITHUB_TOKEN' }
    });
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is unset, and names GH_TOKEN', async () => {
    const provider = new EnvTokenProvider({ GH_TOKEN: 'from-gh-token' });
    await expect(provider.getToken('github.com')).resolves.toEqual({
      token: 'from-gh-token',
      origin: { kind: 'env', detail: 'GH_TOKEN' }
    });
  });

  it('returns undefined when neither env var is set', async () => {
    const provider = new EnvTokenProvider({});
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('returns undefined when the token is an empty string', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: '' });
    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
  });

  it('falls through to GH_TOKEN when GITHUB_TOKEN is set but empty', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: '', GH_TOKEN: 'from-gh-token' });
    await expect(provider.getToken('github.com')).resolves.toEqual({
      token: 'from-gh-token',
      origin: { kind: 'env', detail: 'GH_TOKEN' }
    });
  });

  it('returns undefined for a non-GitHub host', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'secret' });
    await expect(provider.getToken('example.com')).resolves.toBeUndefined();
  });

  it('accepts any GitHub-owned host (api, raw content)', async () => {
    const provider = new EnvTokenProvider({ GITHUB_TOKEN: 'secret' });
    await expect(provider.getToken('api.github.com')).resolves.toMatchObject({ token: 'secret' });
    await expect(provider.getToken('raw.githubusercontent.com')).resolves.toMatchObject({ token: 'secret' });
  });
});
