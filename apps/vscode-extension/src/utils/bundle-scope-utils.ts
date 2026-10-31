/**
 * Bundle Scope Utilities
 *
 * Shared utilities for working with bundle scopes across different services.
 * Repository scope bundles come from the install record and the old
 * lockfiles; user/workspace scopes use RegistryStorage, and user scope also
 * the shared user record.
 */

import * as path from 'node:path';
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

/** Lists the repository bundles of a workspace folder. */
export type RepositoryBundleLister = (workspaceRoot: string) => Promise<InstalledBundle[]>;

/**
 * A repository bundle lister for callers that hold only a `RegistryStorage`.
 * @param storage - The RegistryStorage instance.
 */
export const createRepositoryBundleLister = (storage: RegistryStorage): RepositoryBundleLister => {
  const adapter = new ExtensionRecordAdapter({ sources: { listSources: () => storage.getSources() } });
  const listing = new InstallRecordListing({ fs: adapter.fs, store: adapter.store });
  return (workspaceRoot) => listing.listRepositoryBundles(workspaceRoot, () => adapter.listOldBundles(workspaceRoot));
};

/**
 * Get installed bundle from the appropriate source based on scope.
 *
 * Falls back to RegistryStorage when no workspace is open or the repository listing lacks the bundle.
 * @param storage - The RegistryStorage instance
 * @param bundleId - The bundle ID to look up
 * @param scope - The scope to check
 * @param listRepository - Repository listing; built over `storage` by default
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

  // User and workspace scopes use RegistryStorage; at user scope, the shared
  // user record's host-tool item when RegistryStorage has none (BR16.x).
  const stored = await storage.getInstalledBundle(bundleId, scope);
  return stored !== undefined || scope !== 'user' ? stored : findUserRecordBundle(storage, bundleId);
}

/**
 * The shared user record's item for a bundle, when the record holds the host
 * tool's entry (BR16.x); `undefined` in WSL or when the record cannot be read.
 * @param storage - The RegistryStorage instance (configured sources, user record path, bundle cache root).
 * @param bundleId - The bundle ID to look up.
 */
const findUserRecordBundle = async (storage: RegistryStorage, bundleId: string): Promise<InstalledBundle | undefined> => {
  try {
    const paths = storage.getPaths();
    const adapter = new ExtensionRecordAdapter({ sources: { listSources: () => storage.getSources() }, userRecordPath: paths.userRecord });
    if (!adapter.usesSharedUserRecord()) {
      return undefined;
    }
    const { items, hostBundleIds } = await new InstallRecordListing().listUserBundles(
      adapter.userLocation(),
      adapter.hostTool,
      (id) => path.join(paths.root, 'bundles', id)
    );
    return hostBundleIds.has(bundleId) ? items.find((bundle) => bundle.bundleId === bundleId) : undefined;
  } catch (error) {
    Logger.getInstance().warn(`[bundleScopeUtils] Failed to read the user record for bundle ${bundleId}:`, error instanceof Error ? error : undefined);
    return undefined;
  }
};
