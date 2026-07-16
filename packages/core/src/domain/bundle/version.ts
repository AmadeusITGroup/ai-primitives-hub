/**
 * Domain layer — Bundle version comparison and identity extraction.
 *
 * Ported from the extension's `src/utils/version-manager.ts`
 * (`VersionManager`'s static methods), using the `semver` library for
 * comparison/coercion. That class also called `Logger.getInstance()`
 * for debug/warn diagnostics on its fallback paths (coercion, string-
 * comparison fallback) — untested, non-behavioral side effects that
 * don't belong in `core`'s pure domain layer (same precedent as
 * `domain/errors.ts`), so they are dropped here. The extension's
 * `VersionManager` delegates to these functions unchanged.
 * @module domain/bundle/version
 */
import * as semver from 'semver';
import type {
  SourceType,
} from '../source/types';

/**
 * Maximum bundle ID length to prevent ReDoS attacks and excessive memory usage.
 *
 * Rationale: Based on GitHub's repository name limit (100 chars) + owner (39 chars)
 * + version suffix (20 chars) + separators and safety margin = 200 chars total.
 * This prevents malicious inputs from causing regex catastrophic backtracking.
 */
const MAX_BUNDLE_ID_LENGTH = 200;

/**
 * Maximum version string length to prevent ReDoS attacks.
 *
 * Rationale: Semver spec allows for long pre-release/build metadata, but 100 chars
 * is reasonable for legitimate versions (e.g., "1.2.3-beta.1+build.20231201.sha256hash").
 * This prevents malicious inputs from causing performance issues.
 */
const MAX_VERSION_LENGTH = 100;

function isContentHashVersion(version: string): boolean {
  return version.startsWith('hash:');
}

/**
 * Compare two semantic versions using semver.compare()
 *
 * Comparison strategy:
 * 1. Try semver.clean() for standard versions
 * 2. Fall back to semver.coerce() for non-standard versions
 * 3. Last resort: lexicographic string comparison
 * @param v1 - First version string
 * @param v2 - Second version string
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 * @throws {Error} if either version is empty or exceeds maximum length
 */
export function compareVersions(v1: string, v2: string): number {
  if (!v1 || !v2) {
    throw new Error('Version strings cannot be empty or null');
  }

  if (v1.length > MAX_VERSION_LENGTH || v2.length > MAX_VERSION_LENGTH) {
    throw new Error(`Version string exceeds maximum length of ${MAX_VERSION_LENGTH}`);
  }

  const clean1 = semver.clean(v1);
  const clean2 = semver.clean(v2);

  if (clean1 && clean2) {
    return semver.compare(clean1, clean2);
  }

  const coerced1 = semver.coerce(v1);
  const coerced2 = semver.coerce(v2);

  if (coerced1 && coerced2) {
    return semver.compare(coerced1, coerced2);
  }

  return v1.localeCompare(v2);
}

/**
 * Determine if an update is available using semver.gt()
 * @param installedVersion - Currently installed version
 * @param latestVersion - Latest available version
 * @returns True if update available (latest > installed)
 * @throws {Error} if either version is empty or invalid
 */
export function isUpdateAvailable(installedVersion: string, latestVersion: string): boolean {
  if (!installedVersion || !latestVersion) {
    throw new Error('Version strings cannot be empty or null');
  }

  // Hash-based versions update whenever the hash differs.
  if (isContentHashVersion(installedVersion) || isContentHashVersion(latestVersion)) {
    return installedVersion !== latestVersion;
  }

  const cleanInstalled = semver.clean(installedVersion) || semver.coerce(installedVersion)?.version;
  const cleanLatest = semver.clean(latestVersion) || semver.coerce(latestVersion)?.version;

  if (cleanInstalled && cleanLatest) {
    return semver.gt(cleanLatest, cleanInstalled);
  }

  return compareVersions(installedVersion, latestVersion) > 0;
}

/**
 * Extract bundle identity from GitHub bundle ID by removing version suffix
 *
 * GitHub bundle IDs follow the format: {owner}-{repo}-{version}
 * This method extracts {owner}-{repo} by identifying and removing the version suffix.
 *
 * For non-GitHub sources, the bundle ID is returned unchanged.
 * @example
 * extractBundleIdentity('microsoft-vscode-v1.0.0', 'github') // 'microsoft-vscode'
 * extractBundleIdentity('my-org-my-repo-2.1.3', 'github')    // 'my-org-my-repo'
 * extractBundleIdentity('owner-123-v1.0.0', 'github')        // 'owner-123'
 * extractBundleIdentity('bundle-id', 'local')                // 'bundle-id' (unchanged)
 * @param bundleId - Bundle ID potentially containing version suffix
 * @param sourceType - Source type of the bundle
 * @returns Bundle identity without version suffix (GitHub only)
 * @throws {Error} if bundleId exceeds maximum length
 */
export function extractBundleIdentity(bundleId: string, sourceType: SourceType): string {
  // Security: Prevent ReDoS attacks with length validation
  if (bundleId.length > MAX_BUNDLE_ID_LENGTH) {
    throw new Error(`Bundle ID exceeds maximum length of ${MAX_BUNDLE_ID_LENGTH}`);
  }

  if (sourceType !== 'github') {
    return bundleId; // For non-GitHub, return as-is
  }

  // Match version pattern at the end: -v1.2.3 or -1.2.3
  // This regex is more efficient than iterating through all parts
  // Quantifier limits prevent ReDoS attacks
  // Pattern breakdown: -v? (optional v prefix), \d{1,3} (1-3 digits per version part),
  // optional pre-release/build metadata with restricted character set
  const versionPattern = /-v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9._-]{1,50})?$/;
  const match = bundleId.match(versionPattern);

  if (match && match.index !== undefined) {
    return bundleId.slice(0, match.index);
  }

  // No version suffix found, return as-is
  return bundleId;
}

/**
 * Check if two bundle IDs represent the same bundle identity
 * Handles versioned IDs and different source types
 * @param id1 - First bundle ID
 * @param type1 - Source type of first bundle
 * @param id2 - Second bundle ID
 * @param type2 - Source type of second bundle
 * @returns True if they represent the same bundle identity
 */
export function isSameBundleIdentity(id1: string, type1: SourceType, id2: string, type2: SourceType): boolean {
  return extractBundleIdentity(id1, type1) === extractBundleIdentity(id2, type2);
}
