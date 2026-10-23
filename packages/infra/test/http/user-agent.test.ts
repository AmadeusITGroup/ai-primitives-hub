import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  GitHubApiClient,
} from '../../src/http/github-api-client';
import {
  resetDefaultUserAgent,
  setDefaultUserAgent,
} from '../../src/http/user-agent';

class RecordingHttpClient implements HttpClient {
  public requests: HttpRequest[] = [];

  public fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return Promise.resolve({ statusCode: 200, body: new TextEncoder().encode('{}'), finalUrl: request.url, headers: {} });
  }
}

const userAgentSent = async (): Promise<string | undefined> => {
  const http = new RecordingHttpClient();
  await new GitHubApiClient(http).getJson('/repos/o/r');
  return http.requests[0].headers?.['User-Agent'];
};

describe('default User-Agent', () => {
  afterEach(() => {
    resetDefaultUserAgent();
  });

  it('defaults to ai-primitives-hub/0.2.0', async () => {
    expect(await userAgentSent()).toBe('ai-primitives-hub/0.2.0');
  });

  it('uses the value set by setDefaultUserAgent', async () => {
    setDefaultUserAgent('ai-primitives-hub/9.9.9');
    expect(await userAgentSent()).toBe('ai-primitives-hub/9.9.9');
  });

  it('rejects an empty value', () => {
    expect(() => setDefaultUserAgent('')).toThrow();
  });
});
