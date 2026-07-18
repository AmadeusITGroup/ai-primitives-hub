/**
 * Source ID Utilities
 * Utilities for generating stable, portable source identifiers for lockfile entries.
 *
 * These utilities ensure that sourceIds are:
 * - Deterministic: Same source always produces the same ID
 * - Portable: Not tied to user's hub configuration
 * - Collision-resistant: 12-char SHA256 hash provides sufficient uniqueness
 */

import * as crypto from 'node:crypto';

/**
 * Configuration for source ID generation
 */
export interface SourceIdConfig {
  /** Git branch for git-based sources (default: 'main') */
  branch?: string;
  /** Path to collections directory (default: 'collections') */
  collectionsPath?: string;
}

/**
 * Normalize URL for consistent hashing.
 * Lowercases the entire URL (protocol, host, and path) for case-insensitive
 * comparison. This is appropriate because the primary sources (GitHub)
 * treat repository paths as case-insensitive.
 * @param url - URL to normalize
 * @returns Normalized URL string with lowercase host and path, no protocol or trailing slashes
 * @example
 * normalizeUrl("HTTPS://GitHub.com/Owner/Repo/") // "github.com/owner/repo"
 * normalizeUrl("http://example.com") // "example.com"
 * normalizeUrl("https://GitHub.COM/OWNER/REPO") // "github.com/owner/repo"
 */
export function normalizeUrl(url: string): string {
  try {
    // Parse the URL to separate components
    const parsedUrl = new URL(url);

    // Normalize: lowercase hostname and pathname for case-insensitive comparison
    const normalizedHost = parsedUrl.hostname.toLowerCase();
    const normalizedPath = parsedUrl.pathname.toLowerCase().replace(/\/+$/, ''); // Remove trailing slashes

    return normalizedHost + normalizedPath;
  } catch {
    // Fallback for invalid URLs - use the original logic
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  }
}

/**
 * Legacy URL normalization (pre-v2): lowercase host only, preserve path case.
 * `@migration-cleanup(sourceId-normalization-v2)`: Remove once all lockfiles are migrated
 * Used for computing old-format source IDs to support migration and dual-read.
 * @param url - URL to normalize
 * @returns Normalized URL string with lowercase host, original-case path, no protocol or trailing slashes
 */
export function normalizeUrlLegacy(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const normalizedHost = parsedUrl.hostname.toLowerCase();
    const normalizedPath = parsedUrl.pathname.replace(/\/+$/, ''); // preserve path case
    return normalizedHost + normalizedPath;
  } catch {
    // Fallback: only lowercase the host portion
    return url
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .replace(/^([^/]+)/, (host) => host.toLowerCase());
  }
}

/**
 * Generate a stable sourceId for a hub source based on type, URL, and configuration.
 * Format: {sourceType}-{hash} where hash is first 12 chars of SHA256.
 *
 * The hash includes:
 * - Source type
 * - Normalized URL
 * - Branch (defaults to 'main', 'master' treated as 'main')
 * - Collections path (defaults to 'collections')
 *
 * This format is:
 * - Deterministic: Same inputs always produce the same output
 * - Portable: Not tied to any specific hub configuration
 * - Collision-resistant: 12-char hash (48 bits) — different branch/path combinations produce different IDs
 * - Readable: Type prefix makes it easy to identify source type
 * @param sourceType - The type of source (e.g., 'github', 'local', 'awesome-copilot')
 * @param url - The source URL
 * @param config - Optional configuration (branch, collectionsPath)
 * @returns Stable sourceId in format `{sourceType}-{12-char-hash}`
 * @example
 * generateHubSourceId('github', 'https://github.com/owner/repo') // "github-a1b2c3d4e5f6"
 * generateHubSourceId('github', 'https://github.com/owner/repo', { branch: 'develop' }) // "github-e5f6a7b8c9d0"
 * generateHubSourceId('awesome-copilot', 'https://example.com/prompts', {
 *   branch: 'main',
 *   collectionsPath: 'collections'
 * }) // "awesome-copilot-1a2b3c4d5e6f"
 */
export function generateHubSourceId(
    sourceType: string,
    url: string,
    config?: SourceIdConfig
): string {
  const normalizedUrl = normalizeUrl(url);

  // Extract and normalize config values
  const branch = normalizeBranch(config?.branch);
  const collectionsPath = config?.collectionsPath || 'collections';

  // Include all relevant fields in the hash
  const hash = crypto.createHash('sha256')
    .update(`${sourceType}:${normalizedUrl}:${branch}:${collectionsPath}`)
    .digest('hex')
    .substring(0, 12);

  return `${sourceType}-${hash}`;
}

/**
 * Normalize branch name for consistent hashing.
 * Treats 'master' as 'main' for consistency.
 * @param branch - Branch name to normalize
 * @returns Normalized branch name (defaults to 'main')
 */
function normalizeBranch(branch?: string): string {
  if (!branch || branch === 'master') {
    return 'main';
  }
  return branch;
}

/**
 * Check if a sourceId is in the legacy hub-prefixed format.
 * Legacy format: `hub-{hubId}-{sourceId}` (e.g., "hub-my-hub-github-source")
 *
 * This is used for backward compatibility with existing lockfiles that
 * contain the old hub-prefixed sourceId format.
 * @param sourceId - The sourceId to check
 * @returns true if sourceId is in legacy format (starts with 'hub-' and has 3+ segments)
 * @example
 * isLegacyHubSourceId('hub-my-hub-source1') // true (3 segments)
 * isLegacyHubSourceId('hub-test-hub-github-source') // true (5 segments)
 * isLegacyHubSourceId('github-a1b2c3d4e5f6') // false (new format)
 * isLegacyHubSourceId('hub-only') // false (only 2 segments)
 */
export function isLegacyHubSourceId(sourceId: string): boolean {
  return sourceId.startsWith('hub-') && sourceId.split('-').length >= 3;
}

/**
 * Generate a stable hub key for the lockfile based on URL and optional branch.
 *
 * The key is derived from the hub URL (not the user-defined hub ID), making
 * lockfiles portable across different hub configurations. The format is:
 * - `{12-char-hash}` for main/master branches or no branch specified
 * - `{12-char-hash}-{branch}` for other branches
 *
 * This ensures that:
 * - Same URL always produces the same key (deterministic)
 * - Keys are not tied to user-defined hub IDs (portable)
 * - Branch information is preserved when relevant
 * @param url - The hub URL
 * @param branch - Optional branch name (if not main/master, appended to key)
 * @returns Stable hub key in format `{12-char-hash}` or `{12-char-hash}-{branch}`
 * @example
 * generateHubKey('https://example.com/hub.json') // "a1b2c3d4e5f6"
 * generateHubKey('https://example.com/hub.json', 'main') // "a1b2c3d4e5f6"
 * generateHubKey('https://example.com/hub.json', 'master') // "a1b2c3d4e5f6"
 * generateHubKey('https://example.com/hub.json', 'develop') // "a1b2c3d4e5f6-develop"
 */
export function generateHubKey(url: string, branch?: string): string {
  const normalizedUrl = normalizeUrl(url);
  const hash = crypto.createHash('sha256')
    .update(normalizedUrl)
    .digest('hex')
    .substring(0, 12);

  if (branch && branch !== 'main' && branch !== 'master') {
    return `${hash}-${branch}`;
  }
  return hash;
}

/**
 * Generate a legacy sourceId using pre-v2 normalization (host-only lowercase).
 * `@migration-cleanup(sourceId-normalization-v2)`: Remove once all lockfiles are migrated
 * Returns undefined if the legacy ID is identical to the current ID (no migration needed).
 * @param sourceType - The type of source (e.g., 'github', 'local', 'awesome-copilot')
 * @param url - The source URL
 * @param config - Optional configuration (branch, collectionsPath)
 * @returns Legacy sourceId, or undefined if identical to current format
 */
export function generateLegacyHubSourceId(
    sourceType: string,
    url: string,
    config?: SourceIdConfig
): string | undefined {
  const legacyNormalized = normalizeUrlLegacy(url);
  const currentNormalized = normalizeUrl(url);

  // If normalization produces the same result, no legacy ID exists
  if (legacyNormalized === currentNormalized) {
    return undefined;
  }

  const branch = normalizeBranch(config?.branch);
  const collectionsPath = config?.collectionsPath || 'collections';

  const hash = crypto.createHash('sha256')
    .update(`${sourceType}:${legacyNormalized}:${branch}:${collectionsPath}`)
    .digest('hex')
    .substring(0, 12);

  return `${sourceType}-${hash}`;
}

/**
 * Generate a legacy hub key using pre-v2 normalization (host-only lowercase).
 * `@migration-cleanup(sourceId-normalization-v2)`: Remove once all lockfiles are migrated
 * Returns undefined if the legacy key is identical to the current key.
 * @param url - The hub URL
 * @param branch - Optional branch name
 * @returns Legacy hub key, or undefined if identical to current format
 */
export function generateLegacyHubKey(
    url: string,
    branch?: string
): string | undefined {
  const legacyNormalized = normalizeUrlLegacy(url);
  const currentNormalized = normalizeUrl(url);

  if (legacyNormalized === currentNormalized) {
    return undefined;
  }

  const hash = crypto.createHash('sha256')
    .update(legacyNormalized)
    .digest('hex')
    .substring(0, 12);

  if (branch && branch !== 'main' && branch !== 'master') {
    return `${hash}-${branch}`;
  }
  return hash;
}
