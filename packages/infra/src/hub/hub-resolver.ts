/**
 * HubResolver — fetch a `HubConfig` from a `HubReference`.
 *
 * Faithfully ports the extension's `HubManager` fetch behavior
 * (`fetchFromLocal`/`fetchFromUrl`/`fetchFromGitHub`/
 * `getAuthenticationToken`), adapted to the `FileSystem`/`HttpClient`/
 * `TokenProvider` ports so it is testable and delivery-context-agnostic.
 *
 * Deliberately diverges from the reference branch's own `HubResolver`
 * (GitHub Contents API + `Bearer` auth): the extension fetches
 * `hub-config.yml` straight from `raw.githubusercontent.com` (with a
 * cache-busting query param) using the legacy `token <PAT>` header,
 * and existing tests (`test/services/hub-manager.test.ts`) assert on
 * that exact URL shape via `nock`, including 301/302 redirects.
 * `NodeHttpClient` already follows those redirects, so no manual
 * redirect loop is needed here (unlike the extension's own hand-rolled
 * version).
 * @module hub/hub-resolver
 */
import type {
  FileSystem,
  GitHubRepositoryTarget,
  HttpClient,
  HubConfig,
  HubReference,
  TokenProvider,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  isGitHubHost,
} from '../http/github-host';
import {
  parseGitHubRepositoryTarget,
} from '../http/github-repository-target';

const GIT_SSH_PATTERN = /^git@([^:]+):(.+)$/u;

/**
 * Normalize a `github`-type hub location that may be a bare `owner/repo`
 * slug or a full repository/file URL (e.g. a `/blob/<ref>/hub-config.yml`
 * link copied from the GitHub UI, or an SSH clone URL) into the
 * `owner/repo` slug the raw-content fetch expects. A branch/tag/commit
 * carried by a `/blob/<ref>/...` or `/tree/<ref>` URL is used as the
 * fallback `ref` only when the caller didn't already supply one
 * explicitly. Bare slugs are returned unchanged, preserving existing
 * behavior.
 * @param location Raw location as entered by the user (slug or URL).
 * @param explicitRef `ref` already set on the reference, if any — always wins over a URL-derived branch.
 * @returns Normalized `owner/repo` slug and the resolved branch/tag/commit ref.
 */
export function normalizeGitHubHubLocation(
  location: string,
  explicitRef?: string
): { location: string; ref?: string } {
  const sshMatch = GIT_SSH_PATTERN.exec(location);
  let url: URL | undefined;
  try {
    if (sshMatch !== null) {
      url = new URL(`https://${sshMatch[1]}/${sshMatch[2]}`);
    } else if (location.includes('://')) {
      url = new URL(location);
    }
  } catch {
    return { location, ref: explicitRef };
  }

  if (url === undefined || !isGitHubHost(url.hostname.toLowerCase())) {
    return { location, ref: explicitRef };
  }

  const segments = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
  if (segments.length < 2 || segments[0].length === 0 || segments[1].length === 0) {
    return { location, ref: explicitRef };
  }

  const [owner, repoSegment, kind, refSegment] = segments;
  const repository = repoSegment.endsWith('.git') ? repoSegment.slice(0, -4) : repoSegment;
  const normalizedLocation = `${owner}/${repository}`;

  if ((kind === 'blob' || kind === 'tree') && refSegment !== undefined && refSegment.length > 0) {
    return { location: normalizedLocation, ref: explicitRef ?? refSegment };
  }

  return { location: normalizedLocation, ref: explicitRef };
}

export interface ResolvedHub {
  config: HubConfig;
  reference: HubReference;
}

/**
 * Common interface implemented by every per-type hub resolver.
 */
export interface HubResolver {
  /**
   * Fetch the hub config pointed to by the reference.
   * @param ref The hub reference.
   * @returns Resolved config + the (unmodified) reference.
   */
  resolve(ref: HubReference): Promise<ResolvedHub>;
}

export interface GitHubHubResolverOptions {
  /** Use generic public auth first, with an App-only retry for private hubs. */
  sourceAware?: {
    genericTokenProvider?: TokenProvider;
    appTokenProvider?: TokenProvider;
  };
}

/**
 * Shared GET-and-parse-YAML logic for the `url`/`github` resolvers,
 * mirroring the extension's `fetchFromUrl` (minus manual redirect
 * handling, which `HttpClient` already provides).
 * @param http HttpClient to fetch with.
 * @param tokens TokenProvider consulted for the target host.
 * @param url Absolute URL to GET.
 * @param repositoryTarget
 * @param requireToken
 */
async function fetchYamlConfig(
  http: HttpClient,
  tokens: TokenProvider | undefined,
  url: string,
  repositoryTarget?: GitHubRepositoryTarget,
  requireToken = false
): Promise<HubConfig> {
  const headers: Record<string, string> = {};
  const token = await tokens?.getToken(new URL(url).hostname, repositoryTarget);
  if (token === undefined && requireToken) {
    throw Object.assign(
      new Error('A generic GitHub token is required to fetch a hub configuration.'),
      { code: 'GH_PUBLIC_GENERIC_TOKEN_UNAVAILABLE' }
    );
  }
  if (token !== undefined) {
    headers.Authorization = `token ${token}`;
  }

  const res = await http.fetch({ url, headers, maxRedirects: 10 });
  if (res.statusCode !== 200) {
    throw new Error(`Failed to fetch hub config: HTTP ${res.statusCode}`);
  }

  const text = new TextDecoder().decode(res.body);
  try {
    return yaml.load(text) as HubConfig;
  } catch (error) {
    throw new Error(`Failed to parse hub config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolves `local` references by reading the referenced file
 * directly — the extension treats `location` as a direct file path,
 * not a directory to search.
 */
export class LocalHubResolver implements HubResolver {
  /**
   * Construct a LocalHubResolver instance.
   * @param fs Filesystem abstraction.
   */
  public constructor(private readonly fs: FileSystem) {}

  /**
   * Read and parse the hub config YAML at `ref.location`.
   * @param ref Hub reference (`type: 'local'`).
   * @returns Resolved hub.
   */
  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    if (!(await this.fs.exists(ref.location))) {
      throw new Error(`File not found: ${ref.location}`);
    }
    try {
      const content = await this.fs.readFile(ref.location);
      return { config: yaml.load(content) as HubConfig, reference: ref };
    } catch (error) {
      throw new Error(`Failed to load hub config from ${ref.location}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Resolves `url` references via a plain GET (redirects handled by
 * the injected `HttpClient`).
 */
export class UrlHubResolver implements HubResolver {
  /**
   * Construct a UrlHubResolver instance.
   * @param http HttpClient for the GET request.
   * @param tokens TokenProvider for hosts that need auth.
   */
  public constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenProvider
  ) {}

  /**
   * GET `ref.location` and parse the body as a HubConfig YAML.
   * @param ref Hub reference (`type: 'url'`).
   * @returns Resolved hub.
   */
  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    const config = await fetchYamlConfig(this.http, this.tokens, ref.location);
    return { config, reference: ref };
  }
}

/**
 * Resolves `github` references against `raw.githubusercontent.com`
 * (mirrors the extension's `fetchFromGitHub`), including a
 * cache-busting query param so edits are visible immediately after a
 * push. `ref.ref` defaults to `main`.
 */
export class GitHubHubResolver implements HubResolver {
  /**
   * Construct a GitHubHubResolver instance.
   * @param http HttpClient for the GET request.
   * @param tokens TokenProvider for private repos.
   * @param options
   */
  public constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenProvider,
    private readonly options: GitHubHubResolverOptions = {}
  ) {}

  /**
   * Fetch `hub-config.yml` from the repo's raw content host.
   * @param ref Hub reference (`type: 'github'`).
   * @returns Resolved hub.
   */
  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    const { location, ref: normalizedRef } = normalizeGitHubHubLocation(ref.location, ref.ref);
    const branch = normalizedRef ?? 'main';
    const timestamp = Date.now();
    const url = `https://raw.githubusercontent.com/${location}/${branch}/hub-config.yml?t=${timestamp}`;
    const repositoryTarget = parseGitHubRepositoryTarget(location);
    if (this.options.sourceAware === undefined) {
      const config = await fetchYamlConfig(this.http, this.tokens, url, repositoryTarget);
      return { config, reference: ref };
    }
    try {
      const config = await fetchYamlConfig(
        this.http,
        this.options.sourceAware.genericTokenProvider,
        url,
        repositoryTarget,
        true
      );
      return { config, reference: ref };
    } catch (error) {
      if (this.options.sourceAware.appTokenProvider === undefined || !isAuthenticationFailure(error)) {
        throw error;
      }
      const config = await fetchYamlConfig(
        this.http,
        this.options.sourceAware.appTokenProvider,
        url,
        repositoryTarget
      );
      return { config, reference: ref };
    }
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/rate.?limit|too many requests|retry-after/u.test(message)) {
    return false;
  }
  return /\b401\b|\b403\b|\b404\b|authentication failed|access forbidden|not accessible/u.test(message);
}

/**
 * Type-dispatching wrapper over the three concrete resolvers.
 * Delegates to the appropriate resolver based on the reference type.
 */
export class CompositeHubResolver implements HubResolver {
  /**
   * Construct a CompositeHubResolver instance.
   * @param github Resolver for `github` references.
   * @param local Resolver for `local` references.
   * @param url Resolver for `url` references.
   */
  public constructor(
    private readonly github: HubResolver,
    private readonly local: HubResolver,
    private readonly url: HubResolver
  ) {}

  /**
   * Dispatch by `ref.type` to the appropriate concrete resolver.
   * @param ref Hub reference.
   * @returns Resolved hub.
   */
  public resolve(ref: HubReference): Promise<ResolvedHub> {
    if (ref.type === 'github') {
      return this.github.resolve(ref);
    }
    if (ref.type === 'local') {
      return this.local.resolve(ref);
    }
    return this.url.resolve(ref);
  }
}
