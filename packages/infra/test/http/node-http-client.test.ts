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
  NodeHttpClient,
} from '../../src/http/node-http-client';

describe('NodeHttpClient', () => {
  let server: http.Server;
  let baseUrl: string;
  let crossOriginServer: http.Server;
  let crossOriginUrl: string;
  let crossOriginReceivedAuth: string | undefined;

  beforeEach(async () => {
    crossOriginReceivedAuth = undefined;
    crossOriginServer = http.createServer((req, res) => {
      crossOriginReceivedAuth = req.headers.authorization;
      res.writeHead(200);
      res.end('cross-origin-target');
    });
    await new Promise<void>((resolve) => crossOriginServer.listen(0, '127.0.0.1', resolve));
    const crossOriginPort = (crossOriginServer.address() as AddressInfo).port;
    crossOriginUrl = `http://127.0.0.1:${crossOriginPort}/`;

    server = http.createServer((req, res) => {
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
});
