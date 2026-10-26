/**
 * Domain layer — Hub validation.
 *
 * Pure, side-effect-free validators ported from `src/types/hub.ts`
 * (`validateHubReference`, `sanitizeHubId`, `hasPathTraversal`,
 * `isValidProtocol`). These operate on already-typed values.
 *
 * `validateHubConfig` (main's version validates a raw, untrusted, just-
 * parsed YAML node typed `any`) is deliberately **not** ported here — that
 * kind of "parse, don't validate blindly" boundary check belongs next to
 * wherever the untrusted YAML is actually parsed, i.e. `infra`'s hub-config
 * parser (Phase 3), not in `core`'s pure domain layer.
 * @module domain/hub/validate
 */
import {
  URL,
} from 'node:url';
import {
  compareVersions,
  extractBundleIdentity,
} from '../bundle/version';
import type {
  HubReference,
} from './types';

/**
 * Check whether a path contains directory-traversal sequences, including
 * the URL-encoded form.
 * @param path - Path to inspect.
 */
export function hasPathTraversal(path: string): boolean {
  if (!path) {
    return false;
  }
  if (path.includes('..')) {
    return true;
  }
  try {
    const decoded = decodeURIComponent(path);
    return decoded.includes('..');
  } catch {
    // A malformed escape sequence is not a valid safe path either. Treat it
    // as traversal so callers validating untrusted configuration fail closed.
    return true;
  }
}

/**
 * Canonical pattern for a GitHub user/organization segment.
 */
export const GITHUB_OWNER_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Canonical pattern for a GitHub repository name segment (allows `.` in
 * repository names such as `genai.prompt-registry-config`).
 */
export const GITHUB_REPO_PATTERN = /^[a-zA-Z0-9_.-]+$/;

const RAW_GITHUB_HOSTS = new Set(['raw.githubusercontent.com', 'raw.github.com']);

const isCanonicalGitHubHost = (host: string): boolean => {
  const lower = host.toLowerCase();
  return lower === 'github.com'
    || lower === 'api.github.com'
    || RAW_GITHUB_HOSTS.has(lower)
    || (lower.endsWith('.github.com') && lower.length > '.github.com'.length)
    || (lower.endsWith('.githubusercontent.com') && lower.length > '.githubusercontent.com'.length);
};

/**
 * Check whether a string is a valid GitHub owner/organization segment.
 * @param owner Candidate owner segment.
 */
export function isValidGitHubOwner(owner: string): boolean {
  if (!owner || owner === '.' || hasPathTraversal(owner)) {
    return false;
  }
  return GITHUB_OWNER_PATTERN.test(owner);
}

/**
 * Check whether a string is a valid GitHub repository name segment (supports
 * dots in repository names while rejecting `.` and `..` traversal).
 * @param repo Candidate repository segment.
 */
export function isValidGitHubRepo(repo: string): boolean {
  if (!repo || repo === '.' || hasPathTraversal(repo)) {
    return false;
  }
  return GITHUB_REPO_PATTERN.test(repo);
}

export interface ParsedGitHubOwnerRepo {
  host: string;
  owner: string;
  repo: string;
  subPathSegments: string[];
}

/**
 * Single source of truth for parsing a GitHub repository reference from:
 * - Bare `owner/repo` slug (including dots in `repo`)
 * - HTTPS URL (`https://github.com/owner/repo(.git)(/...)` or `raw.githubusercontent.com/...`)
 * - Scheme-less GitHub URL (`github.com/owner/repo/...`)
 * - SSH URL (`git@github.com:owner/repo(.git)` or `ssh://git@github.com/owner/repo(.git)`)
 * @param input Raw repository URL or `owner/repo` slug.
 * @returns Parsed `{ host, owner, repo, subPathSegments }` or `null` when invalid.
 */
export function parseGitHubOwnerRepo(input: string): ParsedGitHubOwnerRepo | null {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed || hasPathTraversal(trimmed)) {
    return null;
  }

  // 1. SSH shorthand: git@github.com:owner/repo(.git)
  if (trimmed.startsWith('git@')) {
    const sshMatch = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(trimmed);
    if (!sshMatch) {
      return null;
    }
    const [, sshHost, sshOwner, sshRepo] = sshMatch;
    if (!isCanonicalGitHubHost(sshHost) || !isValidGitHubOwner(sshOwner) || !isValidGitHubRepo(sshRepo)) {
      return null;
    }
    return {
      host: sshHost.toLowerCase(),
      owner: sshOwner,
      repo: sshRepo,
      subPathSegments: []
    };
  }

  // 2. Bare owner/repo slug
  if (!trimmed.includes('://')) {
    const segments = trimmed.replace(/^\/+|\/+$/gu, '').split('/');
    if (segments.length === 2 && !isCanonicalGitHubHost(segments[0])) {
      const [slugOwner, slugRawRepo] = segments;
      const slugRepo = slugRawRepo.endsWith('.git') && slugRawRepo.length > 4 ? slugRawRepo.slice(0, -4) : slugRawRepo;
      if (!isValidGitHubOwner(slugOwner) || !isValidGitHubRepo(slugRepo)) {
        return null;
      }
      return {
        host: 'github.com',
        owner: slugOwner,
        repo: slugRepo,
        subPathSegments: []
      };
    }
  }

  // 3. Full or scheme-less URL
  const candidateUrl = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return null;
  }

  const authority = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/.exec(candidateUrl)?.[1] ?? parsed.host;
  const hostWithoutUser = authority.includes('@') ? authority.split('@').pop()! : authority;
  if (hostWithoutUser.includes(':') || !isCanonicalGitHubHost(parsed.hostname)) {
    return null;
  }

  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  if (parts.length < 2) {
    return null;
  }
  const [owner, rawRepo, ...rest] = parts;
  const repo = rawRepo.endsWith('.git') && rawRepo.length > 4 ? rawRepo.slice(0, -4) : rawRepo;
  if (!isValidGitHubOwner(owner) || !isValidGitHubRepo(repo)) {
    return null;
  }

  return {
    host: parsed.hostname.toLowerCase(),
    owner,
    repo,
    subPathSegments: rest
  };
}

const refBeforeTrailingFile = (rest: string[]): string | undefined => {
  if (rest.length === 0) {
    return undefined;
  }
  if (rest.length === 1) {
    return rest[0];
  }
  return rest.slice(0, -1).join('/');
};

/**
 * Normalize a `github`-type hub location that may be a bare `owner/repo`
 * slug or a full repository/file URL into the canonical `owner/repo` slug
 * together with any branch/tag/commit carried by the URL.
 * @param location Raw location as entered by the user (slug or URL).
 * @param explicitRef Explicit ref, if any (takes precedence over URL-derived ref).
 * @returns Normalized `owner/repo` slug and resolved ref.
 */
export function normalizeGitHubHubLocation(
  location: string,
  explicitRef?: string
): { location: string; ref?: string } {
  const parsed = parseGitHubOwnerRepo(location);
  if (!parsed) {
    return { location, ref: explicitRef };
  }

  const normalizedLocation = `${parsed.owner}/${parsed.repo}`;
  if (explicitRef) {
    return { location: normalizedLocation, ref: explicitRef };
  }

  let derivedRef: string | undefined;
  if (RAW_GITHUB_HOSTS.has(parsed.host)) {
    derivedRef = refBeforeTrailingFile(parsed.subPathSegments);
  } else if (parsed.subPathSegments.length > 0) {
    const [kind, ...rest] = parsed.subPathSegments;
    if (kind === 'tree') {
      derivedRef = rest.length > 0 ? rest.join('/') : undefined;
    } else if (kind === 'blob' || kind === 'raw') {
      derivedRef = refBeforeTrailingFile(rest);
    }
  }

  return { location: normalizedLocation, ref: derivedRef };
}

/**
 * Derive the bundle ID prefix used by a plain GitHub source.
 *
 * GitHub-backed bundles are exposed as
 * `<owner>-<repository>-<bundle-id>`. This helper deliberately accepts only
 * repository URLs with exactly two path segments, matching the hub authoring
 * contract rather than silently accepting a subdirectory URL.
 * @param sourceUrl GitHub repository URL.
 * @returns Expected bundle prefix, or `null` for an invalid repository URL.
 */
export function githubBundlePrefix(sourceUrl: string): string | null {
  if (!sourceUrl.includes('://')) {
    return null;
  }
  const parsed = parseGitHubOwnerRepo(sourceUrl);
  if (!parsed || parsed.host !== 'github.com' || parsed.subPathSegments.length > 0) {
    return null;
  }
  return `${parsed.owner}-${parsed.repo}-`;
}

/**
 * Derive the bundle ID prefix used by a `skills` source.
 *
 * Skills-backed bundles are exposed as `skills-<owner>-<repository>-<skill-id>`.
 * Accepts URLs such as `https://github.com/<owner>/<repository>/<skills-dir>`
 * or `https://github.com/<owner>/<repository>`.
 * @param sourceUrl GitHub skills repository URL.
 * @returns Expected bundle prefix, or `null` for an invalid skills URL.
 */
export function skillsBundlePrefix(sourceUrl: string): string | null {
  if (!sourceUrl.includes('://')) {
    return null;
  }
  const parsed = parseGitHubOwnerRepo(sourceUrl);
  if (!parsed || parsed.host !== 'github.com') {
    return null;
  }
  return `skills-${parsed.owner}-${parsed.repo}-`;
}

/**
 * Derive the expected bundle ID prefix for a hub source, if the source type
 * requires a prefix convention (`github` or `skills`).
 * @param source Source descriptor with `type`, `url`, or `repository`.
 * @param source.type
 * @param source.url
 * @param source.repository
 * @returns Expected prefix string or `null` when no prefix is required.
 */
export function deriveExpectedBundlePrefix(source: {
  type?: string;
  url?: string;
  repository?: string;
}): string | null {
  const effectiveUrl = typeof source.url === 'string' && source.url.length > 0
    ? source.url
    : (typeof source.repository === 'string' && source.repository.length > 0
      ? `https://github.com/${source.repository}`
      : '');
  if (!effectiveUrl) {
    return null;
  }

  switch (source.type) {
    case 'github': {
      return githubBundlePrefix(effectiveUrl);
    }
    case 'skills': {
      return skillsBundlePrefix(effectiveUrl);
    }
    default: {
      return null;
    }
  }
}

/**
 * Format a raw bundle ID according to its source's bundle ID prefix convention.
 * Idempotent if the bundle ID already starts with the required prefix.
 * @param source Source descriptor.
 * @param source.type
 * @param source.url
 * @param source.repository
 * @param rawBundleId Raw or already-prefixed bundle ID.
 * @returns Properly prefixed bundle ID.
 */
export function formatHubBundleId(
  source: { type?: string; url?: string; repository?: string },
  rawBundleId: string
): string {
  const trimmed = rawBundleId.trim();
  const baseId = source.type === 'github'
    ? extractBundleIdentity(trimmed, 'github')
    : trimmed;
  const prefix = deriveExpectedBundlePrefix(source);
  if (!prefix) {
    return baseId;
  }
  return baseId.toLowerCase().startsWith(prefix.toLowerCase()) ? baseId : `${prefix}${baseId}`;
}

/**
 * Consolidated source catalog entry representing a unique versionless bundle ID
 * and its available semantic versions sorted newest-first.
 */
export interface HubSourceCatalogEntry {
  /**
   * Canonical versionless bundle ID for `hub-config.yml` profile references
   * (e.g. `amadeus-airlines-solutions-workflow-instructions-agents-md-creator`).
   */
  id: string;
  /**
   * Latest available version (e.g. `1.0.2`, or `latest` for hash-versioned skills).
   */
  version: string;
  /**
   * All selectable semver versions for this bundle in descending order
   * (e.g. `['1.0.2', '1.0.1', '1.0.0']`).
   */
  versions: string[];
}

const SEMVER_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

/**
 * Sort unique semantic version strings in descending order (newest first).
 * @param versions Iterable of version strings.
 */
export function sortSemverDescending(versions: Iterable<string>): string[] {
  return [...new Set(versions)].toSorted((left, right) => {
    try {
      return compareVersions(right, left);
    } catch {
      return right.localeCompare(left);
    }
  });
}

/**
 * Consolidate raw discovered source bundles into unique versionless bundle IDs
 * with their available semver versions sorted newest-first.
 * @param source Source descriptor (`type`, `url`, `repository`).
 * @param rawBundles Raw discovered `{ id, version }` pairs.
 * @returns Deduplicated catalog entries sorted by `id`.
 */
export function consolidateSourceCatalog(
  source: { type?: string; url?: string; repository?: string } | undefined,
  rawBundles: readonly { id: string; version: string }[]
): HubSourceCatalogEntry[] {
  const versionsByBaseId = new Map<string, Set<string>>();

  for (const b of rawBundles) {
    const baseId = source
      ? formatHubBundleId(source, b.id)
      : extractBundleIdentity(b.id, 'github');
    const existing = versionsByBaseId.get(baseId) ?? new Set<string>();
    const normalizedVersion = typeof b.version === 'string'
      ? b.version.trim().replace(/^v/, '')
      : '';
    if (SEMVER_VERSION_PATTERN.test(normalizedVersion)) {
      existing.add(normalizedVersion);
    } else {
      const trailingMatch = /-v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.exec(String(b.id ?? ''));
      if (trailingMatch && SEMVER_VERSION_PATTERN.test(trailingMatch[1])) {
        existing.add(trailingMatch[1]);
      }
    }
    versionsByBaseId.set(baseId, existing);
  }

  return [...versionsByBaseId.entries()]
    .map(([id, versionSet]) => {
      const versions = sortSemverDescending(versionSet);
      return {
        id,
        version: versions[0] ?? 'latest',
        versions
      };
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

/**
 * Result of checking whether a hub reference qualifies for contribution and
 * visual editing.
 */
export interface HubContributionEligibility {
  contributable: boolean;
  repositorySlug?: string;
  reason?: string;
}

/**
 * Determine whether a hub reference is eligible for the contribution and
 * visual editor workflow.
 *
 * Only GitHub-connected hubs qualify. Artifactory hubs are read-only replicas
 * populated by the promotion/replication pipeline and must never expose the
 * contribution/visual editor workflow.
 * @param ref Hub reference to inspect.
 * @param resolvedGitHubRemoteSlug Optional `owner/repo` resolved from a local git checkout's remotes.
 * @returns Eligibility verdict and resolved `owner/repo` slug when eligible.
 */
export function isContributableHub(
  ref: HubReference,
  resolvedGitHubRemoteSlug?: string
): HubContributionEligibility {
  if (!ref || !ref.type) {
    return {
      contributable: false,
      reason: 'Hub reference is missing a valid type.'
    };
  }

  if (ref.type === 'artifactory') {
    return {
      contributable: false,
      reason: 'Artifactory hubs are read-only replicas populated by the promotion process. Only GitHub-connected hubs support contributions.'
    };
  }

  if (ref.type === 'github') {
    try {
      validateHubReference(ref);
      const normalized = normalizeGitHubHubLocation(ref.location, ref.ref);
      return {
        contributable: true,
        repositorySlug: normalized.location
      };
    } catch (error) {
      return {
        contributable: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (ref.type === 'url') {
    const parsed = parseGitHubOwnerRepo(ref.location);
    if (parsed && (parsed.host === 'github.com' || RAW_GITHUB_HOSTS.has(parsed.host))) {
      return {
        contributable: true,
        repositorySlug: `${parsed.owner}/${parsed.repo}`
      };
    }
    return {
      contributable: false,
      reason: 'Only hubs connected with a GitHub repository support contributions.'
    };
  }

  if (ref.type === 'local') {
    if (resolvedGitHubRemoteSlug) {
      const parsed = parseGitHubOwnerRepo(resolvedGitHubRemoteSlug);
      if (parsed) {
        return {
          contributable: true,
          repositorySlug: `${parsed.owner}/${parsed.repo}`
        };
      }
    }
    return {
      contributable: false,
      reason: 'Only hubs connected with a GitHub repository support contributions.'
    };
  }

  return {
    contributable: false,
    reason: 'Only hubs connected with a GitHub repository support contributions.'
  };
}

/**
 * Validate source-type-specific hub policies.
 *
 * These are the rules previously kept in the hub repository's Python helper:
 * `github` sources cannot carry a `config` block, `awesome-copilot` sources
 * must carry one, and GitHub/skills bundle references must use the
 * repository-derived bundle ID prefix.
 * @param config Parsed but untrusted hub configuration.
 * @returns Human-readable policy violations.
 */
export function validateHubSourcePolicies(config: unknown): string[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return [];
  }

  const root = config as Record<string, unknown>;
  const sources = root.sources;
  const profiles = root.profiles;
  if (!Array.isArray(sources)) {
    return [];
  }

  const errors: string[] = [];
  const githubSources = new Map<string, Record<string, unknown>>();
  const skillsSources = new Map<string, Record<string, unknown>>();

  sources.forEach((value, sourceIndex) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }

    const source = value as Record<string, unknown>;
    const sourceId = typeof source.id === 'string' ? source.id : `#${sourceIndex + 1}`;
    const sourceType = source.type;
    const hasConfig = Object.prototype.hasOwnProperty.call(source, 'config');

    if (sourceType === 'github' && hasConfig) {
      errors.push(`Source '${sourceId}' has type 'github' and must not define 'config'.`);
    } else if (sourceType === 'awesome-copilot' && !hasConfig) {
      errors.push(`Source '${sourceId}' has type 'awesome-copilot' and must define 'config'.`);
    }

    if (sourceType === 'github' && typeof source.id === 'string') {
      githubSources.set(source.id, source);
    } else if (sourceType === 'skills' && typeof source.id === 'string') {
      skillsSources.set(source.id, source);
    }
  });

  if (!Array.isArray(profiles)) {
    return errors;
  }

  profiles.forEach((value, profileIndex) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }

    const profile = value as Record<string, unknown>;
    const profileId = typeof profile.id === 'string' ? profile.id : `#${profileIndex + 1}`;
    const bundles = profile.bundles;
    if (!Array.isArray(bundles)) {
      return;
    }

    bundles.forEach((bundleValue, bundleIndex) => {
      if (bundleValue === null || typeof bundleValue !== 'object' || Array.isArray(bundleValue)) {
        return;
      }

      const bundle = bundleValue as Record<string, unknown>;
      const sourceId = bundle.source;
      if (typeof sourceId !== 'string') {
        return;
      }

      const githubSource = githubSources.get(sourceId);
      if (githubSource !== undefined) {
        const sourceUrl = githubSource.url;
        if (typeof sourceUrl !== 'string') {
          errors.push(
            `GitHub source '${sourceId}' must define a valid GitHub repository URL.`
          );
          return;
        }

        const expectedPrefix = githubBundlePrefix(sourceUrl);
        if (expectedPrefix === null) {
          errors.push(
            `GitHub source '${sourceId}' has invalid repository URL '${sourceUrl}'.`
          );
          return;
        }

        const bundleId = bundle.id;
        if (typeof bundleId !== 'string' || !bundleId.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
          errors.push(
            `Profile '${profileId}' bundle #${bundleIndex + 1} must reference GitHub source `
            + `'${sourceId}' with an ID starting '${expectedPrefix}'.`
          );
        }
        return;
      }

      const skillsSource = skillsSources.get(sourceId);
      if (skillsSource !== undefined) {
        const sourceUrl = skillsSource.url;
        if (typeof sourceUrl !== 'string') {
          errors.push(
            `Skills source '${sourceId}' must define a valid GitHub skills URL.`
          );
          return;
        }

        const expectedPrefix = skillsBundlePrefix(sourceUrl);
        if (expectedPrefix === null) {
          errors.push(
            `Skills source '${sourceId}' has invalid skills URL '${sourceUrl}'.`
          );
          return;
        }

        const bundleId = bundle.id;
        if (typeof bundleId !== 'string' || !bundleId.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
          errors.push(
            `Profile '${profileId}' bundle #${bundleIndex + 1} must reference skills source `
            + `'${sourceId}' with an ID starting '${expectedPrefix}'.`
          );
        }
      }
    });
  });

  return errors;
}

/**
 * Only HTTPS is an acceptable protocol for a hub `url` reference.
 * @param protocol - Protocol string, e.g. `https:`.
 */
export function isValidProtocol(protocol: string): boolean {
  return protocol === 'https:';
}

/**
 * Loopback hosts may use HTTP only for local development/testing.
 * @param hostname - Parsed URL hostname.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Validate a hub ID: non-empty, ≤255 chars, no path separators or
 * traversal, alphanumeric/dash/underscore only.
 * @param hubId - Hub ID to validate.
 * @throws {Error} if the ID is invalid.
 */
export function sanitizeHubId(hubId: string): void {
  if (!hubId) {
    throw new Error('Invalid hub ID: cannot be empty');
  }
  if (hubId.length > 255) {
    throw new Error('Invalid hub ID: too long (max 255 characters)');
  }
  if (hubId === '.' || hubId.includes('..') || hubId.includes('/') || hubId.includes('\\')) {
    throw new Error('Invalid hub ID: path traversal detected');
  }
  if (!GITHUB_REPO_PATTERN.test(hubId)) {
    throw new Error('Invalid hub ID: only alphanumeric characters, dot, dash, and underscore allowed');
  }
}

/**
 * Validate a hub reference's `location` against its `type`.
 * @param ref - Hub reference to validate.
 * @throws {Error} if validation fails.
 */
export function validateHubReference(ref: HubReference): void {
  if (ref.location === null || ref.location === undefined) {
    throw new Error('Location is required');
  }
  if (ref.location === '') {
    throw new Error('Location cannot be empty');
  }

  switch (ref.type) {
    case 'github': {
      const normalized = normalizeGitHubHubLocation(ref.location, ref.ref);
      const segments = normalized.location.split('/');
      const [owner, repo] = segments;
      if (
        segments.length !== 2
        || hasPathTraversal(ref.location)
        || !isValidGitHubOwner(owner)
        || !isValidGitHubRepo(repo)
      ) {
        throw new Error('Invalid GitHub repository format. Expected: owner/repo');
      }
      break;
    }
    case 'local': {
      if (hasPathTraversal(ref.location)) {
        throw new Error('Path traversal detected in local path');
      }
      break;
    }
    case 'url':
    case 'artifactory': {
      let url: URL;
      try {
        url = new URL(ref.location);
      } catch {
        throw new Error('Invalid URL format');
      }
      const loopbackHttp = ref.type === 'artifactory'
        && url.protocol === 'http:'
        && isLoopbackHostname(url.hostname);
      if (!isValidProtocol(url.protocol) && !loopbackHttp) {
        throw new Error('Only HTTPS URLs are allowed for security');
      }
      if (ref.type === 'artifactory') {
        const configFile = ref.configFile ?? 'hub-config.yml';
        if (!configFile || configFile.startsWith('/') || configFile.includes('\\') || hasPathTraversal(configFile)) {
          throw new Error('Artifactory configFile must be a confined relative path');
        }
        if (ref.authMode !== undefined && ref.authMode !== 'anonymous' && ref.authMode !== 'bearer') {
          throw new Error('Invalid Artifactory authentication mode');
        }
      }
      break;
    }
  }
}
