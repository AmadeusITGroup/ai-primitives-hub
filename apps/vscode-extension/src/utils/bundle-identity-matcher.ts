/**
 * Bundle Identity Matcher Utility
 *
 * Provides centralized logic for matching bundle identities across different source types.
 * For GitHub sources, matches by identity (owner-repo) ignoring version suffixes.
 * For other sources, requires exact ID match.
 */

import {
  SourceType,
} from '../types/registry';
import {
  VersionManager,
} from './version-manager';

/**
 * Version suffix regex pattern used across the codebase
 */
export const VERSION_SUFFIX_REGEX = /-v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[\w.]+)?$/;

/**
 * Extract owner and repo from a GitHub URL.
 * Supports various GitHub URL formats.
 * @param url - GitHub repository URL
 * @returns Owner and repo, or undefined if not a valid GitHub URL
 */
// @migration-cleanup(source-type-migration)
export function extractGitHubMetadata(url: string): { owner: string; repo: string } | undefined {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i);
  if (!match) {
    return undefined;
  }
  const [, owner, repo] = match;
  return { owner, repo };
}

/**
 * Extract collection ID from a github bundle base ID given known owner/repo.
 * Github bundle IDs follow the format:
 *   - Multi-collection repos: `{owner}-{repo}-{collectionId}-{version}`
 *   - Single-collection repos: `{owner}-{repo}-{tagName}`
 *
 * Returns undefined when the format doesn't match or the segment after the
 * owner/repo prefix looks like a version (single-collection repo).
 * @param githubBaseId - Base ID without version suffix
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns Collection ID or undefined
 */
// @migration-cleanup(source-type-migration)
function extractGithubCollectionId(
    githubBaseId: string,
    owner: string,
    repo: string
): string | undefined {
  const expectedPrefix = `${owner}-${repo}-`;

  if (!githubBaseId.startsWith(expectedPrefix)) {
    return undefined;
  }

  const collectionId = githubBaseId.substring(expectedPrefix.length);

  // Single-collection repos have no collection segment (just version tag)
  if (!collectionId || /^v?\d+\.\d+/.test(collectionId)) {
    return undefined;
  }

  return collectionId;
}

/**
 * Bundle Identity Matcher
 * Centralized utility for comparing bundle identities
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
export const BundleIdentityMatcher = {
  /**
   * Check if two bundle IDs match based on source type
   * @param bundleId1 - First bundle ID to compare
   * @param bundleId2 - Second bundle ID to compare
   * @param sourceType - Source type determining matching strategy
   * @returns True if bundles match according to source type rules
   * @example
   * ```typescript
   * // GitHub bundles match by identity (ignoring version)
   * BundleIdentityMatcher.matches(
   *     'owner-repo-v1.0.0',
   *     'owner-repo-v2.0.0',
   *     'github'
   * ); // Returns: true
   *
   * // Non-GitHub bundles require exact match
   * BundleIdentityMatcher.matches(
   *     'local-bundle-v1.0.0',
   *     'local-bundle-v2.0.0',
   *     'local'
   * ); // Returns: false
   * ```
   */
  matches: (
    bundleId1: string,
    bundleId2: string,
    sourceType: SourceType
  ): boolean => {
    if (sourceType === 'github') {
      // For GitHub, extract identity without version suffix
      const identity1 = VersionManager.extractBundleIdentity(bundleId1, sourceType);
      const identity2 = VersionManager.extractBundleIdentity(bundleId2, sourceType);
      return identity1 === identity2;
    }

    // For non-GitHub sources, exact match required
    return bundleId1 === bundleId2;
  },

  /**
   * Extract base ID without version suffix
   * @param bundleId - Bundle ID potentially containing version suffix
   * @returns Base bundle ID without version
   * @example
   * ```typescript
   * BundleIdentityMatcher.extractBaseId('my-bundle-v1.0.0');
   * // Returns: 'my-bundle'
   * ```
   */
  extractBaseId: (bundleId: string): string => {
    return bundleId.replace(VERSION_SUFFIX_REGEX, '');
  },

  /**
   * Check if bundle ID contains a version suffix
   * @param bundleId - Bundle ID to check
   * @returns True if bundle ID contains version suffix
   */
  hasVersionSuffix: (bundleId: string): boolean => {
    return VERSION_SUFFIX_REGEX.test(bundleId);
  },

  /**
   * Check if an awesome-copilot bundle ID matches a github bundle ID after
   * a source type migration. Requires github source owner/repo to extract
   * the collection segment; without them matching is refused to prevent
   * partial-suffix false positives.
   * @param awesomeCopilotId - Installed awesome-copilot bundle ID (pre-migration)
   * @param githubId - Candidate github bundle ID (post-migration)
   * @param githubSourceMetadata - Owner/repo from the github source URL
   * @returns True if the github bundle's collection segment equals the awesome-copilot ID
   */
  // @migration-cleanup(source-type-migration)
  matchesAwesomeCopilotToGithub: (
    awesomeCopilotId: string,
    githubId: string,
    githubSourceMetadata: { owner: string; repo: string } | undefined
  ): boolean => {
    if (!githubSourceMetadata) {
      return false;
    }

    const githubBaseId = BundleIdentityMatcher.extractBaseId(githubId);
    const collectionId = extractGithubCollectionId(
      githubBaseId,
      githubSourceMetadata.owner,
      githubSourceMetadata.repo
    );

    return collectionId === awesomeCopilotId;
  }
};
