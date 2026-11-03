/**
 * Type definitions for the repository lockfile (prompt-registry.lock.json)
 *
 * The lockfile tracks installed bundles at repository scope, enabling:
 * - Team collaboration through Git-committed configurations
 * - Version tracking for tools like Renovate
 * - Local modification detection via checksums
 */

import type {
  LockfileBundleEntry,
} from '@ai-primitives-hub/app';

/**
 * Bundle and file entries are the shared `app` types, so an entry the CLI
 * wrote (bundle-relative `path`, `installedPath`, `installedChecksum`,
 * `targetType`) reads and writes back unchanged.
 */
export type {
  LockfileBundleEntry,
  LockfileFileEntry,
} from '@ai-primitives-hub/app';

/**
 * Root lockfile structure
 */
export interface Lockfile {
  /** JSON schema reference for validation */
  $schema: string;
  /** Lockfile schema version (e.g., "1.0.0") */
  version: string;
  /** ISO timestamp when lockfile was generated */
  generatedAt: string;
  /** Extension name and version that generated the lockfile */
  generatedBy: string;
  /** Map of bundle IDs to their metadata */
  bundles: Record<string, LockfileBundleEntry>;
  /** Map of source IDs to their configuration */
  sources: Record<string, LockfileSourceEntry>;
  /** Optional map of hub IDs to their configuration */
  hubs?: Record<string, LockfileHubEntry>;
  /** Optional map of profile IDs to their configuration */
  profiles?: Record<string, LockfileProfileEntry>;
}

/**
 * Source configuration entry
 */
export interface LockfileSourceEntry {
  /** Source type (github, local, awesome-copilot, apm, etc.) */
  type: string;
  /** URL of the source */
  url: string;
  /** Optional Git branch for git-based sources */
  branch?: string;
}

/**
 * Hub configuration entry
 */
export interface LockfileHubEntry {
  /** Display name of the hub */
  name: string;
  /** URL of the hub configuration */
  url: string;
}

/**
 * Profile entry in the lockfile
 */
export interface LockfileProfileEntry {
  /** Display name of the profile */
  name: string;
  /** List of bundle IDs included in this profile */
  bundleIds: string[];
}

/**
 * Result of lockfile validation
 */
export interface LockfileValidationResult {
  /** Whether the lockfile is valid */
  valid: boolean;
  /** List of validation errors */
  errors: string[];
  /** List of validation warnings */
  warnings: string[];
  /** Schema version found in the lockfile */
  schemaVersion?: string;
}

/**
 * Information about a modified file
 */
export interface ModifiedFileInfo {
  /** Relative path of the modified file */
  path: string;
  /** Original checksum from lockfile */
  originalChecksum: string;
  /** Current checksum of the file on disk */
  currentChecksum: string;
  /** Type of modification detected */
  modificationType: 'modified' | 'missing' | 'new';
}
