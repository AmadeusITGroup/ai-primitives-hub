import * as semver from 'semver';
import {
  SourceType,
} from '../types/registry';
import {
  Logger,
} from './logger';

/**
 * Utility for version comparison and management using semver library
 *
 * This class provides semantic versioning operations including comparison,
 * validation, sorting, and bundle identity extraction for GitHub sources.
 */
export class VersionManager {
  /**
   * Maximum bundle ID length to prevent ReDoS attacks and excessive memory usage.
   *
   * Rationale: Based on GitHub's repository name limit (100 chars) + owner (39 chars)
   * + version suffix (20 chars) + separators and safety margin = 200 chars total.
   * This prevents malicious inputs from causing regex catastrophic backtracking.
   */
  private static readonly MAX_BUNDLE_ID_LENGTH = 200;

  /**
   * Maximum version string length to prevent ReDoS attacks.
   *
   * Rationale: Semver spec allows for long pre-release/build metadata, but 100 chars
   * is reasonable for legitimate versions (e.g., "1.2.3-beta.1+build.20231201.sha256hash").
   * This prevents malicious inputs from causing performance issues.
   */
  private static readonly MAX_VERSION_LENGTH = 100;

  private static readonly logger = Logger.getInstance();

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
  public static compareVersions(v1: string, v2: string): number {
    // Input validation
    if (!v1 || !v2) {
      throw new Error('Version strings cannot be empty or null');
    }

    if (v1.length > this.MAX_VERSION_LENGTH || v2.length > this.MAX_VERSION_LENGTH) {
      throw new Error(`Version string exceeds maximum length of ${this.MAX_VERSION_LENGTH}`);
    }

    // Clean versions (remove 'v' prefix if present)
    const clean1 = semver.clean(v1);
    const clean2 = semver.clean(v2);

    // If both are valid semver, use semver.compare()
    if (clean1 && clean2) {
      return semver.compare(clean1, clean2);
    }

    // Fallback: try to coerce invalid versions
    const coerced1 = semver.coerce(v1);
    const coerced2 = semver.coerce(v2);

    if (coerced1 && coerced2) {
      this.logger.debug(`Coerced versions for comparison: ${v1} -> ${coerced1.version}, ${v2} -> ${coerced2.version}`);
      return semver.compare(coerced1, coerced2);
    }

    // Last resort: string comparison (not recommended but prevents crashes)
    this.logger.warn(`Falling back to string comparison for invalid semver: "${v1}", "${v2}"`);
    return v1.localeCompare(v2);
  }

  /**
   * Determine if an update is available using semver.gt()
   * @param installedVersion - Currently installed version
   * @param latestVersion - Latest available version
   * @returns True if update available (latest > installed)
   * @throws {Error} if either version is empty or invalid
   */
  public static isUpdateAvailable(installedVersion: string, latestVersion: string): boolean {
    if (!installedVersion || !latestVersion) {
      throw new Error('Version strings cannot be empty or null');
    }

    // Hash-based versions update whenever the hash differs.
    if (this.isContentHashVersion(installedVersion) || this.isContentHashVersion(latestVersion)) {
      return installedVersion !== latestVersion;
    }

    const cleanInstalled = semver.clean(installedVersion) || semver.coerce(installedVersion)?.version;
    const cleanLatest = semver.clean(latestVersion) || semver.coerce(latestVersion)?.version;

    if (cleanInstalled && cleanLatest) {
      return semver.gt(cleanLatest, cleanInstalled);
    }

    // Fallback to comparison
    this.logger.debug(`Using compareVersions fallback for update check: ${installedVersion} vs ${latestVersion}`);
    return this.compareVersions(installedVersion, latestVersion) > 0;
  }

  private static isContentHashVersion(version: string): boolean {
    return version.startsWith('hash:');
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
  public static isSameBundleIdentity(id1: string, type1: SourceType, id2: string, type2: SourceType): boolean {
    const identity1 = this.extractBundleIdentity(id1, type1);
    const identity2 = this.extractBundleIdentity(id2, type2);
    return identity1 === identity2;
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
  public static extractBundleIdentity(bundleId: string, sourceType: SourceType): string {
    // Security: Prevent ReDoS attacks with length validation
    if (bundleId.length > this.MAX_BUNDLE_ID_LENGTH) {
      throw new Error(`Bundle ID exceeds maximum length of ${this.MAX_BUNDLE_ID_LENGTH}`);
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
      const identity = bundleId.slice(0, match.index);
      this.logger.debug(`Extracted bundle identity: "${bundleId}" -> "${identity}"`);
      return identity;
    }

    // No version suffix found, return as-is
    return bundleId;
  }
}
