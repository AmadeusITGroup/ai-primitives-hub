/**
 * Bundle Name Utilities
 * Shared utilities for resolving bundle display names, generating bundle IDs,
 * and string sanitization for identifiers.
 */

import {
  Logger,
} from './logger';

/**
 * Generate a sanitized identifier from a name.
 * Converts to lowercase, replaces all non-alphanumeric characters with hyphens,
 * and removes leading/trailing hyphens.
 *
 * Use this for: file names, collection IDs, package names, technical identifiers
 * @param name - Name to sanitize
 * @returns Sanitized identifier suitable for IDs
 * @example
 * generateSanitizedId("My Project!!") // "my-project"
 * generateSanitizedId("  Test  Name  ") // "test-name"
 */
export function generateSanitizedId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Format byte size to human readable string
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Interface for bundle details resolution
 */
export interface BundleDetailsResolver {
  getBundleDetails(bundleId: string): Promise<{ name: string }>;
}

/**
 * Check if a manifest ID matches a bundle ID.
 *
 * For GitHub bundles, the manifest may contain just the collection ID (e.g., "test2")
 * while bundle.id is the full computed ID (e.g., "owner-repo-test2-v1.0.0" or "owner-repo-test2-1.0.0").
 *
 * This function accepts:
 * - Exact match: manifestId === bundleId
 * - Suffix match with 'v' prefix: bundleId ends with `-{manifestId}-v{manifestVersion}`
 * - Suffix match without 'v' prefix: bundleId ends with `-{manifestId}-{manifestVersion}`
 * @param manifestId - The ID from the deployment manifest
 * @param manifestVersion - The version from the deployment manifest
 * @param bundleId - The computed bundle ID
 * @returns true if the manifest ID matches the bundle ID
 */
export function isManifestIdMatch(manifestId: string, manifestVersion: string, bundleId: string): boolean {
  return manifestId === bundleId
    || bundleId.endsWith(`-${manifestId}-v${manifestVersion}`)
    || bundleId.endsWith(`-${manifestId}-${manifestVersion}`);
}

/**
 * Generate a canonical bundle ID for GitHub repositories
 * This ensures consistent ID generation across runtime and build scripts
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param tagName - Git tag name (e.g., 'v1.0.0')
 * @param manifestId - Optional manifest ID for multi-collection repos
 * @param manifestVersion - Optional manifest version
 * @returns Canonical bundle ID
 */
export function generateGitHubBundleId(
    owner: string,
    repo: string,
    tagName: string,
    manifestId?: string,
    manifestVersion?: string
): string {
  // Clean version by removing 'v' prefix if present
  const cleanVersion = manifestVersion || tagName.replace(/^v/, '');

  return manifestId
    ? `${owner}-${repo}-${manifestId}-${cleanVersion}`
    : `${owner}-${repo}-${tagName}`;
}

/**
 * Generate bundle ID for build scripts (maintains backward compatibility)
 *
 * IMPORTANT: This logic MUST stay in sync with the scaffold template implementation in:
 * templates/scaffolds/github/scripts/lib/bundle-id.js
 *
 * The bundle ID format is: {owner}-{repo}-{collectionId}-v{version}
 * Any changes here should be mirrored in bundle-id.js and vice versa.
 * @param repoSlug - Repository slug in format 'owner/repo' or 'owner-repo'
 * @param collectionId - Collection identifier
 * @param version - Version string
 * @returns Bundle ID for build scripts
 */
export function generateBuildScriptBundleId(
    repoSlug: string,
    collectionId: string,
    version: string
): string {
  // Normalize repo slug to use hyphens
  const normalizedSlug = repoSlug.replace('/', '-');
  return `${normalizedSlug}-${collectionId}-v${version}`;
}

/**
 * Get a bundle's display name, falling back to bundleId if details are unavailable.
 *
 * This is a shared utility to avoid duplicate implementations across:
 * - BundleUpdateCommands
 * - BaseNotificationService
 * - Other notification handlers
 * @param bundleId - The bundle identifier
 * @param resolver - Optional resolver function or object with getBundleDetails method
 * @returns The bundle's display name or the bundleId as fallback
 */
export async function getBundleDisplayName(
    bundleId: string,
    resolver?: ((bundleId: string) => Promise<string>) | BundleDetailsResolver
): Promise<string> {
  if (!resolver) {
    return bundleId;
  }

  try {
    if (typeof resolver === 'function') {
      return await resolver(bundleId);
    } else {
      const details = await resolver.getBundleDetails(bundleId);
      return details.name;
    }
  } catch {
    // Silently fall back to bundleId - this is expected when bundle details aren't available
    Logger.getInstance().debug(`Could not resolve bundle name for '${bundleId}', using ID`);
    return bundleId;
  }
}
