/**
 * HubResolver (fetch a HubConfig from a HubReference).
 *
 * Three impls:
 *   - GitHubHubResolver  fetches a `hub-config.yml` from a github
 *                        repo via the contents API (no clone).
 *   - LocalHubResolver   reads the YAML from a local file path.
 *   - UrlHubResolver     fetches over plain HTTPS (no auth, no
 *                        redirects beyond what HttpClient supports).
 *
 * All three return `{ config, reference }` and never write to disk
 * — persistence is the HubStore's job.
 */
import * as path from 'node:path';
import {
  type FileSystem,
  type HttpClient,
  type HubConfig,
  type HubReference,
  isHubConfig,
  type TokenProvider,
} from '@prompt-registry/core';
import * as yaml from 'js-yaml';

export interface ResolvedHub {
  config: HubConfig;
  reference: HubReference;
}

/**
 * Common interface implemented by every per-type resolver.
 * Fetches the hub config pointed to by a HubReference.
 */
export interface HubResolver {
  /**
   * Fetch the hub config pointed to by the reference.
   * @param ref The hub reference.
   * @returns Resolved config + the reference (may be normalized).
   */
  resolve(ref: HubReference): Promise<ResolvedHub>;
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

/**
 * Resolves `local` references against an FsAbstraction.
 * Reads a `hub-config.yml` from a local path.
 */
export class LocalHubResolver implements HubResolver {
  /**
   * Construct a LocalHubResolver instance.
   * @param fs Filesystem abstraction.
   */
  public constructor(private readonly fs: FileSystem) {}

  private async findConfig(location: string): Promise<string> {
    if (await this.fs.exists(location)) {
      // If directory, look for hub-config.yml inside.
      const direct = path.join(location, 'hub-config.yml');
      if (await this.fs.exists(direct)) {
        return direct;
      }
      return location;
    }
    throw new Error(`Local hub path not found: ${location}`);
  }

  /**
   * Read a `hub-config.yml` from a local path. The path may point
   * directly at the file or at a directory containing one.
   * @param ref Hub reference (`type: 'local'`).
   * @returns Resolved hub.
   */
  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    const cfgPath = await this.findConfig(ref.location);
    const text = await this.fs.readFile(cfgPath);
    const parsed = yaml.load(text);
    if (!isHubConfig(parsed)) {
      throw new Error(`Hub config malformed at ${cfgPath}`);
    }
    return { config: parsed, reference: { ...ref, location: cfgPath } };
  }
}

/**
 * Resolves `github` references via the GitHub Contents API.
 * Supports the `owner/repo` location with optional `ref` (branch
 * or tag), looking for `hub-config.yml` at the repo root.
 */
export class GitHubHubResolver {
  /**
   * Construct a GitHubHubResolver instance.
   * @param http HttpClient for the contents API.
   * @param tokens TokenProvider for private repos.
   * @param apiBase Override (typically for GHES).
   */
  public constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenProvider,
    private readonly apiBase = 'https://api.github.com'
  ) {}

  /**
   * Fetch and parse the hub config from `<apiBase>/repos/<location>/contents/hub-config.yml`.
   * @param ref Hub reference (`type: 'github'`).
   * @returns Resolved hub.
   */
  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    const repoSlug = ref.location;
    const branchPart = ref.ref !== undefined && ref.ref.length > 0
      ? `?ref=${encodeURIComponent(ref.ref)}`
      : '';
    const url = `${this.apiBase}/repos/${repoSlug}/contents/hub-config.yml${branchPart}`;
    const host = new URL(this.apiBase).hostname;
    const token = await this.tokens.getToken(host);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.raw',

      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await this.http.fetch({ url, headers });
    if (res.statusCode === 404) {
      const authHint = token === null
        ? 'no token — private repos require authentication via `gh auth login`'
        : 'your token may not have read access to this repository — run `gh auth status` to check the active account';
      throw new Error(`hub-config.yml not found at ${repoSlug} (${authHint})`);
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new Error(`Authentication failed for ${repoSlug} — check GitHub token permissions`);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`GitHub API ${String(res.statusCode)} for ${url}`);
    }
    const text = new TextDecoder().decode(res.body);
    const parsed = yaml.load(text);
    if (!isHubConfig(parsed)) {
      throw new Error(`Hub config malformed at ${url}`);
    }
    return { config: parsed, reference: ref };
  }
}

/**
 * Resolves `url` references via a plain HTTPS GET.
 * Fetches and parses the body as a HubConfig YAML/JSON.
 */
export class UrlHubResolver implements HubResolver {
  /**
   * Construct a UrlHubResolver instance.
   * @param http HttpClient.
   * @param tokens TokenProvider (used only when the URL host has a token).
   */
  public constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenProvider
  ) {}

  /**
   * GET the URL and parse the body as a HubConfig YAML/JSON.
   * @param ref Hub reference (`type: 'url'`).
   * @returns Resolved hub.
   */
  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    const u = new URL(ref.location);
    const token = await this.tokens.getToken(u.hostname);
    const headers: Record<string, string> = { Accept: 'text/yaml, text/plain, application/octet-stream' };
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await this.http.fetch({ url: ref.location, headers });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`URL ${String(res.statusCode)} for ${ref.location}`);
    }
    const text = new TextDecoder().decode(res.body);
    const parsed = yaml.load(text);
    if (!isHubConfig(parsed)) {
      throw new Error(`Hub config malformed at ${ref.location}`);
    }
    return { config: parsed, reference: ref };
  }
}
