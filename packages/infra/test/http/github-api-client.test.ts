import type {
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HttpClient,
  HttpRequest,
  HttpResponse,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  GitHubClientEvent,
} from '../../src/http/github-api-client';
import {
  GitHubApiClient,
} from '../../src/http/github-api-client';

/**
 * Returns each queued response in order, repeating the last one once exhausted.
 * A queued `Error` is thrown instead of returned, modelling a transport-level
 * failure (connection reset, DNS failure, or the HTTP adapter's request timeout).
 */
class FakeHttpClient implements HttpClient {
  public lastRequest?: HttpRequest;
  public requests: HttpRequest[] = [];
  private readonly queue: (HttpResponse | Error)[];

  public constructor(responses: HttpResponse | Error | (HttpResponse | Error)[]) {
    this.queue = Array.isArray(responses) ? [...responses] : [responses];
  }

  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    this.lastRequest = request;
    this.requests.push(request);
    const next = this.queue.length > 1 ? this.queue.shift()! : this.queue[0];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

class StaticTokenProvider implements TokenProvider {
  public lastHost: string | undefined;
  public lastTarget: GitHubRepositoryTarget | undefined;

  public constructor(private readonly token: string | undefined) {}

  public async getToken(host: string, target?: GitHubRepositoryTarget): Promise<string | undefined> {
    this.lastHost = host;
    this.lastTarget = target;
    return this.token;
  }
}

class CountingTokenProvider implements TokenProvider {
  public calls = 0;

  public async getToken(): Promise<string | undefined> {
    this.calls += 1;
    return 'should-not-be-used';
  }
}

function jsonResponse(body: unknown, statusCode = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    statusCode,
    body: new TextEncoder().encode(JSON.stringify(body)),
    finalUrl: 'https://api.github.com/resolved',
    headers
  };
}

const noSleep = async (): Promise<void> => undefined;

function recordingSleep(sleeps: number[]): (ms: number) => Promise<void> {
  return async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
}

describe('GitHubApiClient', () => {
  it('resolves a relative path against the default GitHub API base URL', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    await new GitHubApiClient(http).getJson('/repos/o/r');
    expect(http.lastRequest?.url).toBe('https://api.github.com/repos/o/r');
  });

  it('leaves an absolute URL untouched', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    await new GitHubApiClient(http).getJson('https://example.com/custom');
    expect(http.lastRequest?.url).toBe('https://example.com/custom');
  });

  it('sends a User-Agent and Accept: application/json for getJson', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    await new GitHubApiClient(http, { userAgent: 'test-agent/1.0' }).getJson('/repos/o/r');
    expect(http.lastRequest?.headers).toMatchObject({
      'User-Agent': 'test-agent/1.0',
      Accept: 'application/json'
    });
  });

  it('adds an Authorization header when a TokenProvider resolves a token', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    const client = new GitHubApiClient(http, { tokenProvider: new StaticTokenProvider('secret-token') });
    await client.getJson('/repos/o/r');
    expect(http.lastRequest?.headers?.Authorization).toBe('token secret-token');
  });

  it('omits Authorization when the TokenProvider resolves undefined', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    const client = new GitHubApiClient(http, { tokenProvider: new StaticTokenProvider(undefined) });
    await client.getJson('/repos/o/r');
    expect(http.lastRequest?.headers?.Authorization).toBeUndefined();
  });

  it('does not make an anonymous request for a public-generic source when its token is unavailable', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    const client = new GitHubApiClient(http, {
      tokenProvider: new StaticTokenProvider(undefined),
      authenticationCategory: 'public-generic'
    });

    await expect(client.getJson('/repos/o/r')).rejects.toMatchObject({
      code: 'GH_PUBLIC_GENERIC_TOKEN_UNAVAILABLE'
    });
    expect(http.requests).toHaveLength(0);
  });

  it('parses the JSON body on success', async () => {
    const http = new FakeHttpClient(jsonResponse({ name: 'repo' }));
    await expect(new GitHubApiClient(http).getJson('/repos/o/r')).resolves.toEqual({ name: 'repo' });
  });

  it('throws a descriptive error on a 404 response', async () => {
    const http = new FakeHttpClient(jsonResponse({}, 404));
    await expect(new GitHubApiClient(http).getJson('/repos/o/r')).rejects.toThrow('404');
  });

  it('throws a descriptive error on a 401 response', async () => {
    const http = new FakeHttpClient(jsonResponse({}, 401));
    await expect(new GitHubApiClient(http).getJson('/repos/o/r')).rejects.toThrow('Authentication failed');
  });

  it('throws a descriptive error on a 403 response', async () => {
    const http = new FakeHttpClient(jsonResponse({}, 403));
    await expect(new GitHubApiClient(http).getJson('/repos/o/r')).rejects.toThrow('Access forbidden');
  });

  it('throws when the response body is not valid JSON', async () => {
    const http = new FakeHttpClient({
      statusCode: 200,
      body: new TextEncoder().encode('not json'),
      finalUrl: 'https://api.github.com/repos/o/r',
      headers: {}
    });
    await expect(new GitHubApiClient(http).getJson('/repos/o/r')).rejects.toThrow('Failed to parse');
  });

  it('requests Accept: application/octet-stream for a relative (API) asset path via getText', async () => {
    const http = new FakeHttpClient({
      statusCode: 200,
      body: new TextEncoder().encode('id: my-bundle'),
      finalUrl: '',
      headers: {}
    });
    await new GitHubApiClient(http).getText('/repos/o/r/releases/assets/1');
    expect(http.lastRequest?.headers?.Accept).toBe('application/octet-stream');
  });

  it('does not force Accept: application/octet-stream for a non-API absolute URL via getText', async () => {
    const http = new FakeHttpClient({
      statusCode: 200,
      body: new TextEncoder().encode('id: my-bundle'),
      finalUrl: '',
      headers: {}
    });
    await new GitHubApiClient(http).getText('https://raw.githubusercontent.com/o/r/main/manifest.yml');
    expect(http.lastRequest?.headers?.Accept).toBe('*/*');
  });

  it('download() returns raw bytes', async () => {
    const bytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04]);
    const http = new FakeHttpClient({ statusCode: 200, body: bytes, finalUrl: '', headers: {} });
    await expect(new GitHubApiClient(http).download('/repos/o/r/releases/assets/1')).resolves.toEqual(bytes);
  });

  it('resolves the token host from the request URL, not the configured base URL', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    const tokenProvider = new StaticTokenProvider('secret-token');
    await new GitHubApiClient(http, { tokenProvider }).getText('https://raw.githubusercontent.com/o/r/main/manifest.yml');
    expect(tokenProvider.lastHost).toBe('raw.githubusercontent.com');
  });

  it('passes the source repository target while preserving the request host', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    const tokenProvider = new StaticTokenProvider('secret-token');
    const target: GitHubRepositoryTarget = {
      host: 'github.com',
      owner: 'owner',
      repository: 'repo'
    };
    const client = new GitHubApiClient(http, { tokenProvider, repositoryTarget: target });

    await client.getText('https://raw.githubusercontent.com/owner/repo/main/file.txt');

    expect(tokenProvider.lastHost).toBe('raw.githubusercontent.com');
    expect(tokenProvider.lastTarget).toEqual(target);
  });

  it('does not invoke a token provider for a public-anonymous source', async () => {
    const http = new FakeHttpClient(jsonResponse({ ok: true }));
    const tokenProvider = new CountingTokenProvider();
    const category: GitHubSourceAuthCategory = 'public-anonymous';
    const client = new GitHubApiClient(http, {
      tokenProvider,
      authenticationCategory: category,
      repositoryTarget: {
        host: 'github.com',
        owner: 'owner',
        repository: 'repo'
      }
    });

    await client.getJson('/repos/owner/repo');

    expect(tokenProvider.calls).toBe(0);
    expect(http.lastRequest?.headers?.Authorization).toBeUndefined();
  });

  describe('retry / backoff', () => {
    it('retries a transient 5xx and returns the eventual success', async () => {
      const http = new FakeHttpClient([jsonResponse({}, 503), jsonResponse({ ok: true })]);
      const client = new GitHubApiClient(http, { sleep: noSleep });
      await expect(client.getJson('/repos/o/r')).resolves.toEqual({ ok: true });
      expect(http.requests).toHaveLength(2);
    });

    it('retries mixed rate limits and transient failures within a configured larger budget', async () => {
      const http = new FakeHttpClient([jsonResponse({}, 429), jsonResponse({}, 408), jsonResponse({ ok: true })]);
      const sleeps: number[] = [];
      const client = new GitHubApiClient(http, { sleep: recordingSleep(sleeps), maxTotalSleepMs: 120_000, jitterMs: 0 });
      await expect(client.getJson('/repos/o/r')).resolves.toEqual({ ok: true });
      expect(http.requests).toHaveLength(3);
      expect(sleeps).toEqual([60_000, 500]);
    });

    it('stops transient retries when the cumulative sleep budget is exhausted', async () => {
      const http = new FakeHttpClient(jsonResponse({}, 503));
      const sleeps: number[] = [];
      const events: GitHubClientEvent[] = [];
      const client = new GitHubApiClient(http, {
        sleep: recordingSleep(sleeps), maxTotalSleepMs: 1000, maxSleepMs: 600,
        backoffBaseMs: 600, jitterMs: 0, onEvent: (event) => events.push(event)
      });
      await expect(client.getJson('/repos/o/r')).rejects.toThrow('503');
      expect(sleeps).toEqual([600]);
      expect(http.requests).toHaveLength(2);
      expect(events.at(-1)?.reason).toBe('cumulative retry wait exceeds budget');
    });

    it('gives up after maxRetries transient failures', async () => {
      const http = new FakeHttpClient(jsonResponse({}, 503));
      const client = new GitHubApiClient(http, { sleep: noSleep, maxRetries: 2 });
      await expect(client.getJson('/repos/o/r')).rejects.toThrow('503');
      expect(http.requests).toHaveLength(3); // initial attempt + 2 retries
    });

    it('issues an explicit GET so the retry layer only ever replays idempotent requests', async () => {
      const http = new FakeHttpClient([jsonResponse({}, 503), jsonResponse({ ok: true })]);
      const client = new GitHubApiClient(http, { sleep: noSleep });
      await client.getJson('/repos/o/r');
      expect(http.requests).toHaveLength(2);
      expect(http.requests.every((request) => request.method === 'GET')).toBe(true);
    });

    it('retries a thrown transport error (e.g. a request timeout) and returns the eventual success', async () => {
      const http = new FakeHttpClient([
        new Error('HTTP request to https://api.github.com/repos/o/r timed out after 20000 ms'),
        jsonResponse({ ok: true })
      ]);
      const client = new GitHubApiClient(http, { sleep: noSleep });
      await expect(client.getJson('/repos/o/r')).resolves.toEqual({ ok: true });
      expect(http.requests).toHaveLength(2);
    });

    it('gives up after maxRetries transport errors and surfaces the original error', async () => {
      const http = new FakeHttpClient(new Error('HTTP request to https://api.github.com/repos/o/r timed out after 20000 ms'));
      const client = new GitHubApiClient(http, { sleep: noSleep, maxRetries: 2 });
      await expect(client.getJson('/repos/o/r')).rejects.toThrow('timed out after 20000 ms');
      expect(http.requests).toHaveLength(3); // initial attempt + 2 retries
    });

    it('stops transport-error retries when the cumulative sleep budget is exhausted', async () => {
      const http = new FakeHttpClient(new Error('socket hang up'));
      const sleeps: number[] = [];
      const events: GitHubClientEvent[] = [];
      const client = new GitHubApiClient(http, {
        sleep: recordingSleep(sleeps), maxTotalSleepMs: 1000, maxSleepMs: 600,
        backoffBaseMs: 600, jitterMs: 0, onEvent: (event) => events.push(event)
      });
      await expect(client.getJson('/repos/o/r')).rejects.toThrow('socket hang up');
      expect(sleeps).toEqual([600]);
      expect(http.requests).toHaveLength(2);
      expect(events.at(-1)?.reason).toBe('cumulative retry wait exceeds budget');
    });

    it('does not retry a fatal 403 (no rate-limit signal)', async () => {
      const http = new FakeHttpClient(jsonResponse({}, 403));
      const client = new GitHubApiClient(http, { sleep: noSleep });
      await expect(client.getJson('/repos/o/r')).rejects.toThrow('Access forbidden');
      expect(http.requests).toHaveLength(1);
    });

    it('caps computed backoff at maxSleepMs', async () => {
      const sleeps: number[] = [];
      const http = new FakeHttpClient([jsonResponse({}, 503), jsonResponse({ ok: true })]);
      const client = new GitHubApiClient(http, {
        sleep: recordingSleep(sleeps),
        backoffBaseMs: 100_000,
        maxSleepMs: 1000
      });
      await client.getJson('/repos/o/r');
      expect(sleeps).toEqual([1000]);
    });
  });

  describe('rate limiting', () => {
    it('allows the exact cumulative budget and resets it for each new request', async () => {
      const limit = jsonResponse({}, 429, { 'retry-after': '30' });
      const success = jsonResponse({ ok: true });
      const http = new FakeHttpClient([limit, limit, success, limit, limit, success]);
      const sleeps: number[] = [];
      const client = new GitHubApiClient(http, { sleep: recordingSleep(sleeps) });
      await expect(client.getJson('/repos/o/r')).resolves.toEqual({ ok: true });
      await expect(client.getJson('/repos/o/r')).resolves.toEqual({ ok: true });
      expect(sleeps).toEqual([30_000, 30_000, 30_000, 30_000]);
    });
    it('bounds cumulative waits for repeated server-directed retries', async () => {
      const http = new FakeHttpClient(jsonResponse({}, 429, { 'retry-after': '60' }));
      const sleeps: number[] = [];
      await expect(new GitHubApiClient(http, { sleep: recordingSleep(sleeps) }).getJson('/repos/o/r')).rejects.toThrow('Retry after 60 seconds');
      expect(sleeps).toEqual([60_000]);
      expect(http.requests).toHaveLength(2);
    });

    it('counts transient waits before a rate limit without truncating Retry-After', async () => {
      const http = new FakeHttpClient([jsonResponse({}, 503), jsonResponse({}, 429, { 'retry-after': '60' })]);
      const sleeps: number[] = [];
      await expect(new GitHubApiClient(http, { sleep: recordingSleep(sleeps), jitterMs: 0 }).getJson('/repos/o/r')).rejects.toThrow('Retry after 60 seconds');
      expect(sleeps).toEqual([250]);
      expect(http.requests).toHaveLength(2);
    });

    it.each(['', '-1', 'invalid', 'Wed, 21 Oct 2015 07:28:00 GMT'])('falls back for invalid or past Retry-After %s', async (value) => {
      const http = new FakeHttpClient([jsonResponse({}, 429, { 'retry-after': value }), jsonResponse({ ok: true })]);
      const sleeps: number[] = [];
      await new GitHubApiClient(http, { sleep: recordingSleep(sleeps) }).getJson('/repos/o/r');
      expect(sleeps).toEqual([60_000]);
    });

    it('honours a future HTTP-date Retry-After', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 29, 12));
      try {
        const http = new FakeHttpClient([jsonResponse({}, 429, { 'retry-after': new Date(Date.now() + 30_000).toUTCString() }), jsonResponse({ ok: true })]);
        const sleeps: number[] = [];
        await new GitHubApiClient(http, { sleep: recordingSleep(sleeps) }).getJson('/repos/o/r');
        expect(sleeps).toEqual([30_000]);
      } finally {
        now.mockRestore();
      }
    });

    it('does not shorten a date-based Retry-After beyond the budget', async () => {
      const http = new FakeHttpClient(jsonResponse({}, 429, { 'retry-after': new Date(Date.now() + 180_000).toUTCString() }));
      const sleeps: number[] = [];
      await expect(new GitHubApiClient(http, { sleep: recordingSleep(sleeps) }).getJson('/repos/o/r')).rejects.toThrow('Retry after');
      expect(http.requests).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });

    it('does not retry before a primary reset beyond the wait budget', async () => {
      const reset = Math.floor(Date.now() / 1000) + 3600;
      const http = new FakeHttpClient(jsonResponse({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }));
      const sleeps: number[] = [];
      await expect(new GitHubApiClient(http, { sleep: recordingSleep(sleeps) }).getJson('/repos/o/r')).rejects.toThrow('Retry after');
      expect(http.requests).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });

    it('honours Retry-After on 429 rather than retrying immediately', async () => {
      const http = new FakeHttpClient([jsonResponse({}, 429, { 'retry-after': '10' }), jsonResponse({ ok: true })]);
      const sleeps: number[] = [];
      await new GitHubApiClient(http, { sleep: recordingSleep(sleeps) }).getJson('/repos/o/r');
      expect(sleeps).toEqual([10_000]);
    });

    it('fails promptly when a required rate-limit wait exceeds the wait budget', async () => {
      const http = new FakeHttpClient(jsonResponse({}, 403, { 'retry-after': '120' }));
      const sleeps: number[] = [];
      await expect(new GitHubApiClient(http, { sleep: recordingSleep(sleeps) }).getJson('/repos/o/r')).rejects.toThrow(/rate limit.*120/i);
      expect(http.requests).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });

    it('waits at least a minute for a secondary limit without Retry-After', async () => {
      const http = new FakeHttpClient([jsonResponse({ message: 'secondary rate limit' }, 403), jsonResponse({ ok: true })]);
      const sleeps: number[] = [];
      await new GitHubApiClient(http, { sleep: recordingSleep(sleeps) }).getJson('/repos/o/r');
      expect(sleeps).toEqual([60_000]);
    });

    it('sleeps until x-ratelimit-reset on a primary rate limit, then retries', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 30;
      const http = new FakeHttpClient([
        jsonResponse({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) }),
        jsonResponse({ ok: true })
      ]);
      const sleeps: number[] = [];
      const client = new GitHubApiClient(http, { sleep: recordingSleep(sleeps) });
      await expect(client.getJson('/repos/o/r')).resolves.toEqual({ ok: true });
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]).toBeGreaterThan(0);
    });

    it('honours Retry-After on a secondary rate limit, then retries', async () => {
      const http = new FakeHttpClient([
        jsonResponse({ message: 'You have exceeded a secondary rate limit' }, 403, { 'retry-after': '2' }),
        jsonResponse({ ok: true })
      ]);
      const sleeps: number[] = [];
      const client = new GitHubApiClient(http, { sleep: recordingSleep(sleeps) });
      await expect(client.getJson('/repos/o/r')).resolves.toEqual({ ok: true });
      expect(sleeps).toEqual([2000]);
    });

    it('records rate-limit telemetry from response headers', async () => {
      const http = new FakeHttpClient(jsonResponse({ ok: true }, 200, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-used': '1',
        'x-ratelimit-reset': '1700000000'
      }));
      const client = new GitHubApiClient(http);
      await client.getJson('/repos/o/r');
      expect(client.lastRateLimit).toEqual({
        limit: 5000,
        remaining: 4999,
        used: 1,
        resetAt: new Date(1_700_000_000 * 1000)
      });
    });
  });

  describe('getJsonWithEtag', () => {
    it('sends If-None-Match when an etag is provided', async () => {
      const http = new FakeHttpClient(jsonResponse({ sha: 'abc' }));
      await new GitHubApiClient(http).getJsonWithEtag('/repos/o/r/commits/main', 'W/"etag-1"');
      expect(http.lastRequest?.headers?.['If-None-Match']).toBe('W/"etag-1"');
    });

    it('returns notModified on a 304 without throwing', async () => {
      const http = new FakeHttpClient({ statusCode: 304, body: new Uint8Array(), finalUrl: '', headers: {} });
      const result = await new GitHubApiClient(http).getJsonWithEtag('/repos/o/r/commits/main', 'W/"etag-1"');
      expect(result).toEqual({ status: 'notModified' });
    });

    it('returns ok with the parsed value and new etag on a fresh response', async () => {
      const http = new FakeHttpClient(jsonResponse({ sha: 'abc' }, 200, { etag: 'W/"etag-2"' }));
      const result = await new GitHubApiClient(http).getJsonWithEtag<{ sha: string }>('/repos/o/r/commits/main');
      expect(result).toEqual({ status: 'ok', value: { sha: 'abc' }, etag: 'W/"etag-2"' });
    });
  });

  describe('observability events', () => {
    it('emits request then success for a single successful call', async () => {
      const http = new FakeHttpClient(jsonResponse({ ok: true }));
      const events: GitHubClientEvent[] = [];
      await new GitHubApiClient(http, { onEvent: (e) => events.push(e) }).getJson('/repos/o/r');
      expect(events.map((e) => e.kind)).toEqual(['request', 'success']);
    });

    it('emits retry between two attempts on a transient failure', async () => {
      const http = new FakeHttpClient([jsonResponse({}, 503), jsonResponse({ ok: true })]);
      const events: GitHubClientEvent[] = [];
      await new GitHubApiClient(http, { sleep: noSleep, onEvent: (e) => events.push(e) }).getJson('/repos/o/r');
      expect(events.map((e) => e.kind)).toEqual(['request', 'retry', 'request', 'success']);
    });
  });
});
