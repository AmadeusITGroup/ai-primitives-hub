import {
  createHash,
} from 'node:crypto';
import type {
  ArtifactorySourceIndex,
  HttpClient,
  HttpCredentialProvider,
  HttpRequest,
  HttpResponse,
  RegistrySource,
  SourceRequestContext,
} from '@ai-primitives-hub/core';
import {
  RegistryError,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ArtifactoryBundleDownloader,
  ArtifactoryBundleResolver,
  ArtifactoryEnvCredentialProvider,
  ArtifactoryHttpClient,
  ArtifactorySourceAdapter,
  normalizeSourceRoot,
  resolveConfinedObject,
} from '../src';

const archive = new TextEncoder().encode('bundle bytes');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const source: RegistrySource = {
  id: 'study-source',
  name: 'Study source',
  type: 'artifactory',
  url: 'http://127.0.0.1:8081/artifactory/example-repo-local/ai-primitives-study',
  enabled: true,
  priority: 0,
  config: { indexFile: 'index-v1.json', authMode: 'bearer', credentialRef: 'ARTIFACTORY_TOKEN' }
};

const index = (): ArtifactorySourceIndex => ({
  formatVersion: 1,
  source: { id: 'study-source', name: 'Study source', updatedAt: '2026-09-02T00:00:00Z' },
  bundles: [{
    id: 'bundle',
    version: '1.0.0',
    name: 'Bundle',
    description: 'A bundle',
    author: 'Study',
    environments: [],
    tags: [],
    lastUpdated: '2026-09-02T00:00:00Z',
    dependencies: [],
    license: 'Apache-2.0',
    manifest: { path: 'bundles/bundle/1.0.0/deployment-manifest.yml', size: 10, sha256: 'a'.repeat(64), mediaType: 'application/yaml' },
    archive: { path: 'bundles/bundle/1.0.0/bundle.zip', size: archive.byteLength, sha256: sha256(archive), mediaType: 'application/zip' }
  }]
});

class FakeHttpClient implements HttpClient {
  public readonly requests: HttpRequest[] = [];
  public constructor(private readonly responses: HttpResponse[]) {}
  public fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.requests.length - 1, this.responses.length - 1)];
    return Promise.resolve({ ...response, finalUrl: response.finalUrl || request.url });
  }
}

class FakeCredentials implements HttpCredentialProvider {
  public readonly contexts: SourceRequestContext[] = [];
  public headersFor(_url: string, context: SourceRequestContext): Promise<Readonly<Record<string, string>>> {
    this.contexts.push(context);
    return Promise.resolve({ Authorization: 'Bearer test-token' });
  }
}

const makeResponse = (statusCode: number, body: Uint8Array, headers: Record<string, string> = {}): HttpResponse => ({
  statusCode,
  body,
  finalUrl: '',
  headers
});

const httpClientForIndexAndArchive = (): FakeHttpClient => new FakeHttpClient([
  makeResponse(200, new TextEncoder().encode(JSON.stringify(index())), { etag: 'index-1' }),
  makeResponse(200, archive, { 'content-length': String(archive.byteLength) })
]);

describe('Artifactory source URL confinement', () => {
  it('accepts loopback HTTP and rejects non-loopback HTTP', () => {
    expect(normalizeSourceRoot(source.url).protocol).toBe('http:');
    expect(() => normalizeSourceRoot('http://artifactory.example/source')).toThrow(RegistryError);
  });

  it('rejects traversal, encoded paths, and source-root siblings', () => {
    const root = normalizeSourceRoot(source.url);
    expect(resolveConfinedObject(root, 'bundles/a.zip').href)
      .toBe(`${source.url}/bundles/a.zip`);
    expect(() => resolveConfinedObject(root, '../secret')).toThrow();
    expect(() => resolveConfinedObject(root, 'bundles/%2e%2e/secret')).toThrow();
    expect(() => resolveConfinedObject(root, 'https://evil.example/a')).toThrow();
    expect(() => resolveConfinedObject(root, 'https://127.0.0.1:8081/artifactory/other/a')).toThrow();
  });
});

describe('Artifactory credentials', () => {
  it('returns a Bearer header only for the configured source root', async () => {
    const provider = new ArtifactoryEnvCredentialProvider(
      { ARTIFACTORY_TOKEN: 'test-token' },
      'ARTIFACTORY_TOKEN',
      source.url
    );
    const context: SourceRequestContext = {
      sourceId: source.id,
      trustedOrigin: new URL(source.url).origin,
      trustedPathPrefix: new URL(source.url).pathname + '/'
    };
    await expect(provider.headersFor(`${source.url}/index-v1.json`, context))
      .resolves.toEqual({ Authorization: 'Bearer test-token' });
    await expect(provider.headersFor('http://127.0.0.1:8081/artifactory/other/index.json', context))
      .rejects.toThrow(RegistryError);
  });
});

describe('Artifactory HTTP client', () => {
  it('fetches an index with scoped credentials and handles 304', async () => {
    const http = new FakeHttpClient([
      makeResponse(200, new TextEncoder().encode('{}'), { etag: 'index-1' }),
      makeResponse(304, new Uint8Array(), { etag: 'index-1' })
    ]);
    const credentials = new FakeCredentials();
    const client = new ArtifactoryHttpClient(http, credentials, source.url);
    await expect(client.getIndex()).resolves.toMatchObject({ status: 'fresh', etag: 'index-1' });
    await expect(client.getIndex('index-v1.json', 'index-1')).resolves.toMatchObject({ status: 'not-modified' });
    expect(http.requests[0].headers?.Authorization).toBe('Bearer test-token');
    expect(http.requests[1].headers?.['If-None-Match']).toBe('index-1');
  });

  it('retries transient responses and maps auth failures', async () => {
    const sleeps: number[] = [];
    const http = new FakeHttpClient([
      makeResponse(503, new Uint8Array()),
      makeResponse(200, new TextEncoder().encode('{}'))
    ]);
    const client = new ArtifactoryHttpClient(http, new FakeCredentials(), source.url, {
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });
    await expect(client.getIndex()).resolves.toMatchObject({ status: 'fresh' });
    expect(sleeps).toHaveLength(1);

    const denied = new ArtifactoryHttpClient(
      new FakeHttpClient([makeResponse(403, new Uint8Array())]),
      new FakeCredentials(),
      source.url
    );
    await expect(denied.getIndex()).rejects.toMatchObject({ code: 'ARTIFACTORY.ACCESS_DENIED' });
  });
});

describe('Artifactory downloader', () => {
  it('enforces resolver-provided archive integrity', async () => {
    const downloader = new ArtifactoryBundleDownloader({
      getBytesAt: async () => archive
    } as never);
    const installable = {
      ref: { sourceId: source.id, sourceType: 'artifactory', bundleId: 'bundle', bundleVersion: '1.0.0', installed: false },
      downloadUrl: `${source.url}/bundles/bundle/1.0.0/bundle.zip`,
      integrity: `sha256:${sha256(archive)}`
    };
    await expect(downloader.download(installable)).resolves.toMatchObject({ sha256: sha256(archive) });

    const invalid = new ArtifactoryBundleDownloader({
      getBytesAt: async () => new TextEncoder().encode('tampered')
    } as never);
    await expect(invalid.download(installable)).rejects.toMatchObject({ code: 'BUNDLE.ARCHIVE_INTEGRITY_MISMATCH' });
  });
});

describe('Artifactory source adapter and resolver', () => {
  it('maps the static index to Bundle and verifies downloaded bytes', async () => {
    const http = httpClientForIndexAndArchive();
    const adapter = new ArtifactorySourceAdapter(
      source,
      new ArtifactoryHttpClient(http, new FakeCredentials(), source.url)
    );
    const bundles = await adapter.fetchBundles();
    expect(bundles[0]).toMatchObject({ id: 'bundle', version: '1.0.0', sourceId: source.id, size: '12 B' });
    await expect(adapter.downloadBundle(bundles[0])).resolves.toEqual(Buffer.from(archive));
  });

  it('resolves the highest version for latest and returns archive integrity', async () => {
    const data = index();
    data.bundles.push({ ...data.bundles[0], version: '2.0.0' });
    const http = new FakeHttpClient([makeResponse(200, new TextEncoder().encode(JSON.stringify(data)))]);
    const resolver = new ArtifactoryBundleResolver(
      source,
      new ArtifactoryHttpClient(http, new FakeCredentials(), source.url)
    );
    await expect(resolver.resolve({ bundleId: 'bundle' })).resolves.toMatchObject({
      ref: { bundleVersion: '2.0.0', sourceType: 'artifactory' },
      integrity: `sha256:${sha256(archive)}`
    });
  });
});
