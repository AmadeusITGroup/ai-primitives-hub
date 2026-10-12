/**
 * Exercises NodeHttpClient against a real local HTTP server rather than
 * mocking `node:http`/`node:https` - proves the actual redirect-following
 * and response-collection logic, not just that the right mock was called.
 */
import * as http from 'node:http';
import type {
  AddressInfo,
} from 'node:net';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ArtifactoryEnvCredentialProvider,
} from '../../src/artifactory/credentials';
import {
  ArtifactoryHttpClient,
} from '../../src/artifactory/http-client';
import {
  NodeHttpClient,
} from '../../src/http/node-http-client';
import {
  ArtifactoryReplicationPublisher,
} from '../../src/replicate/artifactory-publisher';

describe('NodeHttpClient', () => {
  let server: http.Server;
  let baseUrl: string;
  let crossOriginServer: http.Server;
  let crossOriginUrl: string;
  let crossOriginReceivedAuth: string | undefined;
  let crossOriginRequests: number;
  let requests: { path: string; authorization?: string }[];
  let redirects: Map<string, { statusCode: number; location: string }>;

  const makeArtifactoryClient = (): ArtifactoryHttpClient => {
    const root = `${baseUrl}/artifactory/repo`;
    return new ArtifactoryHttpClient(
      new NodeHttpClient(),
      new ArtifactoryEnvCredentialProvider({ TOKEN: 'test-token' }, 'TOKEN', root),
      root,
      { sleep: () => Promise.resolve() }
    );
  };

  beforeEach(async () => {
    crossOriginReceivedAuth = undefined;
    crossOriginRequests = 0;
    requests = [];
    redirects = new Map();
    crossOriginServer = http.createServer((req, res) => {
      crossOriginRequests += 1;
      crossOriginReceivedAuth = req.headers.authorization;
      res.writeHead(200);
      res.end('cross-origin-target');
    });
    await new Promise<void>((resolve) => crossOriginServer.listen(0, '127.0.0.1', resolve));
    const crossOriginPort = (crossOriginServer.address() as AddressInfo).port;
    crossOriginUrl = `http://127.0.0.1:${crossOriginPort}/`;

    server = http.createServer((req, res) => {
      const requestPath = req.url ?? '/';
      requests.push({ path: requestPath, authorization: req.headers.authorization });
      const redirect = redirects.get(`${req.method} ${requestPath}`) ?? redirects.get(requestPath);
      if (redirect) {
        res.writeHead(redirect.statusCode, { Location: redirect.location });
        res.end();
        return;
      }
      if (requestPath.startsWith('/artifactory/repo/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/redirect-once') {
        res.writeHead(302, { Location: '/target' });
        res.end();
        return;
      }
      if (req.url === '/redirect-loop') {
        res.writeHead(302, { Location: '/redirect-loop' });
        res.end();
        return;
      }
      if (req.url === '/target') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/echo-header') {
        res.writeHead(200, { 'x-echo': req.headers.authorization ?? '' });
        res.end();
        return;
      }
      if (req.url === '/redirect-cross-origin') {
        res.writeHead(302, { Location: crossOriginUrl });
        res.end();
        return;
      }
      if (req.url === '/redirect-same-origin') {
        res.writeHead(302, { Location: '/echo-header' });
        res.end();
        return;
      }
      if (req.url === '/not-found') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nope');
        return;
      }
      res.writeHead(200);
      res.end('root');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      crossOriginServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('fetches a simple 200 response with body and headers intact', async () => {
    const response = await new NodeHttpClient().fetch({ url: `${baseUrl}/target` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(Buffer.from(response.body).toString('utf8'))).toEqual({ ok: true });
    expect(response.headers['content-type']).toBe('application/json');
  });

  it('follows a redirect and reports the final URL', async () => {
    const response = await new NodeHttpClient().fetch({ url: `${baseUrl}/redirect-once` });
    expect(response.statusCode).toBe(200);
    expect(response.finalUrl).toBe(`${baseUrl}/target`);
  });

  it('returns the raw redirect response without contacting the destination when following is disabled', async () => {
    const response = await new NodeHttpClient().fetch({
      url: `${baseUrl}/redirect-cross-origin`,
      headers: { Authorization: 'token manual-redirect' },
      followRedirects: false
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(crossOriginUrl);
    expect(response.finalUrl).toBe(`${baseUrl}/redirect-cross-origin`);
    expect(crossOriginRequests).toBe(0);
  });

  it('throws once the redirect budget is exhausted', async () => {
    await expect(new NodeHttpClient().fetch({ url: `${baseUrl}/redirect-loop`, maxRedirects: 2 })).rejects.toThrow(
      'Maximum redirect count exceeded'
    );
  });

  it('sends request headers through to the server', async () => {
    const response = await new NodeHttpClient().fetch({
      url: `${baseUrl}/echo-header`,
      headers: { Authorization: 'token abc123' }
    });
    expect(response.headers['x-echo']).toBe('token abc123');
  });

  it('surfaces a non-2xx status code on the response rather than throwing', async () => {
    const response = await new NodeHttpClient().fetch({ url: `${baseUrl}/not-found` });
    expect(response.statusCode).toBe(404);
    expect(Buffer.from(response.body).toString('utf8')).toBe('nope');
  });

  it('rejects when the server is unreachable', async () => {
    await expect(new NodeHttpClient().fetch({ url: 'http://127.0.0.1:1' })).rejects.toThrow('failed');
  });

  it('strips Authorization before following a cross-origin redirect', async () => {
    const response = await new NodeHttpClient().fetch({
      url: `${baseUrl}/redirect-cross-origin`,
      headers: { Authorization: 'token super-secret' }
    });
    expect(response.statusCode).toBe(200);
    expect(crossOriginReceivedAuth).toBeUndefined();
  });

  it('keeps Authorization across a same-origin redirect', async () => {
    const response = await new NodeHttpClient().fetch({
      url: `${baseUrl}/redirect-same-origin`,
      headers: { Authorization: 'token same-origin' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-echo']).toBe('token same-origin');
  });

  describe('Artifactory redirect confinement', () => {
    const indexPath = '/artifactory/repo/index-v1.json';

    it.each([301, 302, 303, 307, 308])('rejects an outside-root %i redirect before sending the token there', async (statusCode) => {
      redirects.set(indexPath, { statusCode, location: '/artifactory/other/index.json' });

      await expect(makeArtifactoryClient().getIndex()).rejects.toMatchObject({ code: 'ARTIFACTORY.PATH_ESCAPE' });
      expect(requests).toEqual([{ path: indexPath, authorization: 'Bearer test-token' }]);
    });

    it.each([
      '/artifactory/repo-evil/index.json',
      '/artifactory/repo/%2e%2e%2Fother/index.json',
      '/artifactory/repo/%2E%2E%5cother/index.json',
      '/artifactory/repo/%252e%252e%252fother/index.json'
    ])('rejects an ambiguous or sibling redirect to %s before requesting it', async (location) => {
      redirects.set(indexPath, { statusCode: 302, location });

      await expect(makeArtifactoryClient().getIndex()).rejects.toMatchObject({ code: 'ARTIFACTORY.PATH_ESCAPE' });
      expect(requests).toEqual([{ path: indexPath, authorization: 'Bearer test-token' }]);
    });

    it('rejects a cross-origin redirect without contacting the other server', async () => {
      redirects.set(indexPath, { statusCode: 302, location: crossOriginUrl });

      await expect(makeArtifactoryClient().getIndex()).rejects.toMatchObject({ code: 'ARTIFACTORY.PATH_ESCAPE' });
      expect(requests).toEqual([{ path: indexPath, authorization: 'Bearer test-token' }]);
      expect(crossOriginRequests).toBe(0);
      expect(crossOriginReceivedAuth).toBeUndefined();
    });

    it('follows relative and absolute redirects inside the source root with scoped credentials', async () => {
      redirects.set(indexPath, { statusCode: 301, location: 'next.json' });
      redirects.set('/artifactory/repo/next.json', { statusCode: 308, location: `${baseUrl}/artifactory/repo/final.json` });

      await expect(makeArtifactoryClient().getIndex()).resolves.toMatchObject({
        status: 'fresh',
        value: { ok: true },
        finalUrl: `${baseUrl}/artifactory/repo/final.json`
      });
      expect(requests).toEqual([
        { path: indexPath, authorization: 'Bearer test-token' },
        { path: '/artifactory/repo/next.json', authorization: 'Bearer test-token' },
        { path: '/artifactory/repo/final.json', authorization: 'Bearer test-token' }
      ]);
    });

    it('checks every archive redirect hop before leaving the root', async () => {
      const archivePath = '/artifactory/repo/archive.zip';
      redirects.set(archivePath, { statusCode: 302, location: 'moved.zip' });
      redirects.set('/artifactory/repo/moved.zip', { statusCode: 307, location: '/artifactory/other/archive.zip' });

      await expect(makeArtifactoryClient().getBytesAt(`${baseUrl}${archivePath}`))
        .rejects.toMatchObject({ code: 'ARTIFACTORY.PATH_ESCAPE' });
      expect(requests).toEqual([
        { path: archivePath, authorization: 'Bearer test-token' },
        { path: '/artifactory/repo/moved.zip', authorization: 'Bearer test-token' }
      ]);
    });

    it('rejects an invalid redirect URL without retrying the request', async () => {
      redirects.set(indexPath, { statusCode: 302, location: 'http://[' });

      await expect(makeArtifactoryClient().getIndex()).rejects.toMatchObject({ code: 'ARTIFACTORY.PATH_ESCAPE' });
      expect(requests).toEqual([{ path: indexPath, authorization: 'Bearer test-token' }]);
    });

    it('rejects publication HEAD redirects before sending credentials outside the root', async () => {
      const root = `${baseUrl}/artifactory/repo`;
      const archivePath = '/artifactory/repo/archive.zip';
      redirects.set(archivePath, { statusCode: 302, location: '/artifactory/other/archive.zip' });
      const publisher = new ArtifactoryReplicationPublisher(
        new NodeHttpClient(),
        new ArtifactoryEnvCredentialProvider({ TOKEN: 'test-token' }, 'TOKEN', root),
        root
      );

      await expect(publisher.publish('archive.zip', new Uint8Array([1]), 'application/zip')).rejects.toThrow();
      expect(requests).toEqual([{ path: archivePath, authorization: 'Bearer test-token' }]);
    });

    it('rejects publication PUT redirects before forwarding credentials or the archive', async () => {
      const root = `${baseUrl}/artifactory/repo`;
      const archivePath = '/artifactory/repo/archive.zip';
      redirects.set(`HEAD ${archivePath}`, { statusCode: 404, location: '' });
      redirects.set(`PUT ${archivePath}`, { statusCode: 307, location: '/artifactory/other/archive.zip' });
      const publisher = new ArtifactoryReplicationPublisher(
        new NodeHttpClient(),
        new ArtifactoryEnvCredentialProvider({ TOKEN: 'test-token' }, 'TOKEN', root),
        root
      );

      await expect(publisher.publish('archive.zip', new Uint8Array([1]), 'application/zip')).rejects.toThrow();
      expect(requests).toEqual([
        { path: archivePath, authorization: 'Bearer test-token' },
        { path: archivePath, authorization: 'Bearer test-token' }
      ]);
    });

    it('bounds redirect loops without treating them as transient failures', async () => {
      redirects.set(indexPath, { statusCode: 302, location: 'index-v1.json' });

      await expect(makeArtifactoryClient().getIndex()).rejects.toMatchObject({ code: 'ARTIFACTORY.REQUEST_FAILED' });
      expect(requests).toHaveLength(11);
      expect(requests.every((request) => request.path === indexPath)).toBe(true);
    });
  });
});
