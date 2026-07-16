/**
 * Domain layer — registry settings export/import types.
 *
 * Mirrors the production shape at `src/types/settings.ts`. Named
 * `ExportedSettingsConfiguration` here (not `RegistryConfiguration`,
 * the extension's own name for this type) to avoid colliding with
 * `domain/hub/types.ts`'s unrelated `RegistryConfiguration` (a hub's
 * own sync/strict-mode config) — both are called `RegistryConfiguration`
 * in the extension source too, but never wildcard-re-exported into the
 * same namespace there, so the collision only surfaces here.
 * @module domain/registry/settings
 */
import type {
  RegistrySource,
} from '../source/types';
import type {
  Profile,
} from './types';

/**
 * Extension configuration settings included in an export/import.
 */
export interface ExportedSettingsConfiguration {
  /** Automatically check for bundle updates. */
  autoCheckUpdates?: boolean;
  /** Default installation scope (user or workspace). */
  installationScope?: string;
  /** Enable logging for debugging. */
  enableLogging?: boolean;
}

/**
 * Complete registry settings for export/import.
 */
export interface ExportedSettings {
  /** Schema version for migration compatibility. */
  version: string;
  /** ISO timestamp when settings were exported. */
  exportedAt: string;
  /** All registry sources. */
  sources: RegistrySource[];
  /** All user profiles. */
  profiles: Profile[];
  /** Extension configuration settings. */
  configuration?: ExportedSettingsConfiguration;
}

/**
 * Supported export/import formats.
 */
export type ExportFormat = 'json' | 'yaml';

/**
 * Import strategy for handling existing data.
 */
export type ImportStrategy = 'merge' | 'replace';
