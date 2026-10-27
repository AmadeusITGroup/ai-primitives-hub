/* eslint-disable @typescript-eslint/naming-convention -- GitHub REST API JSON payloads use snake_case keys */
/**
 * `GitHubCollaborationPort` implementation backed by `HttpClient` and `TokenProvider`.
 *
 * Supports authenticated user resolution, repository metadata lookup, fork
 * creation, pull request creation, and pull request / CI check-run tracking.
 * @module hub/github-collaboration-client
 */
import type {
  CreatePullRequestInput,
  GitHubAccountProbeResult,
  GitHubAccountResolution,
  GitHubCliAccount,
  GitHubCollaborationPort,
  GitHubForkInfo,
  GitHubRepoMetadata,
  GitHubUserProfile,
  HttpClient,
  HttpResponse,
  HubPullRequestCheckSummary,
  HubPullRequestInfo,
  ProcessExecutor,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';
import {
  getDefaultUserAgent,
} from '../http/user-agent';

const DEFAULT_BASE_URL = 'https://api.github.com';

const decodeJson = <T>(response: HttpResponse): T => {
  const text = new TextDecoder().decode(response.body);
  return JSON.parse(text) as T;
};

/**
 * Discovers, probes, and switches `gh auth` accounts when multiple GitHub CLI
 * accounts are configured on a developer machine.
 */
export class GhCliAccountManager {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  public constructor(
    private readonly executor: ProcessExecutor,
    private readonly http: HttpClient,
    options: { baseUrl?: string; userAgent?: string } = {}
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? getDefaultUserAgent();
  }

  private parseStatusText(rawOutput: string, targetHost: string): GitHubCliAccount[] {
    const accounts: GitHubCliAccount[] = [];
    let currentLogin: string | undefined;
    let currentState: 'success' | 'error' = 'success';
    let currentActive = false;

    const flush = (): void => {
      if (currentLogin) {
        accounts.push({
          login: currentLogin,
          host: targetHost,
          active: currentActive,
          state: currentState
        });
      }
      currentLogin = undefined;
      currentActive = false;
      currentState = 'success';
    };

    for (const line of rawOutput.split(/\r?\n/)) {
      const loggedInMatch = /Logged in to (\S+) account (\S+)/i.exec(line);
      if (loggedInMatch) {
        flush();
        if (loggedInMatch[1].toLowerCase() === targetHost.toLowerCase()) {
          currentLogin = loggedInMatch[2];
          currentState = 'success';
        }
        continue;
      }
      const failedMatch = /Failed to log in to (\S+) account (\S+)/i.exec(line);
      if (failedMatch) {
        flush();
        if (failedMatch[1].toLowerCase() === targetHost.toLowerCase()) {
          currentLogin = failedMatch[2];
          currentState = 'error';
        }
        continue;
      }
      const activeMatch = /Active account:\s*(true|false)/i.exec(line);
      if (activeMatch && currentLogin) {
        currentActive = activeMatch[1].toLowerCase() === 'true';
      }
    }
    flush();
    return accounts;
  }

  public async listAccounts(host = 'github.com'): Promise<GitHubCliAccount[]> {
    try {
      const res = await this.executor.execFile('gh', ['auth', 'status', '--json', 'hosts'], {
        timeoutMs: 5000
      });
      const parsed = JSON.parse(res.stdout) as {
        hosts?: Record<string, {
          state?: string;
          active?: boolean;
          host?: string;
          login?: string;
          scopes?: string;
          error?: string;
        }[]>;
      };
      const entries = parsed.hosts?.[host] ?? parsed.hosts?.[host.toLowerCase()] ?? [];
      return entries
        .filter((e) => typeof e.login === 'string' && e.login.length > 0)
        .map((e) => ({
          login: e.login!,
          host: e.host || host,
          active: Boolean(e.active),
          state: e.state === 'success' ? 'success' as const : 'error' as const,
          scopes: e.scopes,
          error: e.error
        }));
    } catch {
      try {
        const fallback = await this.executor.execFile('gh', ['auth', 'status', '--hostname', host], {
          timeoutMs: 5000
        });
        return this.parseStatusText(`${fallback.stdout}\n${fallback.stderr}`, host);
      } catch {
        return [];
      }
    }
  }

  public async getTokenForAccount(host: string, login?: string): Promise<string | undefined> {
    try {
      const args = login
        ? ['auth', 'token', '--hostname', host, '--user', login]
        : ['auth', 'token', '--hostname', host];
      const res = await this.executor.execFile('gh', args, { timeoutMs: 3000 });
      const token = res.stdout.trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }

  public async switchAccount(host: string, login: string): Promise<void> {
    await this.executor.execFile('gh', ['auth', 'switch', '--hostname', host, '--user', login], {
      timeoutMs: 5000
    });
  }

  public async probeAndSelectAccount(
    owner: string,
    repo: string,
    options: {
      host?: string;
      switchActive?: boolean;
      preferredLogin?: string;
    } = {}
  ): Promise<GitHubAccountResolution & { selectedToken?: string }> {
    const host = options.host ?? 'github.com';
    const rawAccounts = await this.listAccounts(host);
    if (rawAccounts.length === 0) {
      return {
        accounts: [],
        accessibleAccounts: []
      };
    }

    const activeAccount = rawAccounts.find((a) => a.active);
    const orderedAccounts = [
      ...rawAccounts.filter((a) => a.active),
      ...rawAccounts.filter((a) => !a.active)
    ];

    const probed: (GitHubAccountProbeResult & { token?: string })[] = await Promise.all(
      orderedAccounts.map(async (account) => {
        if (account.state !== 'success') {
          return {
            ...account,
            canAccessHub: false,
            probeReason: account.error ?? 'Account token is invalid in gh keyring'
          };
        }

        const token = await this.getTokenForAccount(host, account.login);
        if (!token) {
          return {
            ...account,
            canAccessHub: false,
            probeReason: 'Unable to retrieve token via gh auth token'
          };
        }

        try {
          const res = await this.http.fetch({
            url: `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
            method: 'GET',
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': this.userAgent,
              Authorization: `Bearer ${token}`
            }
          });
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return {
              ...account,
              canAccessHub: true,
              probeReason: 'Access verified',
              token
            };
          }
          return {
            ...account,
            canAccessHub: false,
            probeReason: `HTTP ${res.statusCode} when accessing ${owner}/${repo}`
          };
        } catch (error) {
          return {
            ...account,
            canAccessHub: false,
            probeReason: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );

    const accessible = probed.filter((a) => a.canAccessHub);
    let selected = options.preferredLogin
      ? accessible.find((a) => a.login.toLowerCase() === options.preferredLogin!.toLowerCase())
      : undefined;

    if (!selected) {
      selected = accessible.find((a) => a.active) ?? accessible[0];
    }

    let switchedFromAccount: string | undefined;
    let message: string | undefined;
    const cleanAccounts: GitHubAccountProbeResult[] = probed.map(({ token: _t, ...rest }) => rest);

    if (selected) {
      const selectedToken = selected.token;
      const cleanSelected: GitHubAccountProbeResult = {
        login: selected.login,
        host: selected.host,
        active: selected.active,
        state: selected.state,
        scopes: selected.scopes,
        error: selected.error,
        canAccessHub: selected.canAccessHub,
        probeReason: selected.probeReason
      };
      const cleanAccessible = cleanAccounts.filter((a) => a.canAccessHub);

      if (activeAccount && activeAccount.login !== selected.login) {
        if (options.switchActive === false) {
          message = `Selected GitHub CLI account '${selected.login}' (verified access to ${owner}/${repo}).`;
        } else {
          await this.switchAccount(host, selected.login);
          cleanSelected.active = true;
          switchedFromAccount = activeAccount.login;
          message = `Switched active GitHub CLI account from '${activeAccount.login}' to '${selected.login}' (verified access to ${owner}/${repo}).`;
        }
      } else {
        message = `Verified GitHub CLI account '${selected.login}' has access to ${owner}/${repo}.`;
      }

      return {
        selectedAccount: cleanSelected,
        selectedToken,
        switchedFromAccount,
        accounts: cleanAccounts,
        accessibleAccounts: cleanAccessible,
        message
      };
    }

    const testedSummary = cleanAccounts
      .map((a) => `${a.login} (${a.probeReason ?? a.state})`)
      .join(', ');
    return {
      accounts: cleanAccounts,
      accessibleAccounts: [],
      message: `None of the configured GitHub CLI accounts could access ${owner}/${repo}. Tested: ${testedSummary}`
    };
  }
}

export interface GitHubCollaborationClientOptions {
  baseUrl?: string;
  userAgent?: string;
  tokenProvider?: TokenProvider;
  accountManager?: GhCliAccountManager;
  forkPollAttempts?: number;
  forkPollIntervalMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubCollaborationClient implements GitHubCollaborationPort {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly forkPollAttempts: number;
  private readonly forkPollIntervalMs: number;
  private selectedAccountToken: string | undefined;

  public constructor(
    private readonly http: HttpClient,
    private readonly options: GitHubCollaborationClientOptions = {}
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? getDefaultUserAgent();
    this.forkPollAttempts = options.forkPollAttempts ?? 6;
    this.forkPollIntervalMs = options.forkPollIntervalMs ?? 500;
  }

  private async buildHeaders(url: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': this.userAgent
    };
    const host = new URL(url).hostname.toLowerCase();
    if (isGitHubHost(host)) {
      if (this.selectedAccountToken) {
        headers.Authorization = `Bearer ${this.selectedAccountToken}`;
      } else if (this.options.tokenProvider) {
        const token = await this.options.tokenProvider.getToken(host);
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
      }
    }
    return headers;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, unknown>
  ): Promise<HttpResponse> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = await this.buildHeaders(url);
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return this.http.fetch({
      url,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  public async getAuthenticatedUser(): Promise<GitHubUserProfile> {
    const res = await this.request('/user');
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Failed to resolve authenticated GitHub user (HTTP ${res.statusCode}). Please sign in to GitHub.`);
    }
    const data = decodeJson<{ login: string; html_url: string }>(res);
    return {
      login: data.login,
      htmlUrl: data.html_url
    };
  }

  public async getRepository(owner: string, repo: string): Promise<GitHubRepoMetadata> {
    const res = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Failed to fetch repository ${owner}/${repo} (HTTP ${res.statusCode}).`);
    }
    const data = decodeJson<{
      owner: { login: string };
      name: string;
      full_name: string;
      default_branch: string;
      html_url: string;
      clone_url: string;
      ssh_url: string;
      fork: boolean;
      permissions?: { push?: boolean };
      parent?: { full_name: string };
    }>(res);
    return {
      owner: data.owner.login,
      name: data.name,
      fullName: data.full_name,
      defaultBranch: data.default_branch || 'main',
      htmlUrl: data.html_url,
      cloneUrl: data.clone_url,
      sshUrl: data.ssh_url,
      fork: Boolean(data.fork),
      canPush: data.permissions?.push,
      parentFullName: data.parent?.full_name
    };
  }

  public async ensureFork(owner: string, repo: string): Promise<GitHubForkInfo> {
    const user = await this.getAuthenticatedUser();
    const upstream = await this.getRepository(owner, repo);

    if (user.login.toLowerCase() === owner.toLowerCase()) {
      return {
        owner: upstream.owner,
        name: upstream.name,
        fullName: upstream.fullName,
        defaultBranch: upstream.defaultBranch,
        htmlUrl: upstream.htmlUrl,
        cloneUrl: upstream.cloneUrl,
        sshUrl: upstream.sshUrl,
        upstreamFullName: upstream.fullName
      };
    }

    const existingRes = await this.request(`/repos/${encodeURIComponent(user.login)}/${encodeURIComponent(repo)}`);
    if (existingRes.statusCode >= 200 && existingRes.statusCode < 300) {
      const existing = decodeJson<{
        owner: { login: string };
        name: string;
        full_name: string;
        default_branch: string;
        html_url: string;
        clone_url: string;
        ssh_url: string;
        fork?: boolean;
        parent?: { full_name: string };
        source?: { full_name: string };
      }>(existingRes);
      const parentFullName = existing.parent?.full_name ?? existing.source?.full_name;
      if (existing.fork === false || (parentFullName && parentFullName.toLowerCase() !== upstream.fullName.toLowerCase())) {
        throw new Error(
          `Repository '${existing.full_name}' already exists under '${user.login}' and is not a fork of '${upstream.fullName}'.`
        );
      }
      return {
        owner: existing.owner.login,
        name: existing.name,
        fullName: existing.full_name,
        defaultBranch: existing.default_branch || upstream.defaultBranch,
        htmlUrl: existing.html_url,
        cloneUrl: existing.clone_url,
        sshUrl: existing.ssh_url,
        upstreamFullName: upstream.fullName
      };
    }

    const forkRes = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`,
      'POST',
      {}
    );
    if (forkRes.statusCode < 200 || forkRes.statusCode >= 300) {
      throw new Error(`Failed to fork ${owner}/${repo} (HTTP ${forkRes.statusCode}).`);
    }

    const forked = decodeJson<{
      owner: { login: string };
      name: string;
      full_name: string;
      default_branch: string;
      html_url: string;
      clone_url: string;
      ssh_url: string;
    }>(forkRes);

    // Poll until the newly created fork repository is reachable (GitHub creates forks asynchronously on 202 Accepted)
    const forkPath = `/repos/${encodeURIComponent(forked.owner.login)}/${encodeURIComponent(forked.name)}`;
    let forkReady = false;
    for (let attempt = 0; attempt < this.forkPollAttempts; attempt++) {
      const checkRes = await this.request(forkPath);
      if (checkRes.statusCode >= 200 && checkRes.statusCode < 300) {
        forkReady = true;
        break;
      }
      if (this.forkPollIntervalMs > 0 && attempt + 1 < this.forkPollAttempts) {
        await defaultSleep(this.forkPollIntervalMs * (attempt + 1));
      }
    }

    if (!forkReady) {
      throw new Error(`Timed out waiting for fork '${forked.full_name}' to become ready on GitHub.`);
    }

    return {
      owner: forked.owner.login,
      name: forked.name,
      fullName: forked.full_name,
      defaultBranch: forked.default_branch || upstream.defaultBranch,
      htmlUrl: forked.html_url,
      cloneUrl: forked.clone_url,
      sshUrl: forked.ssh_url,
      upstreamFullName: upstream.fullName
    };
  }

  public async createPullRequest(input: CreatePullRequestInput): Promise<HubPullRequestInfo> {
    const res = await this.request(
      `/repos/${encodeURIComponent(input.upstreamOwner)}/${encodeURIComponent(input.upstreamRepo)}/pulls`,
      'POST',
      {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: Boolean(input.draft)
      }
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const errText = new TextDecoder().decode(res.body);
      throw new Error(`Failed to create Pull Request (HTTP ${res.statusCode}): ${errText}`);
    }
    const pr = decodeJson<{
      number: number;
      title: string;
      html_url: string;
      state: 'open' | 'closed';
      draft?: boolean;
      merged?: boolean;
      updated_at: string;
      head: { ref: string };
      base: { ref: string };
    }>(res);

    return {
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      state: pr.merged ? 'merged' : pr.state,
      draft: Boolean(pr.draft),
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      upstreamFullName: `${input.upstreamOwner}/${input.upstreamRepo}`,
      updatedAt: pr.updated_at
    };
  }

  public async findPullRequestsForBranch(
    upstreamOwner: string,
    upstreamRepo: string,
    headFilter: string
  ): Promise<HubPullRequestInfo[]> {
    const res = await this.request(
      `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls?state=all&head=${encodeURIComponent(headFilter)}`
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return [];
    }
    const items = decodeJson<{
      number: number;
      title: string;
      html_url: string;
      state: 'open' | 'closed';
      draft?: boolean;
      merged_at?: string | null;
      updated_at: string;
      head: { ref: string };
      base: { ref: string };
    }[]>(res);

    return items.map((pr) => ({
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      state: pr.merged_at ? 'merged' : pr.state,
      draft: Boolean(pr.draft),
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      upstreamFullName: `${upstreamOwner}/${upstreamRepo}`,
      updatedAt: pr.updated_at
    }));
  }

  public async getPullRequestStatus(
    upstreamOwner: string,
    upstreamRepo: string,
    pullNumber: number
  ): Promise<HubPullRequestInfo> {
    const res = await this.request(
      `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/pulls/${pullNumber}`
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Failed to fetch Pull Request #${pullNumber} (HTTP ${res.statusCode}).`);
    }
    const pr = decodeJson<{
      number: number;
      title: string;
      html_url: string;
      state: 'open' | 'closed';
      draft?: boolean;
      merged?: boolean;
      merged_at?: string | null;
      updated_at: string;
      head: { ref: string; sha: string };
      base: { ref: string };
    }>(res);

    let checks: HubPullRequestCheckSummary | undefined;
    if (pr.head?.sha) {
      const checksRes = await this.request(
        `/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}/commits/${encodeURIComponent(pr.head.sha)}/check-runs?per_page=100`
      );
      if (checksRes.statusCode >= 200 && checksRes.statusCode < 300) {
        const checkData = decodeJson<{
          total_count: number;
          check_runs: { status: string; conclusion: string | null }[];
        }>(checksRes);
        const runs = checkData.check_runs ?? [];
        const totalCount = typeof checkData.total_count === 'number'
          ? Math.max(checkData.total_count, runs.length)
          : runs.length;
        const unfetchedCount = Math.max(0, totalCount - runs.length);
        let passingCount = 0;
        let failingCount = 0;
        let pendingCount = unfetchedCount;
        for (const run of runs) {
          if (run.status !== 'completed') {
            pendingCount++;
          } else if (run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral') {
            passingCount++;
          } else {
            failingCount++;
          }
        }
        let state: HubPullRequestCheckSummary['state'] = 'none';
        if (totalCount > 0) {
          if (failingCount > 0) {
            state = 'failure';
          } else if (pendingCount > 0) {
            state = 'pending';
          } else {
            state = 'success';
          }
        }
        checks = {
          state,
          totalCount,
          passingCount,
          failingCount,
          pendingCount
        };
      }
    }

    return {
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      state: pr.merged || pr.merged_at ? 'merged' : pr.state,
      draft: Boolean(pr.draft),
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      upstreamFullName: `${upstreamOwner}/${upstreamRepo}`,
      updatedAt: pr.updated_at,
      checks
    };
  }

  public async resolveAccessibleAccount(
    upstreamOwner: string,
    upstreamRepo: string,
    options?: {
      host?: string;
      switchActive?: boolean;
      preferredLogin?: string;
    }
  ): Promise<GitHubAccountResolution> {
    const host = options?.host ?? 'github.com';

    // When a primary TokenProvider (e.g. VS Code's native GitHub session) is
    // configured and no explicit CLI login override was requested, verify
    // whether that primary token already has access before probing `gh` CLI.
    if (this.options.tokenProvider && !options?.preferredLogin) {
      const primaryToken = await this.options.tokenProvider.getToken(host);
      if (primaryToken) {
        try {
          const checkRes = await this.http.fetch({
            url: `${this.baseUrl}/repos/${encodeURIComponent(upstreamOwner)}/${encodeURIComponent(upstreamRepo)}`,
            method: 'GET',
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': this.userAgent,
              Authorization: `Bearer ${primaryToken}`
            }
          });
          if (checkRes.statusCode >= 200 && checkRes.statusCode < 300) {
            this.selectedAccountToken = undefined;
            return {
              accounts: [],
              accessibleAccounts: []
            };
          }
        } catch {
          // Fall through to accountManager if primary token check fails
        }
      }
    }

    if (!this.options.accountManager) {
      return {
        accounts: [],
        accessibleAccounts: []
      };
    }

    const resolution = await this.options.accountManager.probeAndSelectAccount(
      upstreamOwner,
      upstreamRepo,
      options
    );
    if (resolution.selectedToken) {
      this.selectedAccountToken = resolution.selectedToken;
    }
    return {
      selectedAccount: resolution.selectedAccount,
      switchedFromAccount: resolution.switchedFromAccount,
      accounts: resolution.accounts,
      accessibleAccounts: resolution.accessibleAccounts,
      message: resolution.message
    };
  }
}
