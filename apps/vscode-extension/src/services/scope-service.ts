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
   * @param options - Optional sync options (e.g., commitMode for repository scope)
   * @returns Promise that resolves when sync is complete
   */
  syncBundle(bundleId: string, bundlePath: string, options?: SyncBundleOptions): Promise<void>;

  /**
   * Remove synced files for a bundle.
   * @param bundleId - The unique identifier of the bundle to unsync
   * @returns Promise that resolves when unsync is complete
   */
  unsyncBundle(bundleId: string): Promise<void>;
}
