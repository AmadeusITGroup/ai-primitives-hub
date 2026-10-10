import {
  createHash,
} from 'node:crypto';
import type {
  HttpClient,
  HttpCredentialProvider,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  ArtifactoryReplicationPublisher,
} from '../src/replicate/artifactory-publisher';

const bytes = new TextEncoder().encode('published object');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const credentials: HttpCredentialProvider = {
  headersFor: async () => ({ Authorization: 'Bearer publisher' })
};

class FakeHttp implements HttpClient {
  public readonly requests: HttpRequest[] = [];
  public constructor(private readonly responses: HttpResponse[]) {}
  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return this.responses[Math.min(this.requests.length - 1, this.responses.length - 1)];
  }
}

const response = (statusCode: number, headers: Record<string, string> = {}): HttpResponse => ({
  statusCode,
  body: new Uint8Array(),
  finalUrl: 'https://art.example/repo/bundles/object',
  headers
});

describe('ArtifactoryReplicationPublisher', () => {
  it.each(['sources/replicated/index-v1.json', 'hub-config.yml'])('conditionally replaces only approved metadata at %s', async (path) => {
    const http = new FakeHttp([response(200, { etag: '"old-version"', 'x-checksum-sha256': 'a'.repeat(64) }), response(201)]);
    const publisher = new ArtifactoryReplicationPublisher(http, credentials, 'https://art.example/repo');
    await expect(publisher.publish(path, bytes, 'application/json', { replaceExisting: true })).resolves.toBe('uploaded');
    expect(http.requests[1]).toMatchObject({ method: 'PUT', followRedirects: false, headers: { 'If-Match': '"old-version"', 'X-Checksum-Sha256': sha256 } });
    const missing = new FakeHttp([response(404), response(201)]);
    await new ArtifactoryReplicationPublisher(missing, credentials, 'https://art.example/repo').publish(path, bytes, 'application/json', { replaceExisting: true });
    expect(missing.requests[1].headers?.['If-None-Match']).toBe('*');
    const matching = new FakeHttp([response(200, { 'x-checksum-sha256': sha256 })]);
    await expect(new ArtifactoryReplicationPublisher(matching, credentials, 'https://art.example/repo')
      .publish(path, bytes, 'application/json', { replaceExisting: true })).resolves.toBe('skipped-existing');
    expect(matching.requests).toHaveLength(1);
  });

  it.each([undefined, 'W/"weak"', 'unquoted'])('refuses unsafe metadata replacement with ETag %s even with the unverified override', async (etag) => {
    const http = new FakeHttp([response(200, etag ? { etag } : {})]);
    const publisher = new ArtifactoryReplicationPublisher(http, credentials, 'https://art.example/repo', true);
    await expect(publisher.publish('hub-config.yml', bytes, 'application/yaml', { replaceExisting: true })).rejects.toThrow(/strong ETag/);
    expect(http.requests).toHaveLength(1);
  });

  it('rejects a replacement option on immutable bundle paths before sending any request', async () => {
    const http = new FakeHttp([response(200)]);
    const publisher = new ArtifactoryReplicationPublisher(http, credentials, 'https://art.example/repo');
    await expect(publisher.publish('bundles/object', bytes, 'application/zip', { replaceExisting: true }))
      .rejects.toThrow(/metadata paths/);
    expect(http.requests).toEqual([]);
  });

  it('fails a concurrent metadata update instead of retrying or claiming success', async () => {
    const http = new FakeHttp([response(200, { etag: '"old"' }), response(412)]);
    const publisher = new ArtifactoryReplicationPublisher(http, credentials, 'https://art.example/repo');
    await expect(publisher.publish('hub-config.yml', bytes, 'application/yaml', { replaceExisting: true }))
      .rejects.toThrow(/412/);
    expect(http.requests).toHaveLength(2);
  });

  it('uploads after a missing HEAD and sends the expected digest/auth headers', async () => {
    const http = new FakeHttp([response(404), response(201)]);
    const publisher = new ArtifactoryReplicationPublisher(http, credentials, 'https://art.example/repo');

    await expect(publisher.publish('bundles/object', bytes, 'application/zip')).resolves.toBe('uploaded');
    expect(http.requests.map((request) => request.method)).toEqual(['HEAD', 'PUT']);
    expect(http.requests[1].headers).toMatchObject({
      Authorization: 'Bearer publisher',
      'X-Checksum-Sha256': sha256,
      'Content-Type': 'application/zip'
    });
  });

  it('skips an existing object when its remote digest matches', async () => {
    const http = new FakeHttp([response(200, { 'x-checksum-sha256': sha256 })]);
    const publisher = new ArtifactoryReplicationPublisher(http, credentials, 'https://art.example/repo');

    await expect(publisher.publish('bundles/object', bytes, 'application/zip')).resolves.toBe('skipped-existing');
    expect(http.requests).toHaveLength(1);
  });

  it('fails closed for an existing object without a verifiable digest', async () => {
    const http = new FakeHttp([response(200)]);
    const publisher = new ArtifactoryReplicationPublisher(http, credentials, 'https://art.example/repo');

    await expect(publisher.publish('bundles/object', bytes, 'application/zip'))
      .rejects.toThrow(/cannot be verified|conflicts/i);
    expect(http.requests).toHaveLength(1);
  });
});
