import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  compositeTokenProvider,
  envTokenProvider,
  ghCliTokenProvider,
  NULL_TOKEN_PROVIDER,
  staticTokenProvider,
  type TokenProvider,
} from '../../src/github/token';

describe('github/token', () => {
  describe('NULL_TOKEN_PROVIDER', () => {
    it('always returns null', async () => {
      expect(await NULL_TOKEN_PROVIDER.getToken('github.com')).toBe(null);
      expect(await NULL_TOKEN_PROVIDER.getToken('api.github.com')).toBe(null);
    });
  });

  describe('staticTokenProvider', () => {
    it('returns the token for github hosts', async () => {
      const p = staticTokenProvider('xoxo');
      expect(await p.getToken('github.com')).toBe('xoxo');
      expect(await p.getToken('api.github.com')).toBe('xoxo');
      expect(await p.getToken('raw.githubusercontent.com')).toBe('xoxo');
    });
    it('returns null for non-github hosts', async () => {
      const p = staticTokenProvider('xoxo');
      expect(await p.getToken('evil.com')).toBe(null);
      expect(await p.getToken('ghe.example.com')).toBe(null);
    });
    it('returns null when token is empty', async () => {
      const p = staticTokenProvider('');
      expect(await p.getToken('github.com')).toBe(null);
    });
  });

  describe('envTokenProvider', () => {
    it('reads GITHUB_TOKEN', async () => {
      const p = envTokenProvider({ GITHUB_TOKEN: 'g1', PROMPT_REGISTRY_DISABLE_GH_CLI: '1' });
      expect(await p.getToken('api.github.com')).toBe('g1');
    });
    it('falls back to GH_TOKEN', async () => {
      const p = envTokenProvider({ GH_TOKEN: 'g2', PROMPT_REGISTRY_DISABLE_GH_CLI: '1' });
      expect(await p.getToken('api.github.com')).toBe('g2');
    });
    it('prefers GITHUB_TOKEN over GH_TOKEN', async () => {
      const p = envTokenProvider({ GITHUB_TOKEN: 'g1', GH_TOKEN: 'g2', PROMPT_REGISTRY_DISABLE_GH_CLI: '1' });
      expect(await p.getToken('api.github.com')).toBe('g1');
    });
    it('returns null on non-github hosts even with token', async () => {
      const p = envTokenProvider({ GITHUB_TOKEN: 'g1', PROMPT_REGISTRY_DISABLE_GH_CLI: '1' });
      expect(await p.getToken('evil.com')).toBe(null);
    });
    it('returns null when env empty', async () => {
      const p = envTokenProvider({ PROMPT_REGISTRY_DISABLE_GH_CLI: '1' });
      expect(await p.getToken('github.com')).toBe(null);
    });
  });

  describe('ghCliTokenProvider', () => {
    it('returns null for non-github host without spawning', async () => {
      let spawned = false;
      const p = ghCliTokenProvider({
        spawn: () => {
          spawned = true;
          return { status: 1, stdout: '', stderr: '' };
        }
      });
      expect(await p.getToken('evil.com')).toBe(null);
      expect(spawned).toBe(false);
    });
    it('parses gh stdout when status=0', async () => {
      const p = ghCliTokenProvider({
        spawn: () => ({ status: 0, stdout: 'ghp_fake_token\n', stderr: '' })
      });
      expect(await p.getToken('github.com')).toBe('ghp_fake_token');
    });
    it('returns null on non-zero exit', async () => {
      const p = ghCliTokenProvider({
        spawn: () => ({ status: 1, stdout: '', stderr: 'not logged in' })
      });
      expect(await p.getToken('github.com')).toBe(null);
    });
    it('returns null when stdout is empty after trim', async () => {
      const p = ghCliTokenProvider({
        spawn: () => ({ status: 0, stdout: '   \n  ', stderr: '' })
      });
      expect(await p.getToken('github.com')).toBe(null);
    });
    it('swallows spawn exceptions and returns null', async () => {
      const p = ghCliTokenProvider({
        spawn: () => {
          throw new Error('ENOENT');
        }
      });
      expect(await p.getToken('github.com')).toBe(null);
    });
  });

  describe('compositeTokenProvider', () => {
    const yes = (tok: string): TokenProvider => ({
      getToken: () => Promise.resolve(tok)
    });
    const no: TokenProvider = { getToken: () => Promise.resolve(null) };

    it('returns the first non-null token in order', async () => {
      const p = compositeTokenProvider(no, yes('first'), yes('second'));
      expect(await p.getToken('github.com')).toBe('first');
    });
    it('returns null when all return null', async () => {
      const p = compositeTokenProvider(no, no);
      expect(await p.getToken('github.com')).toBe(null);
    });
    it('handles empty list', async () => {
      const p = compositeTokenProvider();
      expect(await p.getToken('github.com')).toBe(null);
    });
    it('treats empty-string token as null and continues', async () => {
      const p = compositeTokenProvider(yes(''), yes('real'));
      expect(await p.getToken('github.com')).toBe('real');
    });
  });
});
