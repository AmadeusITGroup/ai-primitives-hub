import type {
  InstalledFileRecord,
  Target,
  TargetWritePlan,
  TargetWriteResult,
} from '@ai-primitives-hub/core';

/**
 * IScopeService Interface
 *
 * Defines the contract for scope-specific bundle installation services.
 * Both UserScopeService and RepositoryScopeService implement this interface
 * to provide consistent bundle syncing behavior across different installation scopes.
 *
 * Requirements: 1.2, 9.1-9.5
 */

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
   * Shared target write plan produced by the install pipeline.
   * When supplied, scope services must execute these exact operations instead
   * of reparsing the bundle manifest from disk.
   */
  targetPlan?: TargetWritePlan;
  /** Exact records from the installation being replaced, when updating. */
  installedFiles?: readonly InstalledFileRecord[];
}

export interface UnsyncBundleOptions {
  installedFiles?: readonly InstalledFileRecord[];
}

export interface UnsyncBundleResult {
  retained: readonly InstalledFileRecord[];
}

/**
 * Interface for scope-specific bundle installation services.
 *
 * Implementations handle the details of where and how bundle files
 * are placed based on the installation scope (user vs repository).
 */
export interface IScopeService {
  /** Resolve scope-specific target roots before shared target planning. */
  resolveTarget?(target: Target): Target;

  /**
   * Sync a bundle's files to the appropriate Copilot directories.
   * @param bundleId - The unique identifier of the bundle
   * @param bundlePath - The path to the installed bundle directory
   * @param options - Optional sync options (e.g., commitMode for repository scope)
   * @returns The actual installed records written by the scope service
   */
  syncBundle(bundleId: string, bundlePath: string, options?: SyncBundleOptions): Promise<TargetWriteResult>;

  /**
   * Remove synced files for a bundle.
   * @param bundleId - The unique identifier of the bundle to unsync
   * @returns Promise that resolves when unsync is complete
   */
  unsyncBundle(bundleId: string, options?: UnsyncBundleOptions): Promise<UnsyncBundleResult>;
}
