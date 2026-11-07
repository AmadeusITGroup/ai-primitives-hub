/**
 * Repository listing items built from a recorded bundle entry.
 * @module services/installed-bundle-from-entry
 */
import type {
  LockfileBundleEntry,
} from '@ai-primitives-hub/app';
import type {
  DeploymentManifest,
  InstalledBundle,
  RepositoryCommitMode,
} from '../types/registry';

/** Options for creating an InstalledBundle from a recorded entry. */
export interface CreateInstalledBundleOptions {
  /** Install path; empty by default. */
  installPath?: string;
  /** Deployment manifest; a minimal one by default. */
  manifest?: DeploymentManifest;
  filesMissing?: boolean;
  /** Commit mode of the file holding the entry. */
  commitModeOverride?: RepositoryCommitMode;
}

// The record stores no manifest, so the listing gets one with the recorded file paths.
const createMinimalManifest = (bundleId: string, files: readonly { path: string }[] = []): DeploymentManifest => ({
  common: {
    directories: [],
    files: files.map((file) => file.path),
    include_patterns: [],
    exclude_patterns: []
  },
  bundle_settings: {
    include_common_in_environment_bundles: false,
    create_common_bundle: false,
    compression: 'none',
    naming: {
      environment_bundle: bundleId
    }
  },
  metadata: {
    manifest_version: '1.0.0',
    description: `Repository bundle: ${bundleId}`
  }
});

/**
 * Create a repository-scope InstalledBundle from a recorded bundle entry.
 * @param bundleId - The bundle ID.
 * @param bundleEntry - The recorded entry.
 * @param options - Conversion options.
 */
export const createInstalledBundleFromLockfile = (
  bundleId: string,
  bundleEntry: LockfileBundleEntry,
  options?: CreateInstalledBundleOptions
): InstalledBundle => ({
  bundleId,
  version: bundleEntry.version,
  installedAt: bundleEntry.installedAt,
  scope: 'repository',
  installPath: options?.installPath ?? '',
  manifest: options?.manifest ?? createMinimalManifest(bundleId, bundleEntry.files),
  sourceId: bundleEntry.sourceId,
  sourceType: bundleEntry.sourceType,
  commitMode: options?.commitModeOverride ?? bundleEntry.commitMode,
  filesMissing: options?.filesMissing
});
