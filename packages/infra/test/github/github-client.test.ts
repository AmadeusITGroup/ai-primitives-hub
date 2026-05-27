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
  GitHubApiError,
} from '../../src/github/errors';
import type {
  ClientEvent,
} from '../../src/github/events';
import {
  staticTokenProvider,
} from '../../src/github/token';

interface FakeStep {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

const fakeFetch = (steps: FakeStep[]): { fetch: FetchLike; calls: Request[] } => {
  const calls: Request[] = [];
  let i = 0;
  const fetch: FetchLike = (req: Request): Promise<Response> => {
    calls.push(req);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const headers = new Headers(step.headers ?? {});
    const nullBodyStatus = step.status === 304 || step.status === 204 || step.status === 205;
    return Promise.resolve(new Response(nullBodyStatus ? null : (step.body ?? ''), {
      status: step.status,
      headers
    }));
  };
  return { fetch, calls };
};

const newClient = (
  steps: FakeStep[],
  events?: ClientEvent[],
  overrides: Partial<ConstructorParameters<typeof GitHubClient>[0]> = {}
): { client: GitHubClient; calls: Request[] } => {
  const { fetch, calls } = fakeFetch(steps);
  const client = new GitHubClient({
    tokens: staticTokenProvider('test-token'),
    fetch,
    backoffBaseMs: 1,
    jitterMs: 0,
    maxSleepMs: 10,
    sleep: () => Promise.resolve(),
    onEvent: events === undefined
      ? undefined
      : (e): void => {
        events.push(e);
      },
    ...overrides
  });
  return { client, calls };
};

describe('github/client GitHubClient', () => {
  describe('getJson', () => {
    it('returns parsed JSON on 200', async () => {
      const { client } = newClient([
        { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } }
      ]);
      const r = await client.getJson<{ ok: boolean }>('/x');
      expect(r).toStrictEqual({ ok: true });
    });

    it('attaches Authorization, Accept, User-Agent, X-GitHub-Api-Version headers', async () => {
      const { client, calls } = newClient([{ status: 200, body: '{}' }]);
      await client.getJson('/x');
      const h = calls[0].headers;
      expect(h.get('authorization')).toBe('Bearer test-token');
      expect(h.get('accept')).toBe('application/vnd.github+json');
      expect(h.get('x-github-api-version')).toBe('2022-11-28');
      expect(h.get('user-agent') ?? '').toMatch(/prompt-registry/i);
    });

    it('joins relative paths against api.github.com', async () => {
      const { client, calls } = newClient([{ status: 200, body: '{}' }]);
      await client.getJson('/repos/foo/bar');
      expect(calls[0].url).toBe('https://api.github.com/repos/foo/bar');
    });

    it('passes absolute URLs through unchanged', async () => {
      const { client, calls } = newClient([{ status: 200, body: '{}' }]);
      await client.getJson('https://api.github.com/explicit');
      expect(calls[0].url).toBe('https://api.github.com/explicit');
    });

    it('throws GitHubApiError on 404', async () => {
      const { client } = newClient([{ status: 404, body: 'not found' }]);
      try {
        await client.getJson('/x');
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).status).toBe(404);
        expect((err as GitHubApiError).body).toContain('not found');
      }
    });

    it('does NOT retry on 401 (fatal auth error)', async () => {
      const { client, calls } = newClient([
        { status: 401, body: 'bad creds' },
        { status: 200, body: '{}' }
      ]);
      await expect(client.getJson('/x')).rejects.toThrow(GitHubApiError);
      expect(calls.length).toBe(1);
    });
  });

  describe('retry on transient 5xx', () => {
    it('succeeds after one 503 retry', async () => {
      const { client, calls } = newClient([
        { status: 503, body: 'gateway' },
        { status: 200, body: '{"ok":1}' }
      ]);
      const r = await client.getJson<{ ok: number }>('/x');
      expect(r).toStrictEqual({ ok: 1 });
      expect(calls.length).toBe(2);
    });

    it('retries 408 / 429 / 500 / 502 / 503 / 504', async () => {
      for (const code of [408, 429, 500, 502, 503, 504]) {
        const { client, calls } = newClient([
          { status: code, body: 'x' },
          { status: 200, body: '{}' }
        ]);
        await client.getJson('/x');
        expect(calls.length).toBe(2);
      }
    });

    it('gives up after maxRetries', async () => {
      const { client, calls } = newClient(
        [{ status: 503, body: 'down' }],
        undefined,
        { maxRetries: 2 }
      );
      await expect(client.getJson('/x')).rejects.toThrow(GitHubApiError);
      expect(calls.length).toBe(3);
    });

    it('emits retry events with attempt + sleepMs', async () => {
      const events: ClientEvent[] = [];
      const { client } = newClient(
        [{ status: 503, body: 'x' }, { status: 200, body: '{}' }],
        events
      );
      await client.getJson('/x');
      const kinds = events.map((e) => e.kind);
      expect(kinds).toStrictEqual(['request', 'retry', 'request', 'success']);
      expect(typeof events[1].sleepMs === 'number' && events[1].sleepMs >= 0).toBe(true);
    });
  });

  describe('rate-limit handling', () => {
    it('sleeps until x-ratelimit-reset on 403 with remaining=0', async () => {
      const reset = Math.floor(Date.now() / 1000) + 1;
      const events: ClientEvent[] = [];
      const { client } = newClient(
        [
          {
            status: 403,
            body: 'rate limit',
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(reset)
            }
          },
          { status: 200, body: '{}' }
        ],
        events,
        { maxSleepMs: 100_000 }
      );
      await client.getJson('/x');
      const rl = events.find((e) => e.kind === 'rate-limit');
      expect(rl).toBeDefined();
      expect(rl?.reason).toBe('primary rate limit');
    });

    it('honours Retry-After on secondary rate limit (403 + body match)', async () => {
      const events: ClientEvent[] = [];
      const { client } = newClient(
        [
          {
            status: 403,
            body: 'You have exceeded a secondary rate limit',
            headers: { 'retry-after': '1' }
          },
          { status: 200, body: '{}' }
        ],
        events
      );
      await client.getJson('/x');
      const rl = events.find((e) => e.kind === 'rate-limit');
      expect(rl).toBeDefined();
      expect(rl?.reason).toBe('secondary rate limit');
    });

    it('treats 403 without rate-limit signals as fatal', async () => {
      const { client, calls } = newClient([
        { status: 403, body: 'forbidden — repo private' }
      ]);
      await expect(client.getJson('/x')).rejects.toThrow(GitHubApiError);
      expect(calls.length).toBe(1);
    });
  });

  describe('rate-limit telemetry', () => {
    it('captures lastRateLimit on every response', async () => {
      const reset = Math.floor(Date.now() / 1000) + 60;
      const { client } = newClient([
        {
          status: 200,
          body: '{}',
          headers: {
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-used': '1',
            'x-ratelimit-reset': String(reset)
          }
        }
      ]);
      await client.getJson('/x');
      expect(client.lastRateLimit.limit).toBe(5000);
      expect(client.lastRateLimit.remaining).toBe(4999);
      expect(client.lastRateLimit.used).toBe(1);
      expect(client.lastRateLimit.resetAt instanceof Date).toBe(true);
    });

    it('leaves telemetry undefined when headers missing', async () => {
      const { client } = newClient([{ status: 200, body: '{}' }]);
      await client.getJson('/x');
      expect(client.lastRateLimit.limit).toBeUndefined();
    });
  });

  describe('getJsonWithEtag', () => {
    it('returns ok with etag on 200', async () => {
      const { client } = newClient([
        { status: 200, body: '{"v":1}', headers: { etag: '"abc"' } }
      ]);
      const r = await client.getJsonWithEtag<{ v: number }>('/x');
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.value).toStrictEqual({ v: 1 });
        expect(r.etag).toBe('"abc"');
      }
    });

    it('returns notModified on 304', async () => {
      const { client, calls } = newClient([{ status: 304 }]);
      const r = await client.getJsonWithEtag('/x', '"abc"');
      expect(r.status).toBe('notModified');
      expect(calls[0].headers.get('if-none-match')).toBe('"abc"');
    });

    it('emits a not-modified event on 304', async () => {
      const events: ClientEvent[] = [];
      const { client } = newClient([{ status: 304 }], events);
      await client.getJsonWithEtag('/x', '"abc"');
      expect(events.some((e) => e.kind === 'not-modified')).toBe(true);
    });
  });

  describe('getText', () => {
    it('returns raw text body', async () => {
      const { client } = newClient([{ status: 200, body: 'hello world' }]);
      expect(await client.getText('/x')).toBe('hello world');
    });
  });

  describe('unauthenticated mode', () => {
    it('omits Authorization when no token resolves', async () => {
      const { fetch, calls } = fakeFetch([{ status: 200, body: '{}' }]);
      const client = new GitHubClient({
        tokens: staticTokenProvider(''),
        fetch,
        backoffBaseMs: 1,
        jitterMs: 0,
        maxSleepMs: 10,
        sleep: () => Promise.resolve()
      });
      await client.getJson('/x');
      expect(calls[0].headers.get('authorization')).toBe(null);
    });
  });
});
