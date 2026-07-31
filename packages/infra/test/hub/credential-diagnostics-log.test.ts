/**
 * Verifies that a credential-suspect hub fetch failure emits the
 * api.github.com credential diagnostics needed to tell a rejected token
 * from a genuine access problem — the whole point of probing, since
 * raw.githubusercontent.com reports both as a bare 404.
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
  GitHubHubResolver,
} from '../../src/hub/hub-resolver';

function response(statusCode: number, body = '', headers: Record<string, string> = {}): HttpResponse {
  return { statusCode, body: new TextEncoder().encode(body), finalUrl: '', headers };
}

describe('GitHubHubResolver credential diagnostics', () => {
  it('logs the account, real scopes and verdict when a private hub 404s', async () => {
    const http: HttpClient = {
      fetch: (req: HttpRequest): Promise<HttpResponse> => {
        if (req.url.startsWith('https://raw.githubusercontent.com/')) {
          return Promise.resolve(response(404, '404: Not Found'));
        }
        if (req.url === 'https://api.github.com/user') {
          return Promise.resolve(response(200, '{"login":"octocat"}', { 'x-oauth-scopes': 'gist, read:org, repo, workflow' }));
        }
        // The token is valid but this account cannot see the repo.
        return Promise.resolve(response(404, '{"message":"Not Found"}'));
      }
    };
    const logged: string[] = [];
    const resolver = new GitHubHubResolver(
      http,
      { getToken: (): Promise<string> => Promise.resolve('test-fake-value-for-unit-tests') },
      (event) => {
        logged.push(`${event.level}: ${event.message}`);
      }
    );

    await expect(resolver.resolve({ type: 'github', location: 'acme/private-hub-config' }))
      .rejects.toThrow('HTTP 404');

    const diagnostics = logged.find((line) => line.includes('credential diagnostics'));
    expect(diagnostics).toBeDefined();
    expect(diagnostics).toContain('login=octocat');
    expect(diagnostics).toContain('repoStatus=404');
    expect(diagnostics).toContain('cannot see acme/private-hub-config');
  });

  it('does not probe api.github.com when the fetch succeeds', async () => {
    const urls: string[] = [];
    const validYaml = 'version: 1.0.0\nmetadata:\n  name: Hub\nsources: []\nprofiles: []\n';
    const http: HttpClient = {
      fetch: (req: HttpRequest): Promise<HttpResponse> => {
        urls.push(req.url);
        return Promise.resolve(response(200, validYaml));
      }
    };
    const resolver = new GitHubHubResolver(
      http,
      { getToken: (): Promise<string> => Promise.resolve('test-fake-value-for-unit-tests') },
      () => undefined
    );

    await resolver.resolve({ type: 'github', location: 'owner/repo' });

    expect(urls.every((url) => url.startsWith('https://raw.githubusercontent.com/'))).toBe(true);
  });
});
