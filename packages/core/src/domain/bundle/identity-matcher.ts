/**
 * Domain layer — Cross-source-type bundle identity matching.
 *
 * Ported from the extension's `src/utils/bundle-identity-matcher.ts`
 * (`BundleIdentityMatcher`). Provides centralized logic for matching
 * bundle identities across different source types: for GitHub sources,
 * matches by identity (owner-repo) ignoring version suffixes; for other
 * sources, requires an exact ID match.
 * @module domain/bundle/identity-matcher
 */
import type {
  SourceType,
} from '../source/types';
import {
  extractBundleIdentity,
} from './version';

/**
 * Version suffix regex pattern used across the codebase.
 */
export const VERSION_SUFFIX_REGEX = /-v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[\w.]+)?$/;

/**
 * Check if two bundle IDs match based on source type
 * @param bundleId1 - First bundle ID to compare
 * @param bundleId2 - Second bundle ID to compare
 * @param sourceType - Source type determining matching strategy
 * @returns True if bundles match according to source type rules
 * @example
 * ```typescript
 * // GitHub bundles match by identity (ignoring version)
 * bundleIdentitiesMatch('owner-repo-v1.0.0', 'owner-repo-v2.0.0', 'github'); // true
 *
 * // Non-GitHub bundles require exact match
 * bundleIdentitiesMatch('local-bundle-v1.0.0', 'local-bundle-v2.0.0', 'local'); // false
 * ```
 */
export function bundleIdentitiesMatch(bundleId1: string, bundleId2: string, sourceType: SourceType): boolean {
  if (sourceType === 'github') {
    // For GitHub, extract identity without version suffix
    const identity1 = extractBundleIdentity(bundleId1, sourceType);
    const identity2 = extractBundleIdentity(bundleId2, sourceType);
    return identity1 === identity2;
  }

  // For non-GitHub sources, exact match required
  return bundleId1 === bundleId2;
}

/**
 * Extract base ID without version suffix
 * @param bundleId - Bundle ID potentially containing version suffix
 * @returns Base bundle ID without version
 * @example
 * ```typescript
 * extractBaseBundleId('my-bundle-v1.0.0'); // 'my-bundle'
 * ```
 */
export function extractBaseBundleId(bundleId: string): string {
  return bundleId.replace(VERSION_SUFFIX_REGEX, '');
}

/**
 * Check if bundle ID contains a version suffix
 * @param bundleId - Bundle ID to check
 * @returns True if bundle ID contains version suffix
 */
export function bundleIdHasVersionSuffix(bundleId: string): boolean {
  return VERSION_SUFFIX_REGEX.test(bundleId);
}
