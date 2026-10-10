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
