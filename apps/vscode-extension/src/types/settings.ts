/**
 * Registry Settings Export/Import Types
 *
 * These types define the schema for exporting and importing complete registry settings,
 * including sources, profiles, and configuration.
 */

import {
  Profile,
  RegistrySource,
} from './registry';

/**
 * Complete registry settings for export/import
 */
export interface ExportedSettings {
/** Schema version for migration compatibility */
  version: string;

  /** ISO timestamp when settings were exported */
  exportedAt: string;

  /** All registry sources */
  sources: RegistrySource[];

  /** All user profiles */
  profiles: Profile[];

  /** Extension configuration settings */
  configuration?: RegistryConfiguration;
}

/**
 * Extension configuration settings
 */
export interface RegistryConfiguration {
/** Automatically check for bundle updates */
  autoCheckUpdates?: boolean;

  /** Default installation scope (user or workspace) */
  installationScope?: string;

  /** Enable logging for debugging */
  enableLogging?: boolean;
}

/**
 * Supported export/import formats
 */
export type ExportFormat = 'json' | 'yaml';

/**
 * Import strategy for handling existing data
 */
export type ImportStrategy = 'merge' | 'replace';
