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
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }

  const authority = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/.exec(sourceUrl)?.[1];
  const pathParts = parsed.pathname.split('/').filter((part) => part.length > 0);
  if (authority?.toLowerCase() !== 'github.com' || pathParts.length !== 2) {
    return null;
  }

  const [owner, repositoryWithSuffix] = pathParts;
  const repository = repositoryWithSuffix.endsWith('.git')
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix;
  return `${owner}-${repository}-`;
}

/**
 * Validate source-type-specific hub policies.
 *
 * These are the rules previously kept in the hub repository's Python helper:
 * `github` sources cannot carry a `config` block, `awesome-copilot` sources
 * must carry one, and GitHub bundle references must use the repository-derived
 * bundle ID prefix.
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
      const source = typeof sourceId === 'string' ? githubSources.get(sourceId) : undefined;
      if (source === undefined) {
        return;
      }

      const sourceUrl = source.url;
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
      if (typeof bundleId !== 'string' || !bundleId.startsWith(expectedPrefix)) {
        errors.push(
          `Profile '${profileId}' bundle #${bundleIndex + 1} must reference GitHub source `
          + `'${sourceId}' with an ID starting '${expectedPrefix}'.`
        );
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
  if (hubId.includes('..') || hubId.includes('/') || hubId.includes('\\')) {
    throw new Error('Invalid hub ID: path traversal detected');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(hubId)) {
    throw new Error('Invalid hub ID: only alphanumeric characters, dash, and underscore allowed');
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
      if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(ref.location)) {
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
      if (!isValidProtocol(url.protocol)) {
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
