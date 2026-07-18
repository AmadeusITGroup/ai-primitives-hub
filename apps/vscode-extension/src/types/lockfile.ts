/**
 * Type definitions for the repository lockfile (prompt-registry.lock.json)
 *
 * The lockfile tracks installed bundles at repository scope, enabling:
 * - Team collaboration through Git-committed configurations
 * - Version tracking for tools like Renovate
 * - Local modification detection via checksums
 */

import {
  RepositoryCommitMode,
} from './registry';

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
 * Bundle entry in the lockfile
 */
export interface LockfileBundleEntry {
  /** Semantic version of the installed bundle */
  version: string;
  /** ID of the source this bundle was installed from */
  sourceId: string;
  /** Type of the source (github, local, etc.) */
  sourceType: string;
  /** ISO timestamp when bundle was installed */
  installedAt: string;
  /**
   * Whether files are committed to Git or excluded.
   * DEPRECATED: This field is now implicit based on which lockfile contains the entry.
   * - Entries in prompt-registry.lock.json are implicitly 'commit' mode
   * - Entries in prompt-registry.local.lock.json are implicitly 'local-only' mode
   * This field may still be present in existing lockfiles for backward compatibility.
   */
  commitMode?: RepositoryCommitMode;
  /** Optional checksum of the bundle archive */
  checksum?: string;
  /** List of installed files with their checksums */
  files: LockfileFileEntry[];
}

/**
 * File entry within a bundle
 */
export interface LockfileFileEntry {
  /** Relative path from repository root */
  path: string;
  /** SHA256 checksum of the file contents */
  checksum: string;
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
