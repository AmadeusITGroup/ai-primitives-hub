import type {
  Clock,
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
  });
});
