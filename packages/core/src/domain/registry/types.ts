/**
 * Domain layer — Registry types.
 *
 * Mirrors the production shape at `src/types/registry.ts` (`Profile`,
 * `ProfileBundle`, `RegistryConfig`, `RegistrySettings`, `SearchQuery`).
 * @module domain/registry/types
 */
import type {
  InstallationScope,
} from '../install/types';
import type {
  RegistrySource,
} from '../source/types';

/**
 * A bundle reference within a profile.
 */
export interface ProfileBundle {
  id: string;
  /** Semantic version, or `'latest'`. */
  version: string;
  /** Disambiguates which source this bundle should come from. */
  sourceId?: string;
  required: boolean;
}

/**
 * A named collection of bundles a user can activate as a group.
 */
export interface Profile {
  id: string;
  name: string;
  description: string;
  icon: string;
  bundles: ProfileBundle[];
  environments?: {
    preferred: string;
    compatible: string[];
  };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * User-configurable registry behavior.
 */
export interface RegistrySettings {
  autoUpdate: boolean;
  /** Hours between automatic update checks. */
  updateCheckInterval: number;
  telemetry: boolean;
  installationScope: InstallationScope;
  preferredEnvironment: string;
  proxySettings?: {
    enabled: boolean;
    url: string;
  };
}

/**
 * Top-level, persisted registry configuration.
 */
export interface RegistryConfig {
  version: string;
  sources: RegistrySource[];
  profiles: Profile[];
  settings: RegistrySettings;
}

/**
 * Query parameters for searching/browsing bundles.
 */
export interface SearchQuery {
  text?: string;
  tags?: string[];
  author?: string;
  environment?: string;
  sourceId?: string;
  sortBy?: 'relevance' | 'downloads' | 'rating' | 'recent';
  limit?: number;
  offset?: number;
  /** If true, only return already-cached bundles without hitting the network. */
  cacheOnly?: boolean;
}

/**
 * A `BundleUpdate` enriched with display/preference metadata, ready for a
 * UI (or CLI) to render or act on. Mirrors the production shape at
 * `src/services/update-cache.ts`.
 */
export interface UpdateCheckResult {
  bundleId: string;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  releaseDate: string;
  downloadUrl: string;
  autoUpdateEnabled: boolean;
}
