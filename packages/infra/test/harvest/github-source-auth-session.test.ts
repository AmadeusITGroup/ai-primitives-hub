import {
  access,
  writeFile,
} from 'node:fs/promises';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HubSourceSpec,
  ProcessExecutor,
  ProcessResult,
  ProcessRunOptions,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createGitHubSourceAuthSession,
} from '../../src/harvest/github-source-auth-runtime';

class SessionExecutor implements ProcessExecutor {
  public readonly calls: { file: string; args: readonly string[]; options: ProcessRunOptions | undefined }[] = [];

  public async execFile(file: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    if (args.includes('setup')) {
      const configPath = options?.env?.GH_APP_AUTH_CONFIG;
      if (configPath !== undefined) {
        await writeFile(configPath, 'generated: true\n', { mode: 0o600 });
      }
      return { stdout: '', stderr: '' };
    }
    return { stdout: 'installation-token\n', stderr: '' };
  }
}

class SessionHttpClient implements HttpClient {
  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    const authenticated = request.headers?.Authorization !== undefined;
    return {
      statusCode: authenticated ? 200 : 404,
      body: new TextEncoder().encode(authenticated ? '{"private":true}' : '{}'),
      finalUrl: request.url,
      headers: {}
    };
  }
}

const source: HubSourceSpec = {
  id: 'private-source',
  name: 'Private Source',
  type: 'github',
  url: 'https://github.com/org/private-repo',
  owner: 'org',
  repo: 'private-repo',
  branch: 'main'
};

describe('createGitHubSourceAuthSession', () => {
  it('derives a temporary config, runs setup after generic classification, and cleans it up', async () => {
    const executor = new SessionExecutor();
    const session = await createGitHubSourceAuthSession({
      env: {},
      http: new SessionHttpClient(),
      appId: '123',
      keyFile: '/tmp/input-private-key.pem',
      processExecutor: executor,
      genericTokenProvider: { getToken: async () => 'generic-token' }
    });

    expect(session.configPath).toBeDefined();
    const report = await session.preflight([source]);

    expect(report.valid).toBe(true);
    expect(report.results[0]?.category).toBe('app-authenticated');
    expect(executor.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ['app-auth', 'setup', '--app-id'],
      ['app-auth', 'token', '--app-id']
    ]);
    expect(executor.calls[0]?.args).toContain('github.com/org/*');
    expect(executor.calls[1]?.args).toContain('github.com/org/private-repo');
    expect(executor.calls[0]?.options?.env?.GH_APP_AUTH_CONFIG).toBe(session.configPath);

    await access(session.configPath);
    await session.cleanup();
    await expect(access(session.configPath)).rejects.toThrow();
  });
});
