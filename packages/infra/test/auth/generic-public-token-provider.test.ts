import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  GenericPublicTokenProvider,
} from '../../src/auth/generic-public-token-provider';

class StubGhTokenProvider implements TokenProvider {
  public calls = 0;

  public constructor(private readonly token: string | undefined) {}

  public async getToken(): Promise<string | undefined> {
    this.calls += 1;
    return this.token;
  }
}

describe('GenericPublicTokenProvider', () => {
  it('prefers GH_TOKEN over GITHUB_TOKEN', async () => {
    const ghCli = new StubGhTokenProvider('from-gh-cli');
    const provider = new GenericPublicTokenProvider({
      env: { GH_TOKEN: 'from-gh-token', GITHUB_TOKEN: 'from-github-token' },
      ghCli
    });

    await expect(provider.getToken('api.github.com')).resolves.toBe('from-gh-token');
    expect(ghCli.calls).toBe(0);
  });

  it('falls back to GITHUB_TOKEN when GH_TOKEN is unavailable', async () => {
    const provider = new GenericPublicTokenProvider({
      env: { GITHUB_TOKEN: 'from-github-token' },
      ghCli: new StubGhTokenProvider('from-gh-cli')
    });

    await expect(provider.getToken('github.com')).resolves.toBe('from-github-token');
  });

  it('uses gh auth token locally when no generic environment token exists', async () => {
    const ghCli = new StubGhTokenProvider('from-gh-cli');
    const provider = new GenericPublicTokenProvider({ env: {}, ghCli, allowGhCli: true });

    await expect(provider.getToken('github.com')).resolves.toBe('from-gh-cli');
    expect(ghCli.calls).toBe(1);
  });

  it('single-flights and caches the local gh token for the process lifetime', async () => {
    const ghCli = new StubGhTokenProvider('from-gh-cli');
    const provider = new GenericPublicTokenProvider({ env: {}, ghCli, allowGhCli: true });

    await expect(Promise.all([
      provider.getToken('api.github.com'),
      provider.getToken('api.github.com'),
      provider.getToken('api.github.com')
    ])).resolves.toEqual(['from-gh-cli', 'from-gh-cli', 'from-gh-cli']);
    await expect(provider.getToken('api.github.com')).resolves.toBe('from-gh-cli');
    expect(ghCli.calls).toBe(1);
  });

  it('does not use gh auth token in CI when no generic environment token exists', async () => {
    const ghCli = new StubGhTokenProvider('from-gh-cli');
    const provider = new GenericPublicTokenProvider({ env: { CI: 'true' }, ghCli });

    await expect(provider.getToken('github.com')).resolves.toBeUndefined();
    expect(ghCli.calls).toBe(0);
  });

  it('does not invoke any credential source for a foreign host', async () => {
    const ghCli = new StubGhTokenProvider('from-gh-cli');
    const provider = new GenericPublicTokenProvider({ env: { GH_TOKEN: 'token' }, ghCli });

    await expect(provider.getToken('example.com')).resolves.toBeUndefined();
    expect(ghCli.calls).toBe(0);
  });
});
