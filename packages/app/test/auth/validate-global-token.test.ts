/**
 * Tests for app/auth/validate-global-token.ts.
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateGlobalToken,
} from '../../src/auth/validate-global-token';

function respond(partial: Partial<HttpResponse> & { statusCode: number }, url = ''): HttpResponse {
  return {
    body: new TextEncoder().encode(''),
    finalUrl: url,
    headers: {},
    ...partial
  };
}

function httpFor(routes: (req: HttpRequest) => HttpResponse): HttpClient {
  return { fetch: (req): Promise<HttpResponse> => Promise.resolve(routes(req)) };
}

// gho_ prefix + 36 chars = 40 total.
const VALID_TOKEN = 'gho_' + 'a'.repeat(36);

describe('validateGlobalToken', () => {
  it('reports rejected: true and logs a warning when GitHub answers 401 on /user', async () => {
    const http = httpFor((req) => respond({ statusCode: 401, body: new TextEncoder().encode('{"message":"Bad credentials"}') }, req.url));
    const logged: { level: string; message: string }[] = [];

    const result = await validateGlobalToken(http, VALID_TOKEN, (event) => logged.push(event));

    expect(result.rejected).toBe(true);
    expect(result.report.userStatus).toBe(401);
    expect(logged.some((e) => e.level === 'warn' && e.message.includes('rejected'))).toBe(true);
  });

  it('reports rejected: false and logs a debug line when the credential is valid', async () => {
    const http = httpFor((req) => (
      req.url.includes('/user')
        ? respond({ statusCode: 200, body: new TextEncoder().encode('{"login":"octocat"}'), headers: { 'x-oauth-scopes': 'repo' } }, req.url)
        : respond({ statusCode: 200 }, req.url)
    ));
    const logged: { level: string; message: string }[] = [];

    const result = await validateGlobalToken(http, VALID_TOKEN, (event) => logged.push(event));

    expect(result.rejected).toBe(false);
    expect(result.report.userStatus).toBe(200);
    expect(logged.some((e) => e.level === 'debug' && e.message.includes('validated'))).toBe(true);
  });

  it('never includes the token value in logged messages', async () => {
    const http = httpFor((req) => respond({ statusCode: 401 }, req.url));
    const logged: { level: string; message: string }[] = [];

    await validateGlobalToken(http, VALID_TOKEN, (event) => logged.push(event));

    expect(logged.every((e) => !e.message.includes(VALID_TOKEN))).toBe(true);
  });

  it('works without an onLog callback', async () => {
    const http = httpFor((req) => respond({ statusCode: 401 }, req.url));

    const result = await validateGlobalToken(http, VALID_TOKEN);

    expect(result.rejected).toBe(true);
  });
});
