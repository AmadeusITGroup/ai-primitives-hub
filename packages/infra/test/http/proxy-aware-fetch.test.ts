/**
 * Tests for proxy-aware fetch.
 *
 * Covers the helper that wraps undici's `EnvHttpProxyAgent` so the CLI
 * honours the standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` environment
 * variables just like the `gh` CLI does.
 */
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createProxyAwareFetch,
  hasProxyEnv,
  summarizeProxyEnv,
} from '../../src/http/proxy-aware-fetch';

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
    expect(result).toEqual({
      configured: true,
      httpsProxy: 'http://proxy:8080',
      noProxy: 'localhost'
    });
  });

  it('reports no proxy env vars', () => {
    expect(summarizeProxyEnv({})).toEqual({ configured: false });
  });
});

describe('createProxyAwareFetch', () => {
  it('falls back to global fetch when no proxy env vars are set', async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as typeof fetch;
    const fetchFn = createProxyAwareFetch({});
    const req = new Request('https://api.github.com/rate_limit');
    const response = new Response('ok');
    mockFetch.mockResolvedValue(response);

    const result = await fetchFn(req);

    expect(mockFetch).toHaveBeenCalledWith(req);
    expect(result).toBe(response);
  });

  it('passes an undici dispatcher when proxy env vars are set', async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as typeof fetch;
    const fetchFn = createProxyAwareFetch({ HTTPS_PROXY: 'http://proxy:8080' });
    const req = new Request('https://api.github.com/rate_limit');
    const response = new Response('ok');
    mockFetch.mockResolvedValue(response);

    const result = await fetchFn(req);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0];
    expect(init).toBeDefined();
    expect(init.dispatcher).toBeDefined();
    expect(result).toBe(response);
  });
});
