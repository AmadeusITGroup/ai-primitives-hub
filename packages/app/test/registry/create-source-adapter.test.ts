import type {
  Clock,
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HttpClient,
  HttpRequest,
  HttpResponse,
  ProcessResult,
  ProcessRunner,
  RegistrySource,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createSourceAdapter,
  SourceAdapterFactoryDeps,
} from '../../src/registry/create-source-adapter';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

class FixedClock implements Clock {
  public now(): number {
    return 0;
  }

  public nowIso(): string {
    return '1970-01-01T00:00:00.000Z';
  }
}

class NullProcessRunner implements ProcessRunner {
  public async exec(): Promise<ProcessResult> {
    return { stdout: '', stderr: '' };
  }
}

/** Always answers `200 {}`/`200 []`, recording every request's headers so tests can assert on auth. */
class RecordingHttpClient implements HttpClient {
  public readonly requests: HttpRequest[] = [];

  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const body = request.url.includes('/releases') ? '[]' : '{}';
    return {
      statusCode: 200,
      body: new TextEncoder().encode(body),
      finalUrl: request.url,
      headers: {}
    };
  }
}

class StubTokenProvider implements TokenProvider {
  public constructor(private readonly token: string) {}

  public async getToken(): Promise<string | undefined> {
    return this.token;
  }
}

class RecordingTargetTokenProvider implements TokenProvider {
  public readonly targets: (GitHubRepositoryTarget | undefined)[] = [];

  public async getToken(_host: string, target?: GitHubRepositoryTarget): Promise<string | undefined> {
    this.targets.push(target);
    return undefined;
  }
}

class CountingTokenProvider implements TokenProvider {
  public calls = 0;

  public async getToken(): Promise<string | undefined> {
    this.calls += 1;
    return 'fallback-token';
  }
}

class RecordingTokenProvider implements TokenProvider {
  public readonly targets: (GitHubRepositoryTarget | undefined)[] = [];

  public async getToken(_host: string, target?: GitHubRepositoryTarget): Promise<string | undefined> {
    this.targets.push(target);
    return 'category-token';
  }
}

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'test-source',
    name: 'Test Source',
    type: 'local',
    url: '/registry',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

function makeDeps(overrides: Partial<SourceAdapterFactoryDeps> = {}): SourceAdapterFactoryDeps {
  return {
    fs: new InMemoryFileSystem(),
    clock: new FixedClock(),
    httpClient: new RecordingHttpClient(),
    processRunner: new NullProcessRunner(),
    fallbackTokenProviders: [],
    ...overrides
  };
}

describe('createSourceAdapter', () => {
  it.each([
    ['local', '/registry'],
    ['local-apm', '/registry'],
    ['local-awesome-copilot', '/registry'],
    ['local-skills', '/registry'],
    ['github', 'https://github.com/owner/repo'],
    ['skills', 'https://github.com/owner/repo'],
    ['awesome-copilot', 'https://github.com/owner/repo'],
    ['apm', 'https://github.com/owner/repo']
  ] as const)('builds a %s adapter with the matching .type', (type, url) => {
    const adapter = createSourceAdapter(makeSource({ type, url }), makeDeps());
    expect(adapter.type).toBe(type);
  });

  it('throws a descriptive error for an unknown source type', () => {
    expect(() => createSourceAdapter(makeSource({ type: 'nonexistent' as never }), makeDeps())).toThrow(
      'No adapter for source type: nonexistent'
    );
  });

  describe('GitHub-hosted auth wiring', () => {
    it("uses the source's own explicit token over the fallback chain", async () => {
      const httpClient = new RecordingHttpClient();
      const adapter = createSourceAdapter(
        makeSource({ type: 'github', url: 'https://github.com/owner/repo', token: 'explicit-token' }),
        makeDeps({ httpClient, fallbackTokenProviders: [new StubTokenProvider('fallback-token')] })
      );

      await adapter.validate();

      expect(httpClient.requests.length).toBeGreaterThan(0);
      for (const request of httpClient.requests) {
        expect(request.headers?.Authorization).toBe('token explicit-token');
      }
    });

    it('falls back to the caller-supplied chain when the source has no explicit token', async () => {
      const httpClient = new RecordingHttpClient();
      const adapter = createSourceAdapter(
        makeSource({ type: 'github', url: 'https://github.com/owner/repo' }),
        makeDeps({ httpClient, fallbackTokenProviders: [new StubTokenProvider('fallback-token')] })
      );

      await adapter.validate();

      expect(httpClient.requests.length).toBeGreaterThan(0);
      for (const request of httpClient.requests) {
        expect(request.headers?.Authorization).toBe('token fallback-token');
      }
    });

    it('sends no Authorization header when neither an explicit token nor a fallback resolves one', async () => {
      const httpClient = new RecordingHttpClient();
      const adapter = createSourceAdapter(makeSource({ type: 'github', url: 'https://github.com/owner/repo' }), makeDeps({ httpClient }));

      await adapter.validate();

      expect(httpClient.requests.length).toBeGreaterThan(0);
      for (const request of httpClient.requests) {
        expect(request.headers?.Authorization).toBeUndefined();
      }
    });

    it('binds GitHub API calls to the source repository target', async () => {
      const httpClient = new RecordingHttpClient();
      const tokenProvider = new RecordingTargetTokenProvider();
      const adapter = createSourceAdapter(
        makeSource({ type: 'github', url: 'https://github.com/owner/repo' }),
        makeDeps({ httpClient, fallbackTokenProviders: [tokenProvider] })
      );

      await adapter.validate();

      expect(tokenProvider.targets.length).toBeGreaterThan(0);
      expect(tokenProvider.targets.every((target) => target !== undefined)).toBe(true);
      expect(tokenProvider.targets[0]).toEqual({
        host: 'github.com',
        owner: 'owner',
        repository: 'repo'
      });
    });

    it('does not invoke credentials for a public-anonymous source', async () => {
      const httpClient = new RecordingHttpClient();
      const fallback = new CountingTokenProvider();
      const source = makeSource({ type: 'github', url: 'https://github.com/owner/repo' });
      const auth: { category: GitHubSourceAuthCategory; target: GitHubRepositoryTarget } = {
        category: 'public-anonymous',
        target: { host: 'github.com', owner: 'owner', repository: 'repo' }
      };
      const adapter = createSourceAdapter(
        source,
        makeDeps({
          httpClient,
          fallbackTokenProviders: [fallback],
          sourceAuthentication: new Map([[source.id, auth]])
        })
      );

      await adapter.validate();

      expect(fallback.calls).toBe(0);
      expect(httpClient.requests.length).toBeGreaterThan(0);
      for (const request of httpClient.requests) {
        expect(request.headers?.Authorization).toBeUndefined();
      }
    });

    it('uses only the preflight provider for a public-generic source', async () => {
      const httpClient = new RecordingHttpClient();
      const fallback = new CountingTokenProvider();
      const categoryProvider = new RecordingTokenProvider();
      const source = makeSource({ type: 'github', url: 'https://github.com/owner/repo' });
      const adapter = createSourceAdapter(
        source,
        makeDeps({
          httpClient,
          fallbackTokenProviders: [fallback],
          sourceAuthentication: new Map([[
            source.id,
            {
              category: 'public-generic',
              target: { host: 'github.com', owner: 'owner', repository: 'repo' },
              tokenProvider: categoryProvider
            }
          ]])
        })
      );

      await adapter.validate();

      expect(fallback.calls).toBe(0);
      expect(categoryProvider.targets.length).toBeGreaterThan(0);
      expect(httpClient.requests.every((request) => request.headers?.Authorization === 'token category-token')).toBe(true);
    });

    it('rejects an unresolved preflight source before constructing its adapter', () => {
      const source = makeSource({ type: 'github', url: 'https://github.com/owner/repo' });

      expect(() => createSourceAdapter(
        source,
        makeDeps({
          sourceAuthentication: new Map([[
            source.id,
            {
              category: 'unresolved',
              target: { host: 'github.com', owner: 'owner', repository: 'repo' }
            }
          ]])
        })
      )).toThrow('unresolved GitHub authentication');
    });

    it('rejects a preflight target that does not match the configured source', () => {
      const source = makeSource({ type: 'github', url: 'https://github.com/owner/repo' });

      expect(() => createSourceAdapter(
        source,
        makeDeps({
          sourceAuthentication: new Map([[
            source.id,
            {
              category: 'app-authenticated',
              target: { host: 'github.com', owner: 'other-owner', repository: 'repo' },
              tokenProvider: new RecordingTokenProvider()
            }
          ]])
        })
      )).toThrow('does not match the configured source');
    });
  });
});
