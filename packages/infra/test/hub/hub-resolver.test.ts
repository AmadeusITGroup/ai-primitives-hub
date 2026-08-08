/**
 * Tests for infra/hub/hub-resolver.ts.
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HubReference,
  OnLogEvent,
  TokenProvider,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CompositeHubResolver,
  GitHubHubResolver,
  type HubResolver,
  LocalHubResolver,
  UrlHubResolver,
} from '../../src/hub/hub-resolver';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

const VALID_YAML = yaml.dump({
  version: '1.0.0',
  metadata: { name: 'Hub', description: 'd', maintainer: 'm', updatedAt: '2024-01-01T00:00:00.000Z' },
  sources: [],
  profiles: []
});

function fakeHttpClient(responses: (req: HttpRequest) => HttpResponse): HttpClient {
  return { fetch: (req: HttpRequest): Promise<HttpResponse> => Promise.resolve(responses(req)) };
}

function fakeTokenProvider(token: string | undefined = undefined): TokenProvider {
  return { getToken: (): Promise<string | undefined> => Promise.resolve(token) };
}

/**
 * Assert the shared `fetchYamlConfig` anonymous-retry behavior: a rejected
 * credential (which raw.githubusercontent.com reports as a bare 404, even on
 * public content) must not make a public hub look non-existent. Both
 * resolvers go through the same branch, so both are checked the same way.
 * @param build - Builds the resolver under test from the fake HTTP client,
 * the stale-token provider and the log sink.
 * @param ref - Reference to resolve.
 * @param isHubCall - Identifies the hub-config requests among all calls.
 */
async function expectAnonymousFallback(
  build: (http: HttpClient, tokens: TokenProvider, onLog: OnLogEvent) => HubResolver,
  ref: HubReference,
  isHubCall: (req: HttpRequest) => boolean
): Promise<void> {
  const fetchSpy = vi.fn((req: HttpRequest): HttpResponse => (
    req.headers?.Authorization === undefined
      ? { statusCode: 200, body: new TextEncoder().encode(VALID_YAML), finalUrl: req.url, headers: {} }
      : { statusCode: 404, body: new TextEncoder().encode('404: Not Found'), finalUrl: req.url, headers: {} }
  ));
  const http: HttpClient = { fetch: (req): Promise<HttpResponse> => Promise.resolve(fetchSpy(req)) };
  const logged: string[] = [];
  const resolver = build(http, fakeTokenProvider('stale-token'), (event) => {
    logged.push(`${event.level}: ${event.message}`);
  });

  const resolved = await resolver.resolve(ref);

  expect(resolved.config.metadata.name).toBe('Hub');
  // Exactly two attempts at the hub config itself: authenticated, then
  // anonymous.
  const hubCalls = fetchSpy.mock.calls.map((call) => call[0]).filter((req) => isHubCall(req));
  expect(hubCalls).toHaveLength(2);
  expect(hubCalls[0].headers).toHaveProperty('Authorization');
  expect(hubCalls[1].headers).not.toHaveProperty('Authorization');
  expect(logged.some((line) => line.startsWith('warn:') && line.includes('GitHub rejected it'))).toBe(true);
}

describe('LocalHubResolver', () => {
  it('reads and parses the referenced file', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/hubs/my-hub.yml', VALID_YAML);
    const resolver = new LocalHubResolver(fs);

    const ref: HubReference = { type: 'local', location: '/hubs/my-hub.yml' };
    const resolved = await resolver.resolve(ref);

    expect(resolved.config.metadata.name).toBe('Hub');
    expect(resolved.reference).toBe(ref);
  });

  it('throws when the file does not exist', async () => {
    const fs = new InMemoryFileSystem();
    const resolver = new LocalHubResolver(fs);
    await expect(resolver.resolve({ type: 'local', location: '/missing.yml' }))
      .rejects.toThrow('File not found: /missing.yml');
  });

  it('wraps YAML parse errors', async () => {
    const fs = new InMemoryFileSystem();
    fs.seed('/bad.yml', 'not: valid: yaml: [[[');
    const resolver = new LocalHubResolver(fs);
    await expect(resolver.resolve({ type: 'local', location: '/bad.yml' }))
      .rejects.toThrow(/Failed to load hub config from \/bad\.yml/);
  });
});

describe('UrlHubResolver', () => {
  it('fetches and parses a 200 response', async () => {
    const http = fakeHttpClient(() => ({ statusCode: 200, body: new TextEncoder().encode(VALID_YAML), finalUrl: 'https://example.com/hub-config.yml', headers: {} }));
    const resolver = new UrlHubResolver(http, fakeTokenProvider());

    const ref: HubReference = { type: 'url', location: 'https://example.com/hub-config.yml' };
    const resolved = await resolver.resolve(ref);
    expect(resolved.config.metadata.name).toBe('Hub');
  });

  it('attaches a token header when the provider resolves one', async () => {
    const fetchSpy = vi.fn((req: HttpRequest): HttpResponse => ({ statusCode: 200, body: new TextEncoder().encode(VALID_YAML), finalUrl: req.url, headers: {} }));
    const http: HttpClient = { fetch: (req): Promise<HttpResponse> => Promise.resolve(fetchSpy(req)) };
    const resolver = new UrlHubResolver(http, fakeTokenProvider('secret-token'));

    await resolver.resolve({ type: 'url', location: 'https://example.com/hub-config.yml' });

    expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'token secret-token' })
    }));
  });

  it('throws on a non-200 response', async () => {
    const http = fakeHttpClient(() => ({ statusCode: 404, body: new Uint8Array(), finalUrl: '', headers: {} }));
    const resolver = new UrlHubResolver(http, fakeTokenProvider());
    await expect(resolver.resolve({ type: 'url', location: 'https://example.com/hub-config.yml' }))
      .rejects.toThrow('Failed to fetch hub config: HTTP 404');
  });

  it('wraps YAML parse errors', async () => {
    const http = fakeHttpClient(() => ({ statusCode: 200, body: new TextEncoder().encode('not: valid: [[['), finalUrl: '', headers: {} }));
    const resolver = new UrlHubResolver(http, fakeTokenProvider());
    await expect(resolver.resolve({ type: 'url', location: 'https://example.com/hub-config.yml' }))
      .rejects.toThrow(/Failed to parse hub config/);
  });

  it('falls back to an anonymous request when a rejected credential yields 404 on a GitHub-hosted URL', async () => {
    // UrlHubResolver shares fetchYamlConfig's isGitHubHost() branch with
    // GitHubHubResolver, so a `url`-type reference pointing at
    // raw.githubusercontent.com must get the same anonymous-retry treatment.
    const url = 'https://raw.githubusercontent.com/owner/repo/main/hub-config.yml';
    await expectAnonymousFallback(
      (http, tokens, onLog) => new UrlHubResolver(http, tokens, onLog),
      { type: 'url', location: url },
      (req) => req.url === url
    );
  });
});

describe('GitHubHubResolver', () => {
  it('fetches from raw.githubusercontent.com with a cache-busting query param', async () => {
    const fetchSpy = vi.fn((req: HttpRequest): HttpResponse => ({ statusCode: 200, body: new TextEncoder().encode(VALID_YAML), finalUrl: req.url, headers: {} }));
    const http: HttpClient = { fetch: (req): Promise<HttpResponse> => Promise.resolve(fetchSpy(req)) };
    const resolver = new GitHubHubResolver(http, fakeTokenProvider());

    const ref: HubReference = { type: 'github', location: 'owner/repo' };
    const resolved = await resolver.resolve(ref);

    expect(resolved.reference).toBe(ref);
    const calledUrl = fetchSpy.mock.calls[0][0].url;
    expect(calledUrl).toMatch(/^https:\/\/raw\.githubusercontent\.com\/owner\/repo\/main\/hub-config\.yml\?t=\d+$/);
  });

  it('falls back to an anonymous request when a rejected credential yields 404', async () => {
    await expectAnonymousFallback(
      (http, tokens, onLog) => new GitHubHubResolver(http, tokens, onLog),
      { type: 'github', location: 'owner/repo' },
      (req) => req.url.startsWith('https://raw.githubusercontent.com/')
    );
  });

  it('reports the authenticated failure with a credential hint when anonymous access fails too', async () => {
    const http = fakeHttpClient((req) => ({ statusCode: 404, body: new TextEncoder().encode('404: Not Found'), finalUrl: req.url, headers: {} }));
    const resolver = new GitHubHubResolver(http, fakeTokenProvider('stale-token'));

    await expect(resolver.resolve({ type: 'github', location: 'owner/private-repo' }))
      .rejects.toThrow(/HTTP 404 \(note: raw\.githubusercontent\.com answers 404 for a rejected credential/);
  });

  it('does not retry anonymously when no credential was attached', async () => {
    const fetchSpy = vi.fn((req: HttpRequest): HttpResponse => ({ statusCode: 404, body: new Uint8Array(), finalUrl: req.url, headers: {} }));
    const http: HttpClient = { fetch: (req): Promise<HttpResponse> => Promise.resolve(fetchSpy(req)) };
    const resolver = new GitHubHubResolver(http, fakeTokenProvider());

    await expect(resolver.resolve({ type: 'github', location: 'owner/repo' })).rejects.toThrow('HTTP 404');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('logs the account, real scopes and verdict when a private hub 404s', async () => {
    // The whole point of probing api.github.com: raw.githubusercontent.com
    // reports "token rejected" and "no access to this repo" identically, as a
    // bare 404.
    const http = fakeHttpClient((req) => {
      if (req.url.startsWith('https://raw.githubusercontent.com/')) {
        return { statusCode: 404, body: new TextEncoder().encode('404: Not Found'), finalUrl: req.url, headers: {} };
      }
      if (req.url === 'https://api.github.com/user') {
        return {
          statusCode: 200,
          body: new TextEncoder().encode('{"login":"octocat"}'),
          finalUrl: req.url,
          headers: { 'x-oauth-scopes': 'gist, read:org, repo, workflow' }
        };
      }
      // The token is valid but this account cannot see the repo.
      return { statusCode: 404, body: new TextEncoder().encode('{"message":"Not Found"}'), finalUrl: req.url, headers: {} };
    });
    const logged: string[] = [];
    const resolver = new GitHubHubResolver(http, fakeTokenProvider('stale-token'), (event) => {
      logged.push(`${event.level}: ${event.message}`);
    });

    await expect(resolver.resolve({ type: 'github', location: 'acme/private-hub-config' }))
      .rejects.toThrow('HTTP 404');

    const diagnostics = logged.find((line) => line.includes('credential diagnostics'));
    expect(diagnostics).toBeDefined();
    expect(diagnostics).toContain('login=octocat');
    expect(diagnostics).toContain('repoStatus=404');
    expect(diagnostics).toContain('cannot see acme/private-hub-config');
  });

  it('does not probe api.github.com when the fetch succeeds', async () => {
    const fetchSpy = vi.fn((req: HttpRequest): HttpResponse => ({ statusCode: 200, body: new TextEncoder().encode(VALID_YAML), finalUrl: req.url, headers: {} }));
    const http: HttpClient = { fetch: (req): Promise<HttpResponse> => Promise.resolve(fetchSpy(req)) };
    const resolver = new GitHubHubResolver(http, fakeTokenProvider('stale-token'), () => undefined);

    await resolver.resolve({ type: 'github', location: 'owner/repo' });

    const urls = fetchSpy.mock.calls.map((call) => call[0].url);
    expect(urls.every((url) => url.startsWith('https://raw.githubusercontent.com/'))).toBe(true);
  });

  it('does not probe api.github.com when the anonymous retry recovers the config', async () => {
    // The anonymous retry has already produced both a usable config and the
    // actionable "GitHub rejected it" warning, so making the caller wait for
    // two more api.github.com round-trips buys nothing.
    const fetchSpy = vi.fn((req: HttpRequest): HttpResponse => (
      req.headers?.Authorization === undefined
        ? { statusCode: 200, body: new TextEncoder().encode(VALID_YAML), finalUrl: req.url, headers: {} }
        : { statusCode: 404, body: new TextEncoder().encode('404: Not Found'), finalUrl: req.url, headers: {} }
    ));
    const http: HttpClient = { fetch: (req): Promise<HttpResponse> => Promise.resolve(fetchSpy(req)) };
    const resolver = new GitHubHubResolver(http, fakeTokenProvider('stale-token'), () => undefined);

    await resolver.resolve({ type: 'github', location: 'owner/repo' });

    const urls = fetchSpy.mock.calls.map((call) => call[0].url);
    expect(urls.every((url) => url.startsWith('https://raw.githubusercontent.com/'))).toBe(true);
  });

  it('uses the given ref as the branch segment', async () => {
    const fetchSpy = vi.fn((req: HttpRequest): HttpResponse => ({ statusCode: 200, body: new TextEncoder().encode(VALID_YAML), finalUrl: req.url, headers: {} }));
    const http: HttpClient = { fetch: (req): Promise<HttpResponse> => Promise.resolve(fetchSpy(req)) };
    const resolver = new GitHubHubResolver(http, fakeTokenProvider());

    await resolver.resolve({ type: 'github', location: 'owner/repo', ref: 'develop' });

    const calledUrl = fetchSpy.mock.calls[0][0].url;
    expect(calledUrl).toContain('/owner/repo/develop/hub-config.yml');
  });
});

describe('CompositeHubResolver', () => {
  it('dispatches to the resolver matching the reference type', async () => {
    const github = { resolve: vi.fn(() => Promise.resolve({ config: {}, reference: {} })) };
    const local = { resolve: vi.fn(() => Promise.resolve({ config: {}, reference: {} })) };
    const url = { resolve: vi.fn(() => Promise.resolve({ config: {}, reference: {} })) };
    const composite = new CompositeHubResolver(github as any, local as any, url as any);

    await composite.resolve({ type: 'github', location: 'a/b' });
    await composite.resolve({ type: 'local', location: '/a' });
    await composite.resolve({ type: 'url', location: 'https://a' });

    expect(github.resolve).toHaveBeenCalledTimes(1);
    expect(local.resolve).toHaveBeenCalledTimes(1);
    expect(url.resolve).toHaveBeenCalledTimes(1);
  });
});
