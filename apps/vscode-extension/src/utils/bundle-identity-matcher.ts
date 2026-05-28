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
  }
};
