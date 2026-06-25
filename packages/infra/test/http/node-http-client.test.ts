/**
 * Coverage tests for infra/http/node-http-client.ts.
 *
 * Tests NodeHttpClient class.
 */
import type {
  HttpRequest,
} from '@prompt-registry/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  NodeHttpClient,
} from '../../src/http/node-http-client';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('NodeHttpClient', () => {
  let client: NodeHttpClient;

  beforeEach(() => {
    client = new NodeHttpClient();
    mockFetch.mockClear();
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  it('implements HttpClient interface', () => {
    expect(client).toBeDefined();
    expect(typeof client.fetch).toBe('function');
  });

  it('makes GET request with default method', async () => {
    const req: HttpRequest = {
      url: 'https://example.com',
      headers: {}
    };

    mockFetch.mockResolvedValue({
      status: 200,
      url: 'https://example.com',
      headers: new Map([['content-type', 'application/json']]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
    });

    const response = await client.fetch(req);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestArg] = mockFetch.mock.calls[0] as [Request];
    expect(new URL(requestArg.url).toString()).toBe('https://example.com/');
    expect(requestArg.method).toBe('GET');
    expect(Object.fromEntries(requestArg.headers)).toEqual({});
    expect(response.statusCode).toBe(200);
  });

  it('makes HEAD request with specified method', async () => {
    const req: HttpRequest = {
      url: 'https://example.com',
      method: 'HEAD',
      headers: { 'Content-Type': 'application/json' }
    };

    mockFetch.mockResolvedValue({
      status: 200,
      url: 'https://example.com',
      headers: new Map([['content-type', 'application/json']]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
    });

    const response = await client.fetch(req);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestArg] = mockFetch.mock.calls[0] as [Request];
    expect(new URL(requestArg.url).toString()).toBe('https://example.com/');
    expect(requestArg.method).toBe('HEAD');
    expect(Object.fromEntries(requestArg.headers)).toEqual({ 'content-type': 'application/json' });
    expect(response.statusCode).toBe(200);
  });

  it('converts response headers to Record', async () => {
    const req: HttpRequest = {
      url: 'https://example.com',
      headers: {}
    };

    const headers = new Map([
      ['content-type', 'application/json'],
      ['content-length', '123']
    ]);

    mockFetch.mockResolvedValue({
      status: 200,
      url: 'https://example.com',
      headers,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
    });

    const response = await client.fetch(req);
    expect(response.headers).toEqual({
      'content-type': 'application/json',
      'content-length': '123'
    });
  });

  it('converts response body to Uint8Array', async () => {
    const req: HttpRequest = {
      url: 'https://example.com',
      headers: {}
    };

    const bodyData = new TextEncoder().encode('test body');
    mockFetch.mockResolvedValue({
      status: 200,
      url: 'https://example.com',
      headers: new Map([['content-type', 'text/plain']]),
      arrayBuffer: () => Promise.resolve(bodyData.buffer)
    });

    const response = await client.fetch(req);
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(response.body)).toBe('test body');
  });

  it('includes finalUrl in response', async () => {
    const req: HttpRequest = {
      url: 'https://example.com',
      headers: {}
    };

    mockFetch.mockResolvedValue({
      status: 200,
      url: 'https://example.com/redirected',
      headers: new Map([['content-type', 'application/json']]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
    });

    const response = await client.fetch(req);
    expect(response.finalUrl).toBe('https://example.com/redirected');
  });

  it('handles empty response body', async () => {
    const req: HttpRequest = {
      url: 'https://example.com',
      headers: {}
    };

    mockFetch.mockResolvedValue({
      status: 204,
      url: 'https://example.com',
      headers: new Map(),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
    });

    const response = await client.fetch(req);
    expect(response.body).toBeInstanceOf(Uint8Array);
    expect(response.body.length).toBe(0);
  });
});
