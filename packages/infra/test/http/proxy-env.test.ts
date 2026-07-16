/**
 * Tests for proxy environment inspection.
 *
 * Covers the helper `doctor`'s network-config check uses to report whether
 * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (or git config `http.proxy`/
 * `https.proxy`) are configured.
 */
import {
  execSync,
} from 'node:child_process';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  hasProxyEnv,
  summarizeProxyEnv,
} from '../../src/http/proxy-env';

// Mock execSync so git config reads are deterministic regardless of the
// developer's local git config.
vi.mock('node:child_process', () => ({
  execSync: vi.fn()
}));

describe('hasProxyEnv', () => {
  it('returns false when no proxy env vars are set', () => {
    expect(hasProxyEnv({})).toBe(false);
  });

  it('returns true when HTTP_PROXY is set', () => {
    expect(hasProxyEnv({ HTTP_PROXY: 'http://proxy:8080' })).toBe(true);
  });

  it('returns true when HTTPS_PROXY is set', () => {
    expect(hasProxyEnv({ HTTPS_PROXY: 'http://proxy:8080' })).toBe(true);
  });

  it('returns true when NO_PROXY is set', () => {
    expect(hasProxyEnv({ NO_PROXY: 'localhost,.example.com' })).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasProxyEnv({ http_proxy: 'http://proxy:8080' })).toBe(true);
    expect(hasProxyEnv({ https_proxy: 'http://proxy:8080' })).toBe(true);
    expect(hasProxyEnv({ no_proxy: 'localhost' })).toBe(true);
  });
});

describe('summarizeProxyEnv', () => {
  it('reports configured proxy env vars', () => {
    const result = summarizeProxyEnv({
      HTTPS_PROXY: 'http://proxy:8080',
      NO_PROXY: 'localhost'
    });
    expect(result).toMatchObject({
      configured: true,
      httpsProxy: 'http://proxy:8080',
      noProxy: 'localhost',
      source: 'env'
    });
  });

  it('reports no proxy env vars', () => {
    expect(summarizeProxyEnv({})).toEqual({ configured: false });
  });

  it('reports git config proxy when env vars are not set', () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('https.proxy')) {
        return 'http://git-proxy:8080';
      }
      throw new Error('not set');
    });
    const result = summarizeProxyEnv({});
    expect(result).toMatchObject({
      configured: true,
      source: 'git-config'
    });
    vi.mocked(execSync).mockReset();
  });
});
