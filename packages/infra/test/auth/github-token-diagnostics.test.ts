/**
 * Tests for infra/auth/github-token-diagnostics.ts.
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
  diagnoseGitHubToken,
  formatGitHubTokenReport,
} from '../../src/auth/github-token-diagnostics';

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

// gho_ prefix + 36 chars = 40 total, matching the expected redacted descriptor below
const VALID_TOKEN = 'gho_' + 'a'.repeat(36);
const REDACTED_TOKEN = '***<len=40,tail=aaaa>';

describe('diagnoseGitHubToken', () => {
  it('identifies a rejected credential from a 401 on /user', async () => {
    const http = httpFor((req) => respond({ statusCode: 401, body: new TextEncoder().encode('{"message":"Bad credentials"}') }, req.url));

    const report = await diagnoseGitHubToken(http, VALID_TOKEN, 'owner/repo');

    expect(report.userStatus).toBe(401);
    expect(report.verdict).toMatch(/rejected the credential itself/);
  });

  it('reports repo access when both probes succeed', async () => {
    const http = httpFor((req) => (
      req.url.includes('/user')
        ? respond({ statusCode: 200, body: new TextEncoder().encode('{"login":"octocat"}'), headers: { 'x-oauth-scopes': 'repo, gist' } }, req.url)
        : respond({ statusCode: 200 }, req.url)
    ));

    const report = await diagnoseGitHubToken(http, VALID_TOKEN, 'owner/private-repo');

    expect(report.login).toBe('octocat');
    expect(report.repoStatus).toBe(200);
    expect(report.verdict).toMatch(/credential is valid and belongs to octocat/);
  });

  it('calls out a missing repo scope when the repo is invisible', async () => {
    const http = httpFor((req) => (
      req.url.includes('/user')
        ? respond({ statusCode: 200, body: new TextEncoder().encode('{"login":"octocat"}'), headers: { 'x-oauth-scopes': 'gist' } }, req.url)
        : respond({ statusCode: 404 }, req.url)
    ));

    const report = await diagnoseGitHubToken(http, VALID_TOKEN, 'owner/private-repo');

    expect(report.verdict).toMatch(/lacks the 'repo' scope/);
  });

  it('calls out SSO authorization when GitHub asks for it', async () => {
    const http = httpFor((req) => (
      req.url.includes('/user')
        ? respond({ statusCode: 200, body: new TextEncoder().encode('{"login":"octocat"}'), headers: { 'x-oauth-scopes': 'repo' } }, req.url)
        : respond({ statusCode: 403, headers: { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' } }, req.url)
    ));

    const report = await diagnoseGitHubToken(http, VALID_TOKEN, 'acme/private-repo');

    expect(report.verdict).toMatch(/not SSO-authorized for acme\/private-repo/);
  });

  it('blames the account when the token is valid but the repo is not visible', async () => {
    const http = httpFor((req) => (
      req.url.includes('/user')
        ? respond({ statusCode: 200, body: new TextEncoder().encode('{"login":"wrong-account"}'), headers: { 'x-oauth-scopes': 'repo' } }, req.url)
        : respond({ statusCode: 404 }, req.url)
    ));

    const report = await diagnoseGitHubToken(http, VALID_TOKEN, 'acme/private-repo');

    expect(report.verdict).toMatch(/wrong-account.*cannot see acme\/private-repo/);
  });

  it('distinguishes a transport failure from an access failure', async () => {
    const http: HttpClient = { fetch: (): Promise<HttpResponse> => Promise.reject(new Error('ECONNREFUSED')) };

    const report = await diagnoseGitHubToken(http, VALID_TOKEN, 'owner/repo');

    expect(report.verdict).toMatch(/network\/proxy problem/);
  });

  it('never includes the token value in its output', async () => {
    const http = httpFor((req) => respond({ statusCode: 401 }, req.url));

    const report = await diagnoseGitHubToken(http, VALID_TOKEN, 'owner/repo');
    const rendered = formatGitHubTokenReport(report);

    expect(rendered).not.toContain(VALID_TOKEN);
    expect(rendered).toContain(REDACTED_TOKEN);
  });
});
