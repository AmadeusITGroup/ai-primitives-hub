/**
 * Hub system types for AI Primitives Hub
 * Defines interfaces and validation for curated hub management
 */

import {
  sanitizeHubId as sanitizeHubIdCore,
  validateHubReference as validateHubReferenceCore,
} from '@ai-primitives-hub/core';
import {
  validateHubConfig as validateHubConfigInfra,
} from '@ai-primitives-hub/infra';
import {
  Profile,
  RegistrySource,
} from './registry';

export {
  hasPathTraversal,
  isValidProtocol,
} from '@ai-primitives-hub/core';

/**
 * Reference to a hub location (GitHub, local, or URL)
 */
export interface HubReference {
  /** Type of hub source */
  type: 'github' | 'local' | 'url' | 'artifactory';

  /** Location of the hub (repo, path, or URL) */
  location: string;

  /** Git ref for GitHub sources (branch, tag, or commit) */
  ref?: string;

  /** Relative config path within an Artifactory hub root */
  configFile?: string;

  /** Artifactory authentication mode */
  authMode?: 'anonymous' | 'bearer';

  /** SecretStorage key in VS Code; CLI interprets the same field as an environment variable name. Never a raw token. */
  credentialRef?: string;

  /** Whether to automatically sync this hub */
  autoSync?: boolean;
}

/**
 * Elastic Search telemetry configuration for a hub.
 * Authentication is handled by the es-telemetry-proxy — no credentials needed.
 */
export interface ElasticSearchConfig {
  /** Elastic Search proxy URL (e.g. "https://es-proxy.internal:8080") */
  node: string;

  /** Optional custom index prefix (default: "prompt-registry-telemetry") */
  indexPrefix?: string;
}

/**
 * Hub configuration structure
 */
export interface HubConfig {
  /** Hub version (semver) */
  version: string;

  /** Hub metadata */
  metadata: HubMetadata;

  /** Registry sources provided by this hub */
  sources: HubSource[];

  /** Profiles provided by this hub */
  profiles: HubProfile[];

  /** Optional registry configuration */
  configuration?: RegistryConfiguration;

  /** Optional telemetry configuration */
  telemetry?: {
    elasticSearch?: ElasticSearchConfig;
  };
}

/**
 * Hub metadata
 */
export interface HubMetadata {
  /** Hub name */
  name: string;

  /** Hub description */
  description: string;

  /** Hub maintainer */
  maintainer: string;

  /** Last update timestamp */
  updatedAt: string;

  /** Optional checksum for verification (format: "sha256:hash" or "sha512:hash") */
  checksum?: string;
}

/**
 * Hub-provided source
 */
export interface HubSource extends RegistrySource {
  /** Whether this source is enabled */
  enabled: boolean;

  /** Priority for conflict resolution (higher = higher priority) */
  priority: number;
}

/**
 * Hub-provided profile
 */
export interface HubProfile extends Profile {
  /** Bundles in this profile */
  bundles: HubProfileBundle[];

  /** Optional path for nested profile organization */
  path?: string[];
}

/**
 * Bundle reference in a hub profile
 */
export interface HubProfileBundle {
  /** Bundle ID */
  id: string;

  /** Bundle version */
  version: string;

  /** Source ID providing this bundle */
  source: string;

  /** Whether this bundle is required */
  required: boolean;
}

/**
 * Profile activation state tracking
 */
export interface ProfileActivationState {
  hubId: string;
  profileId: string;
  activatedAt: string;
  syncedBundles: string[]; // Kept for backward compatibility
  syncedBundleVersions?: Record<string, string>; // Map of bundle ID to version
}

/**
 * Options for profile activation
 */
export interface ProfileActivationOptions {
  installBundles: boolean;
}

/**
 * Result of profile activation
 */
export interface ProfileActivationResult {
  success: boolean;
  hubId: string;
  profileId: string;
  resolvedBundles: { bundle: HubProfileBundle; url: string }[];
  error?: string;
}

export interface ProfileDeactivationResult {
  success: boolean;
  hubId: string;
  profileId: string;
  removedBundles?: string[];
  error?: string;
}

/**
 * Registry configuration from hub
 */
export interface RegistryConfiguration {
  /** Auto-sync enabled */
  autoSync?: boolean;

  /** Sync interval in seconds */
  syncInterval?: number;

  /** Strict mode (enforce profile bundles) */
  strictMode?: boolean;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;

  /** Error messages if validation failed */
  errors: string[];
}

/**
 * Validate a hub reference
 * @param ref Hub reference to validate
 * @throws {Error} if validation fails
 */
export function validateHubReference(ref: HubReference): void {
  validateHubReferenceCore(ref);
}

/**
 * Validate a hub configuration
 * @param config Hub configuration to validate
 * @returns Validation result with errors if any
 */
export function validateHubConfig(config: any): ValidationResult {
  return validateHubConfigInfra(config);
}

/**
 * Sanitize and validate a hub ID
 * @param hubId Hub ID to validate
 * @throws {Error} if ID is invalid
 */
export function sanitizeHubId(hubId: string): void {
  sanitizeHubIdCore(hubId);
}

/**
 * Profile change detection types
 */
export interface ProfileChanges {
  bundlesAdded?: HubProfileBundle[];
  bundlesRemoved?: string[];
  bundlesUpdated?: {
    id: string;
    oldVersion: string;
    newVersion: string;
  }[];
  metadataChanged?: {
    name?: boolean;
    description?: boolean;
    icon?: boolean;
  };
}

/**
 * Dialog option for conflict resolution
 */
export interface DialogOption {
  label: string;
  description?: string;
  action: 'sync' | 'review' | 'cancel';
}

/**
 * Conflict resolution dialog
 */
export interface ConflictResolutionDialog {
  title: string;
  message?: string;
  options: DialogOption[];
}
