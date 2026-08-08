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
  diagnoseGitHubTokenForRepos,
  formatGitHubTokenReport,
  formatRawContentProbe,
  probeRawContentWithCredential,
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

describe('probeRawContentWithCredential', () => {
  const CONTROL_URL = 'https://raw.githubusercontent.com/github/awesome-copilot/main/README.md';

  it('clears the credential when public raw content loads with it', async () => {
    const attempts: (string | undefined)[] = [];
    const http: HttpClient = {
      fetch: (req): Promise<HttpResponse> => {
        attempts.push(req.headers?.Authorization);
        return Promise.resolve(respond({ statusCode: 200 }, req.url));
      }
    };

    const probe = await probeRawContentWithCredential(http, VALID_TOKEN, CONTROL_URL);

    expect(attempts).toEqual([`token ${VALID_TOKEN}`]);
    expect(probe.verdict).toMatch(/credential is accepted for public raw content/);
  });

  it('blames the credential when the anonymous retry succeeds', async () => {
    const http: HttpClient = {
      fetch: (req): Promise<HttpResponse> => Promise.resolve(
        respond({ statusCode: req.headers?.Authorization === undefined ? 200 : 404 }, req.url)
      )
    };

    const probe = await probeRawContentWithCredential(http, VALID_TOKEN, CONTROL_URL);

    expect(probe.authenticatedStatus).toBe(404);
    expect(probe.anonymousStatus).toBe(200);
    expect(probe.verdict).toMatch(/rejecting the credential itself/);
  });

  it('stays inconclusive when the control URL fails either way', async () => {
    const http = httpFor((req) => respond({ statusCode: 500 }, req.url));

    const probe = await probeRawContentWithCredential(http, VALID_TOKEN, CONTROL_URL);

    expect(probe.verdict).toMatch(/inconclusive/);
  });

  it('never includes the token value in its output', async () => {
    const http = httpFor((req) => respond({ statusCode: 404 }, req.url));

    const rendered = formatRawContentProbe(await probeRawContentWithCredential(http, VALID_TOKEN, CONTROL_URL));

    expect(rendered).not.toContain(VALID_TOKEN);
  });
});

describe('diagnoseGitHubTokenForRepos', () => {
  /**
   * Route probes by URL while recording every request, so both the answers
   * and the request count can be asserted.
   * @param userStatus Status for `GET /user`.
   * @param repoStatuses Status per `owner/repo`.
   */
  const recordingHttp = (userStatus: number, repoStatuses: Record<string, number> = {}): { http: HttpClient; urls: string[] } => {
    const urls: string[] = [];
    const http: HttpClient = {
      fetch: (req): Promise<HttpResponse> => {
        urls.push(req.url);
        if (req.url.endsWith('/user')) {
          return Promise.resolve(respond({
            statusCode: userStatus,
            body: new TextEncoder().encode('{"login":"octocat"}'),
            headers: { 'x-oauth-scopes': 'repo' }
          }, req.url));
        }
        const location = req.url.replace('https://api.github.com/repos/', '');
        return Promise.resolve(respond({ statusCode: repoStatuses[location] ?? 404 }, req.url));
      }
    };
    return { http, urls };
  };

  it('validates the credential once and probes each repo once', async () => {
    const { http, urls } = recordingHttp(200, { 'a/one': 200, 'b/two': 200 });

    const reports = await diagnoseGitHubTokenForRepos(http, VALID_TOKEN, ['a/one', 'b/two']);

    expect(urls).toHaveLength(3);
    expect(urls.filter((url) => url.endsWith('/user'))).toHaveLength(1);
    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.login === 'octocat')).toBe(true);
  });

  it('returns reports in the same order as the requested locations', async () => {
    const { http } = recordingHttp(200, { 'a/one': 200, 'b/two': 403 });

    const reports = await diagnoseGitHubTokenForRepos(http, VALID_TOKEN, ['a/one', 'b/two']);

    expect(reports[0].repoStatus).toBe(200);
    expect(reports[1].repoStatus).toBe(403);
  });

  it('skips repo probes and returns a single credential verdict when /user rejects the token', async () => {
    const { http, urls } = recordingHttp(401, { 'a/one': 200, 'b/two': 200 });

    const reports = await diagnoseGitHubTokenForRepos(http, VALID_TOKEN, ['a/one', 'b/two']);

    expect(urls).toEqual(['https://api.github.com/user']);
    expect(reports).toHaveLength(1);
    expect(reports[0].verdict).toMatch(/rejected the credential itself/);
  });

  it('diagnoses the credential alone when no location is supplied', async () => {
    const { http, urls } = recordingHttp(200);

    const reports = await diagnoseGitHubTokenForRepos(http, VALID_TOKEN, []);

    expect(urls).toEqual(['https://api.github.com/user']);
    expect(reports[0].verdict).toMatch(/credential is valid and belongs to octocat/);
  });
});
