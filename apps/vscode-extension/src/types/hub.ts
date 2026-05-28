/**
 * Hub system types for Prompt Registry
 * Defines interfaces and validation for curated hub management
 */

import {
  Profile,
  RegistrySource,
} from './registry';

/**
 * Reference to a hub location (GitHub, local, or URL)
 */
export interface HubReference {
  /** Type of hub source */
  type: 'github' | 'local' | 'url';

  /** Location of the hub (repo, path, or URL) */
  location: string;

  /** Git ref for GitHub sources (branch, tag, or commit) */
  ref?: string;

  /** Whether to automatically sync this hub */
  autoSync?: boolean;
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
  // Check location exists
  if (ref.location === null || ref.location === undefined) {
    throw new Error('Location is required');
  }

  // Check location not empty
  if (ref.location === '') {
    throw new Error('Location cannot be empty');
  }

  // Validate based on type
  switch (ref.type) {
    case 'github': {
      // Validate GitHub format: owner/repo
      if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(ref.location)) {
        throw new Error('Invalid GitHub repository format. Expected: owner/repo');
      }
      break;
    }

    case 'local': {
      // Check for path traversal
      if (hasPathTraversal(ref.location)) {
        throw new Error('Path traversal detected in local path');
      }
      break;
    }

    case 'url': {
      // Validate URL and protocol
      try {
        const url = new URL(ref.location);
        if (!isValidProtocol(url.protocol)) {
          throw new Error('Only HTTPS URLs are allowed for security');
        }
      } catch (error) {
        if (error instanceof TypeError) {
          throw new Error('Invalid URL format');
        }
        throw error;
      }
      break;
    }
  }
}

/**
 * Validate a hub configuration
 * @param config Hub configuration to validate
 * @returns Validation result with errors if any
 */
export function validateHubConfig(config: any): ValidationResult {
  const errors: string[] = [];

  // Check required fields
  if (config.version) {
    // Validate semver format
    if (!/^\d+\.\d+\.\d+$/.test(config.version)) {
      errors.push('version must be in semver format (e.g., 1.0.0)');
    }
  } else {
    errors.push('version is required');
  }

  if (config.metadata) {
    // Validate metadata fields
    if (!config.metadata.name) {
      errors.push('metadata.name is required');
    }
    if (!config.metadata.description) {
      errors.push('metadata.description is required');
    }
    if (!config.metadata.maintainer) {
      errors.push('metadata.maintainer is required');
    }
    if (!config.metadata.updatedAt) {
      errors.push('metadata.updatedAt is required');
    }

    // Validate checksum format if provided
    if (config.metadata.checksum && !/^(sha256|sha512):[a-f0-9]+$/.test(config.metadata.checksum)) {
      errors.push('metadata.checksum must be in format "sha256:hash" or "sha512:hash"');
    }
  } else {
    errors.push('metadata is required');
  }

  if (config.sources) {
    // Validate sources
    if (Array.isArray(config.sources)) {
      config.sources.forEach((source: any, index: number) => {
        if (source.id) {
          // Check for path traversal in source ID
          if (hasPathTraversal(source.id)) {
            errors.push(`source[${index}].id contains path traversal: ${source.id}`);
          }
        } else {
          errors.push(`source[${index}].id is required`);
        }
        if (!source.type) {
          errors.push(`source[${index}].type is required`);
        }
      });
    } else {
      errors.push('sources must be an array');
    }
  } else {
    errors.push('sources is required');
  }

  // Validate profiles if provided
  if (config.profiles) {
    if (Array.isArray(config.profiles)) {
      // Build source ID set for validation
      const sourceIds = new Set(
        config.sources ? config.sources.map((s: any) => s.id) : []
      );

      config.profiles.forEach((profile: any, pIndex: number) => {
        if (!profile.id) {
          errors.push(`profile[${pIndex}].id is required`);
        }
        if (!profile.name) {
          errors.push(`profile[${pIndex}].name is required`);
        }

        // Validate bundles
        if (profile.bundles && Array.isArray(profile.bundles)) {
          profile.bundles.forEach((bundle: any, bIndex: number) => {
            // Check for path traversal in bundle ID
            if (bundle.id && hasPathTraversal(bundle.id)) {
              errors.push(`profile[${pIndex}].bundle[${bIndex}].id contains path traversal: ${bundle.id}`);
            }

            // Validate source reference
            if (bundle.source && !sourceIds.has(bundle.source)) {
              errors.push(`profile[${pIndex}].bundle[${bIndex}] references non-existent source: ${bundle.source}`);
            }
          });
        }
      });
    } else {
      errors.push('profiles must be an array');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Sanitize and validate a hub ID
 * @param hubId Hub ID to validate
 * @throws {Error} if ID is invalid
 */
export function sanitizeHubId(hubId: string): void {
  // Check not empty
  if (!hubId || hubId === '') {
    throw new Error('Invalid hub ID: cannot be empty');
  }

  // Check length
  if (hubId.length > 255) {
    throw new Error('Invalid hub ID: too long (max 255 characters)');
  }

  // Check for path traversal
  if (hubId.includes('..') || hubId.includes('/') || hubId.includes('\\')) {
    throw new Error('Invalid hub ID: path traversal detected');
  }

  // Validate format (alphanumeric, dash, underscore only)
  if (!/^[a-zA-Z0-9_-]+$/.test(hubId)) {
    throw new Error('Invalid hub ID: only alphanumeric characters, dash, and underscore allowed');
  }
}

/**
 * Check if a protocol is valid (HTTPS only)
 * @param protocol Protocol to check (e.g., "https:")
 * @returns True if protocol is allowed
 */
export function isValidProtocol(protocol: string): boolean {
  return protocol === 'https:';
}

/**
 * Check if a path contains traversal attempts
 * @param path Path to check
 * @returns True if path traversal detected
 */
export function hasPathTraversal(path: string): boolean {
  if (!path) {
    return false;
  }

  // Check for literal ..
  if (path.includes('..')) {
    return true;
  }

  // Check for URL-encoded ..
  const decoded = decodeURIComponent(path);
  if (decoded.includes('..')) {
    return true;
  }

  return false;
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
