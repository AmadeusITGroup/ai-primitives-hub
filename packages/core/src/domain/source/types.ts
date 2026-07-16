/**
 * Domain layer — Source types.
 *
 * Mirrors the production shape at `src/types/registry.ts`
 * (`SourceType`, `RegistrySource`, `SourceMetadata`, `SourceSyncedEvent`).
 * `ValidationResult` here consolidates two near-duplicate shapes found on
 * `main` (`src/types/registry.ts` and `src/types/hub.ts`, the latter
 * missing `warnings`/`bundlesFound`) into the one, more complete shape —
 * a superset, so existing `{ valid, errors }` call sites remain compatible.
 * @module domain/source/types
 */

/**
 * All source adapter types known to the registry.
 */
export type SourceType =
  | 'github'
  | 'local'
  | 'awesome-copilot'
  | 'local-awesome-copilot'
  | 'apm'
  | 'local-apm'
  | 'skills'
  | 'local-skills';

/**
 * A configured bundle source.
 */
export interface RegistrySource {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  enabled: boolean;
  priority: number;
  private?: boolean;
  /** Environment variable name or secure-storage key, not the token itself. */
  token?: string;
  /** Hub identifier, when this source was provisioned by a curated hub. */
  hubId?: string;
  metadata?: {
    description?: string;
    homepage?: string;
    contact?: string;
  };
  config?: {
    /** Git branch, for git-based sources. */
    branch?: string;
    /** Collections directory, for awesome-copilot sources. */
    collectionsPath?: string;
    /** Index file name, for awesome-copilot sources. */
    indexFile?: string;
    [key: string]: unknown;
  };
}

/**
 * Metadata describing a source as a whole (not a specific bundle).
 */
export interface SourceMetadata {
  name: string;
  description: string;
  bundleCount: number;
  lastUpdated: string;
  version: string;
}

/**
 * Result of validating a source, a hub reference, or a hub config.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
  bundlesFound?: number;
}

/**
 * Emitted after a source has been (re)synced.
 */
export interface SourceSyncedEvent {
  sourceId: string;
  bundleCount: number;
}
