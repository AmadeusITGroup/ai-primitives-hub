/**
 * Tests for GitHubCollaborationClient and GitWorkspaceAdapter.
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  ProcessExecutor,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  extractGitHubSlugFromRemoteUrl,
  GitWorkspaceAdapter,
} from '../../src/hub/git-workspace-adapter';
import {
  GhCliAccountManager,
  GitHubCollaborationClient,
} from '../../src/hub/github-collaboration-client';

const jsonResponse = (statusCode: number, payload: unknown): HttpResponse => ({
  statusCode,
  body: new TextEncoder().encode(JSON.stringify(payload)),
  finalUrl: 'https://api.github.com',
  headers: { 'content-type': 'application/json' }
});

describe('GitHubCollaborationClient', () => {
  it('ensures a fork exists by creating one when not yet present and creates/tracks PRs', async () => {
    const requests: HttpRequest[] = [];
    let forkCreated = false;
    const http: HttpClient = {
      fetch: (req) => {
        requests.push(req);
        if (req.url.endsWith('/user')) {
          return Promise.resolve(jsonResponse(200, { login: 'contributor-user', html_url: 'https://github.com/contributor-user' }));
        }
        if (req.url.endsWith('/repos/AmadeusITGroup/prompt-registry-config')) {
          return Promise.resolve(jsonResponse(200, {
            owner: { login: 'AmadeusITGroup' },
            name: 'prompt-registry-config',
            full_name: 'AmadeusITGroup/prompt-registry-config',
            default_branch: 'main',
            html_url: 'https://github.com/AmadeusITGroup/prompt-registry-config',
            clone_url: 'https://github.com/AmadeusITGroup/prompt-registry-config.git',
            ssh_url: 'git@github.com:AmadeusITGroup/prompt-registry-config.git',
            fork: false
          }));
        }
        if (req.url.endsWith('/repos/contributor-user/prompt-registry-config')) {
          if (!forkCreated) {
            return Promise.resolve(jsonResponse(404, { message: 'Not Found' }));
          }
          return Promise.resolve(jsonResponse(200, {
            owner: { login: 'contributor-user' },
            name: 'prompt-registry-config',
            full_name: 'contributor-user/prompt-registry-config',
            default_branch: 'main',
            html_url: 'https://github.com/contributor-user/prompt-registry-config',
            clone_url: 'https://github.com/contributor-user/prompt-registry-config.git',
            ssh_url: 'git@github.com:contributor-user/prompt-registry-config.git',
            fork: true,
            parent: { full_name: 'AmadeusITGroup/prompt-registry-config' }
          }));
        }
        if (req.url.endsWith('/repos/AmadeusITGroup/prompt-registry-config/forks') && req.method === 'POST') {
          forkCreated = true;
          return Promise.resolve(jsonResponse(202, {
            owner: { login: 'contributor-user' },
            name: 'prompt-registry-config',
            full_name: 'contributor-user/prompt-registry-config',
            default_branch: 'main',
            html_url: 'https://github.com/contributor-user/prompt-registry-config',
            clone_url: 'https://github.com/contributor-user/prompt-registry-config.git',
            ssh_url: 'git@github.com:contributor-user/prompt-registry-config.git',
            parent: { full_name: 'AmadeusITGroup/prompt-registry-config' }
          }));
        }
        if (req.url.endsWith('/repos/AmadeusITGroup/prompt-registry-config/pulls') && req.method === 'POST') {
          const body = JSON.parse(String(req.body));
          return Promise.resolve(jsonResponse(201, {
            number: 42,
            title: body.title,
            html_url: 'https://github.com/AmadeusITGroup/prompt-registry-config/pull/42',
            state: 'open',
            draft: Boolean(body.draft),
            merged: false,
            updated_at: '2026-10-25T10:00:00Z',
            head: { ref: 'feat/add-my-profile', sha: 'abc1234' },
            base: { ref: 'main' }
          }));
        }
        if (req.url.endsWith('/repos/AmadeusITGroup/prompt-registry-config/pulls/42')) {
          return Promise.resolve(jsonResponse(200, {
            number: 42,
            title: 'feat(hub): add profile',
            html_url: 'https://github.com/AmadeusITGroup/prompt-registry-config/pull/42',
            state: 'open',
            draft: false,
            merged: false,
            updated_at: '2026-10-25T10:05:00Z',
            head: { ref: 'feat/add-my-profile', sha: 'abc1234' },
            base: { ref: 'main' }
          }));
        }
        if (req.url.includes('/commits/abc1234/check-runs?per_page=100')) {
          return Promise.resolve(jsonResponse(200, {
            total_count: 2,
            check_runs: [
              { status: 'completed', conclusion: 'success' },
              { status: 'completed', conclusion: 'success' }
            ]
          }));
        }
        return Promise.reject(new Error(`Unexpected URL: ${req.url}`));
      }
    };

    const tokenProvider: TokenProvider = {
      getToken: () => Promise.resolve('ghp_test_token')
    };

    const client = new GitHubCollaborationClient(http, { tokenProvider });

    const fork = await client.ensureFork('AmadeusITGroup', 'prompt-registry-config');
    expect(fork.fullName).toBe('contributor-user/prompt-registry-config');
    expect(fork.upstreamFullName).toBe('AmadeusITGroup/prompt-registry-config');

    const pr = await client.createPullRequest({
      upstreamOwner: 'AmadeusITGroup',
      upstreamRepo: 'prompt-registry-config',
      head: 'contributor-user:feat/add-my-profile',
      base: 'main',
      title: 'feat(hub): add profile',
      body: 'Summary of changes'
    });
    expect(pr.number).toBe(42);
    expect(pr.state).toBe('open');

    const status = await client.getPullRequestStatus('AmadeusITGroup', 'prompt-registry-config', 42);
    expect(status.checks).toEqual({
      state: 'success',
      totalCount: 2,
      passingCount: 2,
      failingCount: 0,
      pendingCount: 0
    });
  });

  it('lists gh auth accounts, probes hub access, and switches from an inaccessible active account to a working account', async () => {
    const executedCommands: { file: string; args: readonly string[] }[] = [];
    const executor: ProcessExecutor = {
      execFile: (file, args) => {
        executedCommands.push({ file, args });
        if (args[0] === 'auth' && args[1] === 'status' && args.includes('--json')) {
          return Promise.resolve({
            stdout: JSON.stringify({
              hosts: {
                'github.com': [
                  {
                    state: 'success',
                    active: true,
                    host: 'github.com',
                    login: 'pwherka1_amadeus',
                    scopes: 'gist, read:org, repo, workflow'
                  },
                  {
                    state: 'success',
                    active: false,
                    host: 'github.com',
                    login: 'wherka-ama',
                    scopes: 'gist, read:org, repo, workflow'
                  },
                  {
                    state: 'error',
                    active: false,
                    host: 'github.com',
                    login: 'aiprimitiviesgovernance[bot]',
                    error: 'HTTP 401: Bad credentials'
                  }
                ]
              }
            }),
            stderr: ''
          });
        }
        if (args[0] === 'auth' && args[1] === 'token') {
          const userIdx = args.indexOf('--user');
          const user = userIdx === -1 ? 'pwherka1_amadeus' : args[userIdx + 1];
          return Promise.resolve({
            stdout: user === 'wherka-ama' ? 'gho_valid_wherka_ama_token\n' : 'gho_wrong_emu_token\n',
            stderr: ''
          });
        }
        if (args[0] === 'auth' && args[1] === 'switch') {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        return Promise.reject(new Error(`Unexpected gh command: ${args.join(' ')}`));
      }
    };

    const http: HttpClient = {
      fetch: (req) => {
        const authHeader = req.headers?.Authorization ?? '';
        if (req.url.endsWith('/repos/Amadeus-xDLC/genai.prompt-registry-config')) {
          if (authHeader.includes('gho_valid_wherka_ama_token')) {
            return Promise.resolve(jsonResponse(200, {
              owner: { login: 'Amadeus-xDLC' },
              name: 'genai.prompt-registry-config',
              full_name: 'Amadeus-xDLC/genai.prompt-registry-config',
              default_branch: 'main',
              html_url: 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config',
              clone_url: 'https://github.com/Amadeus-xDLC/genai.prompt-registry-config.git',
              ssh_url: 'git@github.com:Amadeus-xDLC/genai.prompt-registry-config.git',
              fork: false
            }));
          }
          return Promise.resolve(jsonResponse(404, { message: 'Not Found' }));
        }
        return Promise.reject(new Error(`Unexpected URL: ${req.url}`));
      }
    };

    const accountManager = new GhCliAccountManager(executor, http);
    const client = new GitHubCollaborationClient(http, { accountManager });

    const resolution = await client.resolveAccessibleAccount(
      'Amadeus-xDLC',
      'genai.prompt-registry-config',
      { switchActive: true }
    );

    expect(resolution.selectedAccount?.login).toBe('wherka-ama');
    expect(resolution.switchedFromAccount).toBe('pwherka1_amadeus');
    expect(resolution.accessibleAccounts.map((a) => a.login)).toEqual(['wherka-ama']);
    expect(resolution.message).toContain('wherka-ama');
    expect(executedCommands.some((c) => c.args[0] === 'auth' && c.args[1] === 'switch' && c.args.includes('wherka-ama'))).toBe(true);

    // Subsequent repository call uses the selected account's token automatically
    const repo = await client.getRepository('Amadeus-xDLC', 'genai.prompt-registry-config');
    expect(repo.fullName).toBe('Amadeus-xDLC/genai.prompt-registry-config');
  });
});

describe('GitWorkspaceAdapter & extractGitHubSlugFromRemoteUrl', () => {
  it('extracts owner/repo (including dots in repo name) from HTTPS and SSH GitHub remote URLs', () => {
    expect(extractGitHubSlugFromRemoteUrl('https://github.com/AmadeusITGroup/prompt-registry-config.git'))
      .toBe('AmadeusITGroup/prompt-registry-config');
    expect(extractGitHubSlugFromRemoteUrl('https://github.com/Amadeus-xDLC/genai.prompt-registry-config.git'))
      .toBe('Amadeus-xDLC/genai.prompt-registry-config');
    expect(extractGitHubSlugFromRemoteUrl('git@github.com:Amadeus-xDLC/genai.prompt-registry-config.git'))
      .toBe('Amadeus-xDLC/genai.prompt-registry-config');
    expect(extractGitHubSlugFromRemoteUrl('git@github.com:AmadeusITGroup/prompt-registry-config.git'))
      .toBe('AmadeusITGroup/prompt-registry-config');
    expect(extractGitHubSlugFromRemoteUrl('ssh://git@github.com/AmadeusITGroup/prompt-registry-config'))
      .toBe('AmadeusITGroup/prompt-registry-config');
    expect(extractGitHubSlugFromRemoteUrl('https://gitlab.example.com/org/repo.git'))
      .toBeUndefined();
  });

  it('executes git operations via ProcessExecutor', async () => {
    const calls: { file: string; args: readonly string[]; cwd?: string }[] = [];
    const executor: ProcessExecutor = {
      execFile: (file, args, options) => {
        calls.push({ file, args, cwd: options?.cwd });
        if (args[0] === 'rev-parse' && args[1] === '--show-cdup') {
          return Promise.resolve({ stdout: '\n', stderr: '' });
        }
        if (args[0] === 'remote' && args[1] === '-v') {
          return Promise.resolve({
            stdout: [
              'origin\thttps://github.com/user/prompt-registry-config.git (fetch)',
              'origin\thttps://github.com/user/prompt-registry-config.git (push)',
              'upstream\thttps://github.com/AmadeusITGroup/prompt-registry-config.git (fetch)'
            ].join('\n'),
            stderr: ''
          });
        }
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return Promise.resolve({ stdout: 'feat/hub-update\n', stderr: '' });
        }
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return Promise.resolve({ stdout: ' M hub-config.yml\n', stderr: '' });
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return Promise.resolve({ stdout: 'deadbeef1234\n', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      }
    };

    const git = new GitWorkspaceAdapter(executor);
    await git.cloneRepository('https://github.com/user/prompt-registry-config.git', '/workspace/prompt-registry-config');
    expect(calls[0].args).toEqual(['clone', '--', 'https://github.com/user/prompt-registry-config.git', '/workspace/prompt-registry-config']);

    const status = await git.getStatus('/workspace/prompt-registry-config');
    expect(status.isGitRepo).toBe(true);
    expect(status.currentBranch).toBe('feat/hub-update');
    expect(status.remotes.origin).toBe('https://github.com/user/prompt-registry-config.git');
    expect(status.remotes.upstream).toBe('https://github.com/AmadeusITGroup/prompt-registry-config.git');
    expect(status.modifiedFiles).toEqual(['hub-config.yml']);
    expect(status.hasUncommittedChanges).toBe(true);

    const { commitSha } = await git.commitAndPush(
      '/workspace/prompt-registry-config',
      ['hub-config.yml'],
      'feat(hub): add profile',
      'origin',
      'feat/hub-update'
    );
    expect(commitSha).toBe('deadbeef1234');
    expect(calls.some((c) => c.args[0] === 'commit' && c.args.includes('--') && c.args.includes('hub-config.yml'))).toBe(true);
  });
});
