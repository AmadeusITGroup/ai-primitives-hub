/**
 * Bundle Scope Utilities
 *
 * Shared utilities for working with bundle scopes across different services.
 * Repository scope bundles are tracked in the install record (the 3.0.0
 * record files merged with the old `prompt-registry` lockfiles), while
 * user/workspace scopes use RegistryStorage.
 */

import {
  ExtensionRecordAdapter,
} from '../services/extension-record-adapter';
import {
  InstallRecordListing,
} from '../services/install-record-listing';
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
 * Lists the repository bundles of a workspace folder (the merged listing,
 * `RegistryManager.listRepositoryBundles`).
 */
export type RepositoryBundleLister = (workspaceRoot: string) => Promise<InstalledBundle[]>;

/**
 * A lister over the install record and the old lockfiles, for callers that
 * hold only a `RegistryStorage`.
 * @param storage - The RegistryStorage instance (configured sources).
 * @returns The lister.
 */
export const createRepositoryBundleLister = (storage: RegistryStorage): RepositoryBundleLister => {
  const listing = new InstallRecordListing();
  const adapter = new ExtensionRecordAdapter({ sources: { listSources: () => storage.getSources() } });
  return (workspaceRoot) => listing.listRepositoryBundles(workspaceRoot, () => adapter.listOldBundles(workspaceRoot));
};

/**
 * Get installed bundle from the appropriate source based on scope.
 *
 * Repository scope bundles come from the merged repository listing.
 * Falls back to RegistryStorage if no workspace is available or the listing doesn't have the bundle.
 * @param storage - The RegistryStorage instance
 * @param bundleId - The bundle ID to look up
 * @param scope - The scope to check
 * @param listRepository - Repository listing; one over the record and old lockfiles by default
 * @returns InstalledBundle if found, undefined otherwise
 */
export async function getInstalledBundleForScope(
    storage: RegistryStorage,
    bundleId: string,
    scope: InstallationScope,
    listRepository?: RepositoryBundleLister
): Promise<InstalledBundle | undefined> {
  const logger = Logger.getInstance();

  if (scope === 'repository') {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      // Fall back to storage if no workspace is available (for testing)
      return storage.getInstalledBundle(bundleId, scope);
    }

    try {
      const lister = listRepository ?? createRepositoryBundleLister(storage);
      const bundle = (await lister(workspaceRoot)).find((b) => b.bundleId === bundleId);
      if (bundle) {
        return bundle;
      }
      // Fall back to storage if the record doesn't have the bundle (for testing/backward compatibility)
      return storage.getInstalledBundle(bundleId, scope);
    } catch (error) {
      logger.warn(`[bundleScopeUtils] Failed to read the install record for bundle ${bundleId}:`, error instanceof Error ? error : undefined);
      return storage.getInstalledBundle(bundleId, scope);
    }
  }

  // User and workspace scopes use RegistryStorage
  return storage.getInstalledBundle(bundleId, scope);
}
