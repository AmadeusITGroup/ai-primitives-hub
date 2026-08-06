/**
 * Tests for infra/hub/hub-resolver.ts.
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HubReference,
  LogEvent,
  RegistryError,
  ResolvedToken,
  TokenOrigin,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isRegistryError,
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

const EXPLICIT_ORIGIN: TokenOrigin = { kind: 'explicit' };

function fakeTokenProvider(token?: string, origin: TokenOrigin = EXPLICIT_ORIGIN): TokenProvider {
  return {
    getToken: (): Promise<ResolvedToken | undefined> =>
      Promise.resolve(token === undefined ? undefined : { token, origin })
  };
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

  it('uses the given ref as the branch segment', async () => {
    const fetchSpy = vi.fn((req: HttpRequest): HttpResponse => ({ statusCode: 200, body: new TextEncoder().encode(VALID_YAML), finalUrl: req.url, headers: {} }));
    const http: HttpClient = { fetch: (req): Promise<HttpResponse> => Promise.resolve(fetchSpy(req)) };
    const resolver = new GitHubHubResolver(http, fakeTokenProvider());

    await resolver.resolve({ type: 'github', location: 'owner/repo', ref: 'develop' });

    const calledUrl = fetchSpy.mock.calls[0][0].url;
    expect(calledUrl).toContain('/owner/repo/develop/hub-config.yml');
  });
});

describe('GitHubHubResolver credential failures', () => {
  const HUB_CONFIG_URL = /raw\.githubusercontent\.com/;
  const STALE_TOKEN = 'gho_stale_token_0000000000000000009c1e';

  /**
   * A stale credential on `raw.githubusercontent.com` looks exactly like a
   * missing file: 404, no auth headers. `api.github.com` is honest about
   * it, so these fakes answer the hub-config fetch with 404 while the
   * diagnosis probes report the real state of the credential.
   * @param probes - Status/headers/body per api.github.com path.
   * @param probes.userStatus
   * @param probes.userBody
   * @param probes.userHeaders
   * @param probes.repoStatus
   * @param probes.repoHeaders
   */
  const githubFake = (probes: {
    userStatus: number;
    userBody?: unknown;
    userHeaders?: Record<string, string>;
    repoStatus?: number;
    repoHeaders?: Record<string, string>;
  }): { http: HttpClient; requests: HttpRequest[] } => {
    const requests: HttpRequest[] = [];
    const http: HttpClient = {
      fetch: (req): Promise<HttpResponse> => {
        requests.push(req);
        const respond = (statusCode: number, headers: Record<string, string> = {}, body: unknown = {}): HttpResponse => ({
          statusCode,
          body: new TextEncoder().encode(JSON.stringify(body)),
          finalUrl: req.url,
          headers
        });
        if (req.url.startsWith('https://api.github.com/user')) {
          return Promise.resolve(respond(probes.userStatus, probes.userHeaders ?? {}, probes.userBody ?? {}));
        }
        if (req.url.startsWith('https://api.github.com/repos/')) {
          return Promise.resolve(respond(probes.repoStatus ?? 404, probes.repoHeaders ?? {}));
        }
        return Promise.resolve({ statusCode: 404, body: new Uint8Array(), finalUrl: req.url, headers: {} });
      }
    };
    return { http, requests };
  };

  it('rejects instead of silently serving public content anonymously', async () => {
    const { http, requests } = githubFake({ userStatus: 401 });
    const logs: LogEvent[] = [];
    const resolver = new GitHubHubResolver(
      http,
      fakeTokenProvider(STALE_TOKEN, { kind: 'vscode-session', detail: 'octocat' }),
      (event) => logs.push(event)
    );

    const error = await resolver.resolve({ type: 'github', location: 'owner/public-repo' }).catch((e: unknown) => e);

    expect(isRegistryError(error)).toBe(true);
    expect((error as RegistryError).code).toBe('AUTH.TOKEN_REJECTED');

    // Exactly one hub-config fetch: no anonymous retry.
    expect(requests.filter((req) => HUB_CONFIG_URL.test(req.url))).toHaveLength(1);
    expect(requests[0].headers?.Authorization).toBe(`token ${STALE_TOKEN}`);

    const warning = logs.find((event) => event.level === 'warn');
    expect(warning?.message).toContain('origin=vscode-session(octocat)');
    expect(warning?.message).toContain('token=***<len=38,tail=9c1e>');
    expect(warning?.message).toContain('GitHub rejected the credential itself');
    expect(warning?.message).not.toContain(STALE_TOKEN);
  });

  it('reports a missing repo scope rather than blaming the hub URL', async () => {
    const { http } = githubFake({
      userStatus: 200,
      userBody: { login: 'octocat' },
      userHeaders: { 'x-oauth-scopes': 'read:user' }
    });
    const resolver = new GitHubHubResolver(http, fakeTokenProvider(STALE_TOKEN));

    const error = await resolver.resolve({ type: 'github', location: 'owner/private-repo' }).catch((e: unknown) => e);

    expect((error as RegistryError).code).toBe('AUTH.MISSING_SCOPE');
    expect((error as RegistryError).context?.repoLocation).toBe('owner/private-repo');
  });

  it('reports an SSO authorization challenge', async () => {
    const { http } = githubFake({
      userStatus: 200,
      userBody: { login: 'octocat' },
      userHeaders: { 'x-oauth-scopes': 'repo' },
      repoHeaders: { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' }
    });
    const resolver = new GitHubHubResolver(http, fakeTokenProvider(STALE_TOKEN));

    const error = await resolver.resolve({ type: 'github', location: 'acme/hub' }).catch((e: unknown) => e);

    expect((error as RegistryError).code).toBe('AUTH.SSO_REQUIRED');
  });

  it('reports "this account has no access" for a valid credential that cannot see the repo', async () => {
    const { http } = githubFake({
      userStatus: 200,
      userBody: { login: 'octocat' },
      userHeaders: { 'x-oauth-scopes': 'repo' },
      repoStatus: 404
    });
    const resolver = new GitHubHubResolver(http, fakeTokenProvider(STALE_TOKEN));

    const error = await resolver.resolve({ type: 'github', location: 'amadeus/private-hub' }).catch((e: unknown) => e);

    expect((error as RegistryError).code).toBe('AUTH.NO_REPO_ACCESS');
    expect((error as RegistryError).hint).toContain('cannot see amadeus/private-hub');
  });

  it('classifies an anonymous failure as a fetch failure, not an auth problem', async () => {
    const { http, requests } = githubFake({ userStatus: 200 });
    const logs: LogEvent[] = [];
    const resolver = new GitHubHubResolver(http, fakeTokenProvider(), (event) => logs.push(event));

    const error = await resolver.resolve({ type: 'github', location: 'owner/repo' }).catch((e: unknown) => e);

    expect((error as RegistryError).code).toBe('HUB.FETCH_FAILED');
    expect(logs.find((event) => event.level === 'warn')?.message).toContain('origin=anonymous');
    // No credential to diagnose, so no api.github.com probe should happen.
    expect(requests.filter((req) => req.url.startsWith('https://api.github.com'))).toHaveLength(0);
  });

  it('treats an unreachable api.github.com as a network problem', async () => {
    const requests: HttpRequest[] = [];
    const http: HttpClient = {
      fetch: (req): Promise<HttpResponse> => {
        requests.push(req);
        if (req.url.startsWith('https://api.github.com')) {
          return Promise.reject(new Error('ETIMEDOUT'));
        }
        return Promise.resolve({ statusCode: 404, body: new Uint8Array(), finalUrl: req.url, headers: {} });
      }
    };
    const resolver = new GitHubHubResolver(http, fakeTokenProvider(STALE_TOKEN));

    const error = await resolver.resolve({ type: 'github', location: 'owner/repo' }).catch((e: unknown) => e);

    expect((error as RegistryError).code).toBe('HUB.FETCH_FAILED');
    expect((error as RegistryError).hint).toContain('network/proxy problem');
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
