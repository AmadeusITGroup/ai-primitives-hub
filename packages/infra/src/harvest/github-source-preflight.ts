/**
 * Evidence-based authentication preflight for GitHub-backed hub sources.
 *
 * Every source is checked through an authenticated public-read path first.
 * Public sources use the generic credential provider; sources whose access
 * requires authentication are validated with the repository-scoped App
 * provider. Anonymous GitHub access is not used by source-aware preflight.
 * No source name or organization is treated as a policy exception.
 * @module harvest/github-source-preflight
 */
import type {
  GitHubApi,
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HubSourceSpec,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  parseGitHubRepositoryTarget,
} from '../http/github-repository-target';

export type GitHubPublicAuthMode = 'auto' | 'anonymous' | 'generic';

/** Raised when a caller explicitly requests the unsupported anonymous mode. */
export class GitHubSourceAuthPolicyError extends Error {
  public readonly code = 'GH_PUBLIC_ANONYMOUS_DISABLED';

  public constructor() {
    super('Anonymous GitHub access is disabled in source-aware mode; provide a generic public credential.');
    this.name = 'GitHubSourceAuthPolicyError';
  }
}

export interface GitHubSourcePreflightResult {
  sourceId: string;
  target?: GitHubRepositoryTarget;
  category: GitHubSourceAuthCategory;
  operations: string[];
  credentialMode: 'none' | 'generic' | 'app';
  /** Commit revision observed while checking the source branch. */
  revision?: string;
  errorCode?: string;
}

export interface GitHubSourcePreflightReport {
  valid: boolean;
  results: GitHubSourcePreflightResult[];
  appRoutes: string[];
}

/**
 * Fail-closed source preflight error.
 *
 * The report contains only repository identifiers, operation names, category
 * decisions, and stable error codes. It intentionally contains no token,
 * authorization header, private key, or child-process output.
 */
export class GitHubSourcePreflightError extends Error {
  public readonly code = 'GH_SOURCE_PREFLIGHT_FAILED';

  public constructor(public readonly report: GitHubSourcePreflightReport) {
    super('GitHub source preflight failed.');
    this.name = 'GitHubSourcePreflightError';
  }
}

export interface GitHubSourcePreflightOptions {
  /** Build a client for the requested category and credential provider. */
  clientFactory: (
    target: GitHubRepositoryTarget,
    category: GitHubSourceAuthCategory,
    tokenProvider?: TokenProvider
  ) => GitHubApi;
  /** Provider used for all public-source visibility and content checks. */
  genericTokenProvider?: TokenProvider;
  /** Provider used only for sources whose generic checks require App auth. */
  appTokenProvider?: TokenProvider;
  /** Optional setup hook called after generic checks and before App checks. */
  prepareAppAuthentication?: (
    routes: readonly string[],
    targets: readonly GitHubRepositoryTarget[]
  ) => Promise<void>;
  /** Public credential policy. `auto` and `generic` are authenticated; `anonymous` is rejected. */
  publicAuthMode?: GitHubPublicAuthMode;
  /** Include release metadata in the required operation set for install/update callers. */
  includeReleases?: boolean;
  /** Safe diagnostic sink; never receives credential values. */
  onLog?: (message: string) => void;
}

interface ProbeResult {
  ok: boolean;
  operations: string[];
  revision?: string;
  error?: unknown;
  failedOperation?: string;
  authenticationRequired: boolean;
  rateLimitExceeded: boolean;
  repositoryPrivate?: boolean;
}

const compareSources = (a: HubSourceSpec, b: HubSourceSpec): number => {
  const left = `${a.owner.toLowerCase()}\u0000${a.repo.toLowerCase()}\u0000${a.id}`;
  const right = `${b.owner.toLowerCase()}\u0000${b.repo.toLowerCase()}\u0000${b.id}`;
  return left.localeCompare(right);
};

/**
 * Run the deterministic source-level preflight.
 * @param sources Enabled GitHub source specifications.
 * @param options Client/provider and public-rate-limit policy.
 * @returns One result per input source and derived App routes.
 */
export async function preflightGitHubSources(
  sources: readonly HubSourceSpec[],
  options: GitHubSourcePreflightOptions
): Promise<GitHubSourcePreflightReport> {
  const results: GitHubSourcePreflightResult[] = [];
  const appCandidates: {
    source: HubSourceSpec;
    target: GitHubRepositoryTarget;
    operations: string[];
  }[] = [];
  const genericVisibility = new Map<string, Promise<ProbeResult>>();
  let genericRateLimitDetected = false;
  if (options.publicAuthMode === 'anonymous') {
    throw new GitHubSourceAuthPolicyError();
  }

  for (const source of [...sources].toSorted(compareSources)) {
    if (genericRateLimitDetected) {
      results.push(unresolvedForRateLimit(source));
      continue;
    }
    const result = await classifySource(source, options, appCandidates, genericVisibility);
    results.push(result);
    genericRateLimitDetected = result.errorCode === 'GH_PUBLIC_GENERIC_RATE_LIMIT_UNSAFE';
  }

  // A generic rate-limit response makes visibility evidence unavailable for
  // every source that has not been checked yet. Do not continue probing (or
  // mint App tokens for earlier candidates) merely to produce more identical
  // failures; the caller must wait for the provider's budget to recover.
  if (genericRateLimitDetected) {
    return {
      valid: false,
      results,
      appRoutes: deriveGitHubAppRoutes(appCandidates.map((candidate) => candidate.target))
    };
  }

  const appRoutes = deriveGitHubAppRoutes(appCandidates.map((candidate) => candidate.target));
  if (appCandidates.length > 0 && options.prepareAppAuthentication !== undefined) {
    await options.prepareAppAuthentication(
      appRoutes,
      appCandidates.map((candidate) => candidate.target)
    );
  }
  // App setup/preparation runs after the authenticated generic checks. Re-run
  // the App-only checks for those candidates now that routes/configuration are
  // available.
  if (appCandidates.length > 0) {
    for (const candidate of appCandidates) {
      const resultIndex = results.findIndex((result) => result.sourceId === candidate.source.id);
      const appResult = await validateAppCandidate(
        candidate.source,
        candidate.target,
        candidate.operations,
        options
      );
      if (resultIndex !== -1) {
        results[resultIndex] = appResult;
      }
    }
  }
  for (const result of results) {
    options.onLog?.(
      `source=${result.sourceId} category=${result.category} credential=${result.credentialMode}`
      + (result.errorCode === undefined ? '' : ` error=${result.errorCode}`)
    );
  }
  return {
    valid: results.every((result) => result.category !== 'unresolved'),
    results,
    appRoutes
  };
}

async function classifySource(
  source: HubSourceSpec,
  options: GitHubSourcePreflightOptions,
  appCandidates: {
    source: HubSourceSpec;
    target: GitHubRepositoryTarget;
    operations: string[];
  }[],
  genericVisibility: Map<string, Promise<ProbeResult>>
): Promise<GitHubSourcePreflightResult> {
  let target: GitHubRepositoryTarget;
  try {
    target = parseGitHubRepositoryTarget(source.url);
    if (target.owner !== source.owner || target.repository !== source.repo) {
      return unresolved(source, undefined, [], 'GH_SOURCE_REPOSITORY_MISMATCH');
    }
  } catch {
    return unresolved(source, undefined, [], 'GH_SOURCE_REPOSITORY_INVALID');
  }

  const visibilityKey = `${target.host.toLowerCase()}/${target.owner.toLowerCase()}/${target.repository.toLowerCase()}`;
  const buildGenericClient = async (): Promise<GitHubApi | undefined> => {
    if (options.genericTokenProvider === undefined) {
      return undefined;
    }
    try {
      const token = await options.genericTokenProvider.getToken('api.github.com', target);
      if (token === undefined || token.length === 0) {
        return undefined;
      }
      return options.clientFactory(target, 'public-generic', options.genericTokenProvider);
    } catch {
      return undefined;
    }
  };
  const genericClient = await buildGenericClient();
  if (genericClient === undefined) {
    return unresolved(source, target, [], 'GH_PUBLIC_GENERIC_TOKEN_UNAVAILABLE');
  }

  let visibilityProbe = genericVisibility.get(visibilityKey);
  if (visibilityProbe === undefined) {
    visibilityProbe = probeRepositoryMetadata(source, genericClient);
    genericVisibility.set(visibilityKey, visibilityProbe);
  }
  const visibility = await visibilityProbe;
  if (!visibility.ok) {
    if (visibility.rateLimitExceeded) {
      return unresolved(source, target, visibility.operations, 'GH_PUBLIC_GENERIC_RATE_LIMIT_UNSAFE');
    }
    if (!visibility.authenticationRequired) {
      return unresolved(source, target, visibility.operations, 'GH_SOURCE_PREFLIGHT_UNRESOLVED');
    }
    appCandidates.push({ source, target, operations: visibility.operations });
    return unresolved(source, target, visibility.operations, 'GH_APP_AUTH_PENDING');
  }
  if (visibility.repositoryPrivate === true) {
    appCandidates.push({ source, target, operations: visibility.operations });
    return unresolved(source, target, visibility.operations, 'GH_APP_AUTH_PENDING');
  }
  if (visibility.repositoryPrivate !== false) {
    return unresolved(source, target, visibility.operations, 'GH_SOURCE_VISIBILITY_AMBIGUOUS');
  }

  const generic = await probeSource(source, genericClient, options.includeReleases === true, true);
  if (!generic.ok) {
    return unresolved(
      source,
      target,
      [...visibility.operations, ...generic.operations],
      generic.rateLimitExceeded ? 'GH_PUBLIC_GENERIC_RATE_LIMIT_UNSAFE' : 'GH_SOURCE_PREFLIGHT_UNRESOLVED'
    );
  }
  return {
    sourceId: source.id,
    target,
    category: 'public-generic',
    operations: [...visibility.operations, ...generic.operations],
    credentialMode: 'generic',
    ...(generic.revision === undefined ? {} : { revision: generic.revision })
  };
}

async function validateAppCandidate(
  source: HubSourceSpec,
  target: GitHubRepositoryTarget,
  genericOperations: string[],
  options: GitHubSourcePreflightOptions
): Promise<GitHubSourcePreflightResult> {
  if (options.appTokenProvider === undefined) {
    return unresolved(source, target, genericOperations, 'GH_APP_AUTH_CONFIG_MISSING');
  }
  let appClient: GitHubApi;
  try {
    appClient = options.clientFactory(target, 'app-authenticated', options.appTokenProvider);
  } catch {
    return unresolved(source, target, genericOperations, 'GH_SOURCE_PREFLIGHT_UNRESOLVED');
  }
  const authenticated = await probeSource(source, appClient, options.includeReleases === true);
  if (!authenticated.ok) {
    return unresolved(source, target, [...genericOperations, ...authenticated.operations], errorCode(authenticated.error));
  }
  return {
    sourceId: source.id,
    target,
    category: 'app-authenticated',
    operations: [...genericOperations, ...authenticated.operations],
    credentialMode: 'app',
    ...(authenticated.revision === undefined ? {} : { revision: authenticated.revision })
  };
}

/**
 * Derive stable wildcard routes from source targets that require App auth.
 * @param targets Authentication-required source targets.
 * @returns Sorted, case-insensitively deduplicated routes.
 */
export function deriveGitHubAppRoutes(
  targets: readonly GitHubRepositoryTarget[]
): string[] {
  const routes = new Map<string, string>();
  for (const target of targets) {
    const key = `${target.host.toLowerCase()}/${target.owner.toLowerCase()}`;
    routes.set(key, `${target.host.toLowerCase()}/${target.owner}/*`);
  }
  return [...routes.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, route]) => route);
}

async function probeRepositoryMetadata(source: HubSourceSpec, client: GitHubApi): Promise<ProbeResult> {
  try {
    const metadata = await client.getJson<{ private?: unknown }>(`/repos/${source.owner}/${source.repo}`);
    return {
      ok: true,
      operations: ['repository metadata'],
      authenticationRequired: false,
      rateLimitExceeded: false,
      repositoryPrivate: metadata.private === true ? true : (metadata.private === false ? false : undefined)
    };
  } catch (error) {
    return {
      ok: false,
      operations: ['repository metadata'],
      error,
      failedOperation: 'repository metadata',
      authenticationRequired: isAuthenticationError(error, 'repository metadata'),
      rateLimitExceeded: isRateLimitError(error)
    };
  }
}

async function probeSource(
  source: HubSourceSpec,
  client: GitHubApi,
  includeReleases: boolean,
  skipRepositoryMetadata = false
): Promise<ProbeResult> {
  const operations: string[] = [];
  const run = async (operation: string, action: () => Promise<unknown>): Promise<ProbeResult | undefined> => {
    operations.push(operation);
    try {
      await action();
      return undefined;
    } catch (error) {
      return {
        ok: false,
        operations,
        error,
        failedOperation: operation,
        authenticationRequired: isAuthenticationError(error, operation),
        rateLimitExceeded: isRateLimitError(error)
      };
    }
  };

  const repositoryPath = `/repos/${source.owner}/${source.repo}`;
  if (!skipRepositoryMetadata) {
    const failedRepository = await run('repository metadata', () => client.getJson(repositoryPath));
    if (failedRepository !== undefined) {
      return failedRepository;
    }
  }
  const commitPath = `${repositoryPath}/commits/${encodeURIComponent(source.branch)}`;
  operations.push('default branch commit');
  let revision: string | undefined;
  try {
    const commit = await client.getJson<{ sha?: unknown }>(commitPath);
    if (typeof commit.sha === 'string' && commit.sha.length > 0) {
      revision = commit.sha;
    }
  } catch (error) {
    return {
      ok: false,
      operations,
      error,
      failedOperation: 'default branch commit',
      authenticationRequired: isAuthenticationError(error, 'default branch commit'),
      rateLimitExceeded: isRateLimitError(error)
    };
  }
  const treePath = `${repositoryPath}/git/trees/${encodeURIComponent(source.branch)}?recursive=1`;
  const failedTree = await run('recursive repository tree', () => client.getJson(treePath));
  if (failedTree !== undefined) {
    return failedTree;
  }
  if (source.type === 'awesome-copilot') {
    const collectionsPath = source.collectionsPath ?? 'collections';
    const path = `${repositoryPath}/contents/${collectionsPath}?ref=${encodeURIComponent(source.branch)}`;
    const failedCollections = await run('collection directory', () => client.getJson(path));
    if (failedCollections !== undefined) {
      return failedCollections;
    }
  }
  if (source.type === 'awesome-copilot-plugin') {
    const pluginsPath = source.pluginsPath ?? 'plugins';
    const path = `${repositoryPath}/contents/${pluginsPath}?ref=${encodeURIComponent(source.branch)}`;
    const failedPlugins = await run('plugin directory', () => client.getJson(path));
    if (failedPlugins !== undefined) {
      return failedPlugins;
    }
  }
  if (includeReleases) {
    const failedReleases = await run('release metadata', () => client.getJson(`${repositoryPath}/releases`));
    if (failedReleases !== undefined) {
      return failedReleases;
    }
  }
  return {
    ok: true,
    operations,
    ...(revision === undefined ? {} : { revision }),
    authenticationRequired: false,
    rateLimitExceeded: false
  };
}

function unresolved(
  source: HubSourceSpec,
  target: GitHubRepositoryTarget | undefined,
  operations: string[],
  code: string
): GitHubSourcePreflightResult {
  return {
    sourceId: source.id,
    target,
    category: 'unresolved',
    operations,
    credentialMode: 'none',
    errorCode: code
  };
}

function unresolvedForRateLimit(source: HubSourceSpec): GitHubSourcePreflightResult {
  let target: GitHubRepositoryTarget | undefined;
  try {
    target = parseGitHubRepositoryTarget(source.url);
  } catch {
    // Keep the rate-limit reason stable even if a later source is also
    // malformed; the first rate-limit result is what made the run unsafe.
  }
  return unresolved(source, target, [], 'GH_PUBLIC_GENERIC_RATE_LIMIT_UNSAFE');
}

function isAuthenticationError(error: unknown, operation: string): boolean {
  const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown } | undefined;
  const status = typeof candidate?.statusCode === 'number' ? candidate.statusCode : undefined;
  if (status === 401 || status === 403) {
    return !isRateLimitError(candidate);
  }
  if (status === 404) {
    return operation === 'repository metadata';
  }
  if (typeof candidate?.code === 'string' && candidate.code.startsWith('GH_APP_AUTH_')) {
    return true;
  }
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error);
  if (isRateLimitError(candidate)) {
    return false;
  }
  if (/GH_APP_AUTH_(ROUTE_MISMATCH|INSTALLATION_MISSING|CONFIG_MISSING)/u.test(message)) {
    return true;
  }
  if (/\b(401|403)\b|authentication failed|access forbidden/u.test(message.toLowerCase())) {
    return true;
  }
  return operation === 'repository metadata' && /\b404\b|not found|not accessible/u.test(message.toLowerCase());
}

function isRateLimitError(error: unknown): boolean {
  const candidate = error as {
    message?: unknown;
    statusCode?: unknown;
    headers?: Record<string, string>;
  } | undefined;
  if (candidate?.statusCode === 429) {
    return true;
  }
  if (candidate?.statusCode === 403 && candidate.headers?.['x-ratelimit-remaining'] === '0') {
    return true;
  }
  const message = typeof candidate?.message === 'string'
    ? candidate.message
    : '';
  return /rate.?limit|too many requests|retry-after/u.test(message.toLowerCase());
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && code.startsWith('GH_')) {
    return code;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/route/u.test(message)) {
    return 'GH_APP_AUTH_ROUTE_MISMATCH';
  }
  if (/installation/u.test(message)) {
    return 'GH_APP_AUTH_INSTALLATION_MISSING';
  }
  if (/\b401\b|\b403\b|\b404\b|authentication|forbidden|not accessible/u.test(message)) {
    return 'GH_APP_AUTH_REQUEST_FAILED';
  }
  return 'GH_SOURCE_PREFLIGHT_UNRESOLVED';
}
