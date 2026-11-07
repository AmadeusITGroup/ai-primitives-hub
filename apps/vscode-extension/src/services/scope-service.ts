/**
 * IScopeService Interface
 *
 * Defines the contract for scope-specific bundle installation services.
 * Both UserScopeService and RepositoryScopeService implement this interface
 * to provide consistent bundle syncing behavior across different installation scopes.
 *
 * Requirements: 1.2, 9.1-9.5
 */
import type {
  ApplyBundleInstallResult,
  ApplyBundleUninstallResult,
} from '@ai-primitives-hub/app';
import type {
  ExtractedFiles,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import type {
  LockfileSourceEntry,
} from '../types/lockfile';
import type {
  InstallationScope,
} from '../types/registry';

/**
 * The extracted bundle a scope installs from (repository scope).
 */
export interface SyncBundleInstall {
  /** Every file of the archive, file modes kept. */
  files: ExtractedFiles;
  /** Validated manifest of `files`. */
  manifest: ValidatedManifest;
  /** Where the bundle came from; `checksum` is the archive's sha256. */
  origin: { sourceId: string; sourceType: string; checksum?: string };
  /** Source recorded in the lockfile under `origin.sourceId`. */
  source: LockfileSourceEntry;
  /** Install the content the host supports and report the rest (default all-or-nothing). */
  skipUnsupported?: boolean;
}

/**
 * Options for syncing a bundle to a scope.
 */
export interface SyncBundleOptions {
  /**
   * Commit mode for repository scope installations.
   * - 'commit': Files are tracked by Git (default)
   * - 'local-only': Files are excluded via .git/info/exclude
   *
   * Only applicable for RepositoryScopeService.
   */
  commitMode?: 'commit' | 'local-only';
  /**
   * The extracted bundle. Required at repository scope, which installs
   * from the archive; ignored by the user scope, which reads `bundlePath`.
   */
  install?: SyncBundleInstall;
}

/**
 * Options for removing a bundle's synced files.
 */
export interface UnsyncBundleOptions {
  /** Scope the bundle was installed at. */
  scope?: InstallationScope;
}

/**
 * Interface for scope-specific bundle installation services.
 *
 * Implementations handle the details of where and how bundle files
 * are placed based on the installation scope (user vs repository).
 */
export interface IScopeService {
  /**
   * Sync a bundle's files to the appropriate Copilot directories.
   * @param bundleId - The unique identifier of the bundle
   * @param bundlePath - The path to the installed bundle directory
   * @param options - Optional sync options (commit mode, extracted bundle)
   * @returns The shared install's outcome, or `undefined` for a scope that
   *   does not install through it
   */
  syncBundle(bundleId: string, bundlePath: string, options?: SyncBundleOptions): Promise<ApplyBundleInstallResult | undefined>;

  /**
   * Remove synced files for a bundle.
   * @param bundleId - The unique identifier of the bundle to unsync
   * @param options - Optional unsync options
   * @returns The shared uninstall's outcome, or `undefined` for a scope that
   *   does not uninstall through it
   */
  unsyncBundle(bundleId: string, options?: UnsyncBundleOptions): Promise<ApplyBundleUninstallResult | undefined>;

  /**
   * Check that the bundle can be installed, writing nothing. Rejects as
   * `syncBundle` would for content the host cannot install.
   * @param bundleId - The unique identifier of the bundle
   * @param options - The sync options `syncBundle` will get
   */
  preflightBundle?(bundleId: string, options: SyncBundleOptions): Promise<void>;
}
