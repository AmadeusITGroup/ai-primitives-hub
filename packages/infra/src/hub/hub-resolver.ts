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
  HttpClient,
  HubConfig,
  HubReference,
  OnLogEvent,
  ResolvedToken,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  RegistryError,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  formatCredential,
} from '../auth/format-token-origin';
import type {
  GitHubTokenReport,
} from '../auth/github-token-diagnostics';
import {
  diagnoseGitHubToken,
  formatGitHubTokenReport,
} from '../auth/github-token-diagnostics';

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

/**
 * Pick the error code that names the root cause, from facts rather than
 * from the (uninformative) status of the failing request.
 *
 * Callers classify on `code`, never by matching the message text.
 * @param report - Credential diagnosis from `api.github.com`.
 * @returns A `RegistryError` code.
 */
function classifyCredentialFailure(report: GitHubTokenReport): string {
  if (report.error !== undefined) {
    // Could not even reach api.github.com: network/proxy, not access.
    return 'HUB.FETCH_FAILED';
  }
  if (report.userStatus === 401) {
    return 'AUTH.TOKEN_REJECTED';
  }
  if (report.userStatus !== 200) {
    return 'HUB.FETCH_FAILED';
  }
  if (report.sso !== undefined) {
    return 'AUTH.SSO_REQUIRED';
  }
  const scopes = (report.scopes ?? '').split(',').map((scope) => scope.trim());
  if (!scopes.includes('repo')) {
    return 'AUTH.MISSING_SCOPE';
  }
  // Valid credential, right scopes, still cannot see the repository: this
  // account simply has no access to it.
  return 'AUTH.NO_REPO_ACCESS';
}

/**
 * Shared GET-and-parse-YAML logic for the `url`/`github` resolvers,
 * mirroring the extension's `fetchFromUrl` (minus manual redirect
 * handling, which `HttpClient` already provides).
 *
 * Exactly **one** authenticated request is made. There is deliberately no
 * anonymous retry: `raw.githubusercontent.com` answers 404 (never
 * 401/403) when GitHub rejects the attached credential, so a fallback
 * would serve public hubs while hiding the very credential fault the
 * caller needs to see, and would still fail on every private hub. When a
 * credential was attached and the fetch failed, the credential is
 * diagnosed against `api.github.com` and the result is thrown as a
 * `RegistryError` whose code names the cause.
 * @param http HttpClient to fetch with.
 * @param tokens TokenProvider consulted for the target host.
 * @param url Absolute URL to GET.
 * @param opts Diagnostics context: `repoLocation` (`owner/repo`) narrows
 * the diagnosis to repository access, `onLog` receives the warn line.
 * @param opts.repoLocation
 * @param opts.onLog
 */
async function fetchYamlConfig(
  http: HttpClient,
  tokens: TokenProvider,
  url: string,
  opts: { repoLocation?: string; onLog?: OnLogEvent } = {}
): Promise<HubConfig> {
  const headers: Record<string, string> = {};
  const credential = await tokens.getToken(new URL(url).hostname);
  if (credential !== undefined) {
    headers.Authorization = `token ${credential.token}`;
  }

  const res = await http.fetch({ url, headers, maxRedirects: 10 });
  if (res.statusCode !== 200) {
    throw await hubFetchError(http, url, res.statusCode, credential, opts);
  }

  const text = new TextDecoder().decode(res.body);
  try {
    return yaml.load(text) as HubConfig;
  } catch (error) {
    throw new Error(`Failed to parse hub config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Build the error for a failed hub-config fetch, diagnosing the
 * credential first when one was attached.
 * @param http HttpClient used for the diagnosis probes.
 * @param url The URL that failed.
 * @param status Status it answered with.
 * @param credential Credential that was attached, if any.
 * @param opts Diagnostics context (`repoLocation`, `onLog`).
 * @param opts.repoLocation
 * @param opts.onLog
 * @returns The `RegistryError` to throw.
 */
async function hubFetchError(
  http: HttpClient,
  url: string,
  status: number,
  credential: ResolvedToken | undefined,
  opts: { repoLocation?: string; onLog?: OnLogEvent }
): Promise<RegistryError> {
  const baseMessage = `Failed to fetch hub config: HTTP ${String(status)}`;
  if (credential === undefined) {
    const anonymousMessage = `${baseMessage} (${url}) [${formatCredential(undefined)}]`;
    opts.onLog?.({ level: 'warn', message: anonymousMessage });
    return new RegistryError({
      code: 'HUB.FETCH_FAILED',
      message: anonymousMessage,
      hint: 'No credential was attached. A private hub is indistinguishable from a missing one here; sign in to GitHub and retry.',
      context: { url, repoLocation: opts.repoLocation, status, origin: formatCredential(undefined) }
    });
  }

  const report = await diagnoseGitHubToken(http, credential.token, opts.repoLocation);
  const message = `${baseMessage} (${url}) [${formatCredential(credential)}] ${formatGitHubTokenReport(report)}`;
  opts.onLog?.({ level: 'warn', message });
  return new RegistryError({
    code: classifyCredentialFailure(report),
    message,
    hint: report.verdict,
    context: {
      url,
      repoLocation: opts.repoLocation,
      status,
      origin: formatCredential(credential),
      scopes: report.scopes,
      sso: report.sso,
      login: report.login
    }
  });
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
   * @param onLog Optional sink for the credential-diagnosis warn line, so
   * the host (extension output channel, CLI stderr) shows the root cause
   * and not just the thrown message.
   */
  public constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenProvider,
    private readonly onLog?: OnLogEvent
  ) {}

  /**
   * GET `ref.location` and parse the body as a HubConfig YAML.
   * @param ref Hub reference (`type: 'url'`).
   * @returns Resolved hub.
   */
  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    const config = await fetchYamlConfig(this.http, this.tokens, ref.location, { onLog: this.onLog });
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
   * @param onLog Optional sink for the credential-diagnosis warn line.
   */
  public constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenProvider,
    private readonly onLog?: OnLogEvent
  ) {}

  /**
   * Fetch `hub-config.yml` from the repo's raw content host.
   * @param ref Hub reference (`type: 'github'`).
   * @returns Resolved hub.
   */
  public async resolve(ref: HubReference): Promise<ResolvedHub> {
    const branch = ref.ref ?? 'main';
    const timestamp = Date.now();
    const url = `https://raw.githubusercontent.com/${ref.location}/${branch}/hub-config.yml?t=${timestamp}`;
    // `ref.location` is `owner/repo`, exactly what the repo-access probe
    // needs to tell "credential is broken" from "this account has no
    // access to this repository".
    const config = await fetchYamlConfig(this.http, this.tokens, url, {
      repoLocation: ref.location,
      onLog: this.onLog
    });
    return { config, reference: ref };
  }
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
