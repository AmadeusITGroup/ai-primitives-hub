import type {
  GitHubApi,
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HubSourceSpec,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createGitHubSourceAuthRuntime,
} from '../../src/harvest/github-source-auth-runtime';
import {
  preflightGitHubSources,
} from '../../src/harvest/github-source-preflight';

class ScenarioApi implements GitHubApi {
  public readonly calls: string[] = [];

  public constructor(
    private readonly failurePath?: string,
    private readonly failure?: Error,
    private readonly repositoryMetadata: unknown = {}
  ) {}

  public async getJson<T>(path: string): Promise<T> {
    this.calls.push(path);
    if (this.failure !== undefined && path === this.failurePath) {
      throw this.failure;
    }
    if (path.includes('/commits/')) {
      return { sha: 'preflight-commit-sha' } as T;
    }
    if (path.startsWith('/repos/') && path.split('/').length === 4) {
      return this.repositoryMetadata as T;
    }
    return {} as T;
  }

  public async getText(path: string): Promise<string> {
    this.calls.push(path);
    return '';
  }

  public async download(path: string): Promise<Uint8Array> {
    this.calls.push(path);
    return new Uint8Array();
  }

  public async getJsonWithEtag<T>(): Promise<{ status: 'ok'; value: T; etag: undefined }> {
    return { status: 'ok', value: {} as T, etag: undefined };
  }
}

class StubTokenProvider implements TokenProvider {
  public calls = 0;

  public async getToken(): Promise<string | undefined> {
    this.calls += 1;
    return 'generic-token';
  }
}

function source(id: string, owner: string, repo: string, type: HubSourceSpec['type'] = 'github'): HubSourceSpec {
  return {
    id,
    name: id,
    type,
    url: `https://github.com/${owner}/${repo}`,
    owner,
    repo,
    branch: 'main'
  };
}

function targetFor(sourceSpec: HubSourceSpec): GitHubRepositoryTarget {
  return { host: 'github.com', owner: sourceSpec.owner, repository: sourceSpec.repo };
}

describe('preflightGitHubSources', () => {
  it('uses a generic credential for public sources without constructing an anonymous client', async () => {
    const genericTokenProvider = new StubTokenProvider();
    const categories: GitHubSourceAuthCategory[] = [];

    const report = await preflightGitHubSources([source('public', 'org', 'repo')], {
      genericTokenProvider,
      clientFactory: (_target, category) => {
        categories.push(category);
        if (category === 'public-anonymous') {
          throw new Error('anonymous GitHub access is forbidden in source-aware mode');
        }
        return new ScenarioApi(undefined, undefined, { private: false });
      }
    });

    expect(report.valid).toBe(true);
    expect(report.results[0]).toMatchObject({
      category: 'public-generic',
      credentialMode: 'generic'
    });
    expect(categories).toEqual(['public-generic']);
    expect(genericTokenProvider.calls).toBe(1);
  });

  it('fails closed when no generic public credential is available without attempting anonymous access', async () => {
    const categories: GitHubSourceAuthCategory[] = [];
    const genericTokenProvider: TokenProvider = {
      getToken: async () => undefined
    };

    const report = await preflightGitHubSources([source('public', 'org', 'repo')], {
      genericTokenProvider,
      clientFactory: (_target, category) => {
        categories.push(category);
        throw new Error('a GitHub client must not be constructed without a generic token');
      }
    });

    expect(report.valid).toBe(false);
    expect(report.results[0]).toMatchObject({
      category: 'unresolved',
      errorCode: 'GH_PUBLIC_GENERIC_TOKEN_UNAVAILABLE'
    });
    expect(categories).toEqual([]);
  });

  it('does not bypass the mandatory generic credential when an App provider is available', async () => {
    const categories: GitHubSourceAuthCategory[] = [];
    const genericTokenProvider: TokenProvider = {
      getToken: async () => undefined
    };

    const report = await preflightGitHubSources([source('private', 'org', 'repo')], {
      genericTokenProvider,
      appTokenProvider: { getToken: async () => 'app-token' },
      clientFactory: (_target, category) => {
        categories.push(category);
        throw new Error('App access must not bypass generic visibility evidence');
      }
    });

    expect(report.valid).toBe(false);
    expect(report.results[0]).toMatchObject({
      category: 'unresolved',
      errorCode: 'GH_PUBLIC_GENERIC_TOKEN_UNAVAILABLE'
    });
    expect(categories).toEqual([]);
  });

  it('classifies all sources from authenticated evidence and derives routes only for private candidates', async () => {
    const publicSource = source('z-public', 'z-org', 'public');
    const privateSource = source('a-private', 'a-org', 'private');
    const unresolvedSource = source('m-unresolved', 'm-org', 'unresolved');
    const appApi = new ScenarioApi();
    const clients: { category: GitHubSourceAuthCategory; target: GitHubRepositoryTarget }[] = [];

    const report = await preflightGitHubSources(
      [publicSource, privateSource, unresolvedSource],
      {
        clientFactory: (target, category) => {
          clients.push({ target, category });
          if (target.repository === 'private' && category === 'public-generic') {
            return new ScenarioApi('/repos/a-org/private', Object.assign(new Error('GitHub API error: 404'), { statusCode: 404 }));
          }
          if (target.repository === 'unresolved' && category === 'public-generic') {
            return new ScenarioApi('/repos/m-org/unresolved', Object.assign(new Error('GitHub API error: 503'), { statusCode: 503 }));
          }
          if (category === 'public-generic') {
            return new ScenarioApi(undefined, undefined, { private: false });
          }
          return appApi;
        },
        genericTokenProvider: new StubTokenProvider(),
        appTokenProvider: { getToken: async () => 'app-token' }
      }
    );

    expect(report.valid).toBe(false);
    expect(report.results.map((result) => [result.sourceId, result.category])).toEqual([
      ['a-private', 'app-authenticated'],
      ['m-unresolved', 'unresolved'],
      ['z-public', 'public-generic']
    ]);
    expect(report.appRoutes).toEqual(['github.com/a-org/*']);
    expect(clients).toContainEqual({ target: targetFor(privateSource), category: 'app-authenticated' });
    expect(report.results.find((result) => result.sourceId === 'm-unresolved')?.errorCode).toBe('GH_SOURCE_PREFLIGHT_UNRESOLVED');
    expect(report.results.find((result) => result.sourceId === 'z-public')?.revision).toBe('preflight-commit-sha');
  });

  it('derives App routes before invoking the setup hook', async () => {
    const privateSource = source('private', 'Org', 'repo');
    const order: string[] = [];

    const report = await preflightGitHubSources([privateSource], {
      clientFactory: (_target, category) => {
        order.push(`client:${category}`);
        return category === 'public-generic'
          ? new ScenarioApi('/repos/Org/repo', Object.assign(new Error('GitHub API error: 404'), { statusCode: 404 }))
          : new ScenarioApi();
      },
      genericTokenProvider: new StubTokenProvider(),
      appTokenProvider: { getToken: async () => 'app-token' },
      prepareAppAuthentication: async (routes) => {
        order.push(`setup:${routes.join(',')}`);
      }
    });

    expect(report.valid).toBe(true);
    expect(report.appRoutes).toEqual(['github.com/Org/*']);
    expect(order).toEqual([
      'client:public-generic',
      'setup:github.com/Org/*',
      'client:app-authenticated'
    ]);
  });

  it('uses the generic provider for public visibility and source checks', async () => {
    const publicSource = source('public', 'org', 'repo', 'awesome-copilot');
    const genericTokenProvider = new StubTokenProvider();
    const categories: GitHubSourceAuthCategory[] = [];
    const clients = new Map<GitHubSourceAuthCategory, ScenarioApi>();

    const report = await preflightGitHubSources([publicSource], {
      publicAuthMode: 'generic',
      genericTokenProvider,
      clientFactory: (_target, category) => {
        categories.push(category);
        const api = clients.get(category) ?? new ScenarioApi();
        if (category === 'public-generic' && api.calls.length === 0) {
          return new ScenarioApi(undefined, undefined, { private: false });
        }
        clients.set(category, api);
        return api;
      }
    });

    expect(report.valid).toBe(true);
    expect(report.results[0]?.category).toBe('public-generic');
    expect(categories).toEqual(['public-generic']);
    expect(genericTokenProvider.calls).toBe(1);
  });

  it('fails an authentication-required source when no App provider is available', async () => {
    const privateSource = source('private', 'org', 'private');
    const report = await preflightGitHubSources([privateSource], {
      genericTokenProvider: new StubTokenProvider(),
      clientFactory: (target, category) => category === 'public-generic'
        ? new ScenarioApi('/repos/org/private', Object.assign(new Error('GitHub API error: 404'), { statusCode: 404 }))
        : new ScenarioApi(),
      onLog: () => undefined
    });

    expect(report.valid).toBe(false);
    expect(report.results[0]).toMatchObject({
      sourceId: 'private',
      category: 'unresolved',
      errorCode: 'GH_APP_AUTH_CONFIG_MISSING'
    });
  });

  it('rejects explicit anonymous mode before making a request', async () => {
    expect(() => createGitHubSourceAuthRuntime({
      env: { AI_PRIMITIVES_HUB_GH_PUBLIC_AUTH_MODE: 'anonymous' },
      http: {} as never
    })).toThrowError(expect.objectContaining({ code: 'GH_PUBLIC_ANONYMOUS_DISABLED' }));
  });

  it('uses generic public authentication for every public source by default', async () => {
    const sources = Array.from({ length: 20 }, (_, index) => source(
      `source-${String(index).padStart(2, '0')}`,
      'org',
      `repo-${String(index).padStart(2, '0')}`
    ));
    const genericTokenProvider = new StubTokenProvider();
    const categories: GitHubSourceAuthCategory[] = [];
    const report = await preflightGitHubSources(sources, {
      genericTokenProvider,
      clientFactory: (_target, category) => {
        categories.push(category);
        return new ScenarioApi(undefined, undefined, { private: false });
      }
    });

    expect(report.valid).toBe(true);
    expect(report.results.every((result) => result.category === 'public-generic')).toBe(true);
    expect(categories.filter((category) => category === 'public-generic')).toHaveLength(20);
    expect(genericTokenProvider.calls).toBe(20);
  });

  it('reuses generic visibility evidence for duplicate source entries targeting one repository', async () => {
    const apis: ScenarioApi[] = [];
    const report = await preflightGitHubSources([
      source('first-entry', 'org', 'repo'),
      source('second-entry', 'org', 'repo')
    ], {
      clientFactory: () => {
        const api = new ScenarioApi(undefined, undefined, { private: false });
        apis.push(api);
        return api;
      },
      genericTokenProvider: new StubTokenProvider()
    });

    const metadataCalls = apis.flatMap((api) => api.calls)
      .filter((path) => path === '/repos/org/repo');
    expect(report.valid).toBe(true);
    expect(metadataCalls).toHaveLength(1);
  });

  it('uses generic metadata to establish public repository visibility', async () => {
    const genericTokenProvider = new StubTokenProvider();
    const categories: GitHubSourceAuthCategory[] = [];
    const report = await preflightGitHubSources([source('public', 'org', 'repo')], {
      genericTokenProvider,
      clientFactory: (_target, category) => {
        categories.push(category);
        expect(category).toBe('public-generic');
        return new ScenarioApi(undefined, undefined, { private: false });
      }
    });

    expect(report).toMatchObject({
      valid: true,
      results: [{ category: 'public-generic' }]
    });
    expect(categories).toEqual(['public-generic']);
    expect(genericTokenProvider.calls).toBe(1);
  });

  it('routes a generic metadata response marked private to the App path', async () => {
    const genericTokenProvider = new StubTokenProvider();
    const appTokenProvider: TokenProvider = { getToken: async () => 'app-token' };
    const categories: GitHubSourceAuthCategory[] = [];
    const report = await preflightGitHubSources([source('private', 'org', 'repo')], {
      genericTokenProvider,
      appTokenProvider,
      clientFactory: (_target, category) => {
        categories.push(category);
        return category === 'public-generic'
          ? new ScenarioApi(undefined, undefined, { private: true })
          : new ScenarioApi();
      },
      prepareAppAuthentication: async () => undefined
    });

    expect(report.valid).toBe(true);
    expect(report.results[0]).toMatchObject({ category: 'app-authenticated' });
    expect(report.appRoutes).toEqual(['github.com/org/*']);
    expect(categories).toEqual(['public-generic', 'app-authenticated']);
  });

  it('stops generic probes after the first rate-limit response', async () => {
    const rateLimitError = Object.assign(new Error('GitHub API error: 403 - primary rate limit exceeded'), {
      statusCode: 403,
      headers: { 'x-ratelimit-remaining': '0' }
    });
    const apis: ScenarioApi[] = [];
    const report = await preflightGitHubSources([
      source('first', 'org', 'first'),
      source('second', 'org', 'second'),
      source('third', 'org', 'third')
    ], {
      genericTokenProvider: new StubTokenProvider(),
      clientFactory: () => {
        const api = new ScenarioApi('/repos/org/first', rateLimitError);
        apis.push(api);
        return api;
      }
    });

    expect(report.valid).toBe(false);
    expect(report.results).toHaveLength(3);
    expect(report.results.every((result) => result.errorCode === 'GH_PUBLIC_GENERIC_RATE_LIMIT_UNSAFE')).toBe(true);
    expect(apis).toHaveLength(1);
    expect(apis[0].calls).toEqual(['/repos/org/first']);
  });
});
