/**
 * Tests for infra/hub/hub-resolver.ts.
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HubReference,
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
