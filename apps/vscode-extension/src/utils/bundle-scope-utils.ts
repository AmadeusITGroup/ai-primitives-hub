/**
 * Bundle Scope Utilities
 *
 * Shared utilities for working with bundle scopes across different services.
 * Handles the complexity of repository scope bundles being tracked via LockfileManager
 * while user/workspace scopes use RegistryStorage.
 */

import {
  LockfileManager,
} from '../services/lockfile-manager';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  InstallationScope,
  InstalledBundle,
} from '../types/registry';
import {
  Logger,
} from './logger';
import {
  getWorkspaceRoot,
} from './scope-selection-ui';

/**
 * Get installed bundle from the appropriate source based on scope.
 *
 * Repository scope bundles are tracked via LockfileManager, not RegistryStorage.
 * Falls back to RegistryStorage if no workspace is available or lockfile doesn't have the bundle.
 * @param storage - The RegistryStorage instance
 * @param bundleId - The bundle ID to look up
 * @param scope - The scope to check
 * @returns InstalledBundle if found, undefined otherwise
 */
export async function getInstalledBundleForScope(
    storage: RegistryStorage,
    bundleId: string,
    scope: InstallationScope
): Promise<InstalledBundle | undefined> {
  const logger = Logger.getInstance();

  if (scope === 'repository') {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      // Fall back to storage if no workspace is available (for testing)
      return storage.getInstalledBundle(bundleId, scope);
    }

    try {
      const lockfileManager = LockfileManager.getInstance(workspaceRoot);
      // Use getInstalledBundles() to search both main and local lockfiles
      const installedBundles = await lockfileManager.getInstalledBundles();
      const bundle = installedBundles.find((b) => b.bundleId === bundleId);

      if (bundle) {
        return bundle;
      }

      // Fall back to storage if lockfile doesn't have the bundle (for testing/backward compatibility)
      return storage.getInstalledBundle(bundleId, scope);
    } catch (error) {
      logger.warn(`[bundleScopeUtils] Failed to read lockfile for bundle ${bundleId}:`, error instanceof Error ? error : undefined);
      // Fall back to storage on error
      return storage.getInstalledBundle(bundleId, scope);
    }
  }

  // User and workspace scopes use RegistryStorage
  return storage.getInstalledBundle(bundleId, scope);
}
