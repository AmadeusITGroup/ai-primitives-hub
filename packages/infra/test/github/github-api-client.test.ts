import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  type FetchLike,
  GitHubClient,
} from '../../src/github/client';
import {
  staticTokenProvider,
} from '../../src/github/token';

function mockResponse(init: {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}): Response {
  const { status = 200, headers = {}, body = {} } = init;
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    {
      status,
      headers: { 'content-type': 'application/json', ...headers }
    }
  );
}

describe('github-api-client', () => {
  it('sends Authorization + User-Agent + default accept headers', async () => {
    const calls: Request[] = [];
    const fetch: FetchLike = async (req) => {
      calls.push(req);
      return mockResponse({ body: { ok: true } });
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('ghp_test'), fetch });
    const r = await client.getJson<{ ok: boolean }>('/user');
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].headers.get('authorization')).toBe('Bearer ghp_test');
    expect(calls[0].headers.get('user-agent') ?? '').toMatch(/prompt-registry-lib\//);
    expect(calls[0].headers.get('accept') ?? '').toMatch(/application\/vnd\.github/);
  });

  it('retries 5xx with bounded attempts and exponential backoff', async () => {
    let attempt = 0;
    const fetch: FetchLike = async () => {
      attempt += 1;
      if (attempt < 3) {
        return mockResponse({ status: 502, body: { message: 'bad gateway' } });
      }
      return mockResponse({ body: { ok: true } });
    };
    const client = new GitHubClient({
      tokens: staticTokenProvider('t'),
      fetch,
      maxRetries: 4,
      backoffBaseMs: 1,
      jitterMs: 0
    });
    const r = await client.getJson<{ ok: boolean }>('/foo');
    expect(r.ok).toBe(true);
    expect(attempt).toBe(3);
  });

  it('respects primary rate-limit: 403 + x-ratelimit-remaining=0 sleeps until reset', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 1;
    let attempt = 0;
    const fetch: FetchLike = async () => {
      attempt += 1;
      if (attempt === 1) {
        return mockResponse({
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetAt)
          },
          body: { message: 'API rate limit exceeded' }
        });
      }
      return mockResponse({ body: { ok: true } });
    };
    const start = Date.now();
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch, maxRetries: 3, backoffBaseMs: 1, jitterMs: 0, maxSleepMs: 2000 });
    const r = await client.getJson<{ ok: boolean }>('/foo');
    const elapsed = Date.now() - start;
    expect(r.ok).toBe(true);
    expect(attempt).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('retries secondary rate-limit (403 with Retry-After)', async () => {
    let attempt = 0;
    const fetch: FetchLike = async () => {
      attempt += 1;
      if (attempt === 1) {
        return mockResponse({
          status: 403,
          headers: { 'retry-after': '0' },
          body: { message: 'secondary rate limit' }
        });
      }
      return mockResponse({ body: { ok: true } });
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch, maxRetries: 3, backoffBaseMs: 1, jitterMs: 0 });
    const r = await client.getJson<{ ok: boolean }>('/foo');
    expect(r.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it('gives up after maxRetries and throws a classified error', async () => {
    const fetch: FetchLike = async () => mockResponse({ status: 500, body: { message: 'oops' } });
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch, maxRetries: 2, backoffBaseMs: 1, jitterMs: 0 });
    await expect(
      client.getJson('/foo')
    ).rejects.toThrow(/after 2 retries/);
    await expect(
      client.getJson('/foo')
    ).rejects.toThrow(/500/);
  });

  it('supports If-None-Match: returns notModified on 304 without refetch', async () => {
    let attempt = 0;
    const fetch: FetchLike = async (req) => {
      attempt += 1;
      if (req.headers.get('if-none-match') === 'etag-abc') {
        return new Response(null, { status: 304 });
      }
      return mockResponse({ headers: { etag: 'etag-abc' }, body: { ok: true } });
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch });
    const first = await client.getJsonWithEtag<{ ok: boolean }>('/foo');
    expect(first.status).toBe('ok');
    expect((first as any).etag).toBe('etag-abc');
    const second = await client.getJsonWithEtag<{ ok: boolean }>('/foo', (first as any).etag);
    expect(second.status).toBe('notModified');
    expect(attempt).toBe(2);
  });

  it('4xx (other than 403 rate limit) is raised immediately (no retry)', async () => {
    let attempt = 0;
    const fetch: FetchLike = async () => {
      attempt += 1;
      return mockResponse({ status: 404, body: { message: 'Not Found' } });
    };
    const client = new GitHubClient({ tokens: staticTokenProvider('t'), fetch, maxRetries: 3, backoffBaseMs: 1, jitterMs: 0 });
    await expect(client.getJson('/nope')).rejects.toThrow(/404/);
    expect(attempt).toBe(1);
  });
});
