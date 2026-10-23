/**
 * Process-wide default User-Agent (FR3.2, FR3.3): the CLI sets it from its
 * released version; callers that set nothing keep `ai-primitives-hub/1.0`.
 */
import * as http from 'node:http';
import type {
  AddressInfo,
} from 'node:net';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  GitHubApiClient,
} from '../../src/http/github-api-client';
import {
  NodeHttpClient,
} from '../../src/http/node-http-client';
import {
  DEFAULT_USER_AGENT,
  getDefaultUserAgent,
  resetDefaultUserAgent,
  setDefaultUserAgent,
} from '../../src/http/user-agent';

const CONFIGURED_USER_AGENT = 'ai-primitives-hub/0.2.0-test';

/** Records each request and answers with an empty JSON object. */
class RecordingHttpClient implements HttpClient {
  public requests: HttpRequest[] = [];

  public fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return Promise.resolve({
      statusCode: 200,
      body: new TextEncoder().encode('{}'),
      finalUrl: request.url,
      headers: {}
    });
  }
}

afterEach(() => {
  resetDefaultUserAgent();
});

describe('default User-Agent', () => {
  it('starts at ai-primitives-hub/1.0 when nothing set it', () => {
    expect(DEFAULT_USER_AGENT).toBe('ai-primitives-hub/1.0');
    expect(getDefaultUserAgent()).toBe(DEFAULT_USER_AGENT);
  });

  it.each(['', '   '])('rejects an empty or whitespace-only value: %j', (value) => {
    expect(() => setDefaultUserAgent(value)).toThrow('Default User-Agent must be a non-empty string');
    expect(getDefaultUserAgent()).toBe(DEFAULT_USER_AGENT);
  });
});

describe('NodeHttpClient User-Agent', () => {
  let server: http.Server;
  let baseUrl: string;
  let receivedUserAgents: (string | undefined)[];

  beforeAll(async () => {
    receivedUserAgents = [];
    server = http.createServer((req, res) => {
      receivedUserAgents.push(req.headers['user-agent']);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends the configured default User-Agent', async () => {
    const client = new NodeHttpClient();
    setDefaultUserAgent(CONFIGURED_USER_AGENT);

    const response = await client.fetch({ url: `${baseUrl}/ua` });

    expect(response.statusCode).toBe(200);
    expect(receivedUserAgents.at(-1)).toBe(CONFIGURED_USER_AGENT);
  });

  it('keeps a User-Agent the request already sets', async () => {
    setDefaultUserAgent(CONFIGURED_USER_AGENT);

    await new NodeHttpClient().fetch({ url: `${baseUrl}/ua`, headers: { 'User-Agent': 'explicit/9.9' } });

    expect(receivedUserAgents.at(-1)).toBe('explicit/9.9');
  });
});

describe('GitHubApiClient User-Agent', () => {
  it('uses the configured default User-Agent', async () => {
    const recorder = new RecordingHttpClient();
    const client = new GitHubApiClient(recorder);
    setDefaultUserAgent(CONFIGURED_USER_AGENT);

    await client.getJson('/repos/o/r');

    expect(recorder.requests[0].headers?.['User-Agent']).toBe(CONFIGURED_USER_AGENT);
  });

  it('lets an explicit options.userAgent win over the configured default', async () => {
    const recorder = new RecordingHttpClient();
    setDefaultUserAgent(CONFIGURED_USER_AGENT);

    await new GitHubApiClient(recorder, { userAgent: 'custom/1.2.3' }).getJson('/repos/o/r');

    expect(recorder.requests[0].headers?.['User-Agent']).toBe('custom/1.2.3');
  });

  it('falls back to ai-primitives-hub/1.0 when nothing is set', async () => {
    const recorder = new RecordingHttpClient();

    await new GitHubApiClient(recorder).getJson('/repos/o/r');

    expect(recorder.requests[0].headers?.['User-Agent']).toBe('ai-primitives-hub/1.0');
  });
});
