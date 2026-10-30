/**
 * Repository listing items built from a recorded bundle entry (an old
 * `prompt-registry` lockfile entry, or a 3.0.0 tool entry mapped to that
 * shape). Shared by the install record listing and the record adapter.
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

/**
 * Options for creating an InstalledBundle from a recorded entry.
 */
export interface CreateInstalledBundleOptions {
  /** Install path (defaults to empty string if not provided) */
  installPath?: string;
  /** Deployment manifest (defaults to minimal manifest if not provided) */
  manifest?: DeploymentManifest;
  /** Whether files are missing from the filesystem */
  filesMissing?: boolean;
  /** Override the commit mode of the entry (the commit mode is implicit in the file holding it) */
  commitModeOverride?: RepositoryCommitMode;
}

/**
 * Create a minimal deployment manifest for a repository bundle. The record
 * stores no manifest, so it lists only the recorded file paths.
 * @param bundleId - The bundle ID
 * @param files - Recorded files of the entry
 * @returns Minimal DeploymentManifest object
 */
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
 * @param bundleId - The bundle ID
 * @param bundleEntry - The recorded entry
 * @param options - Optional configuration for the conversion
 * @returns InstalledBundle object
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
