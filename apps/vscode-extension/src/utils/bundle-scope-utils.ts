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
 * Where the shared user record's items are read from (BR16.x).
 */
export interface UserRecordReader {
  /** Adapter holding the user record location and the host tool. */
  adapter: ExtensionRecordAdapter;
  /** RegistryStorage, for the bundle cache folder an item's install path points at. */
  storage: RegistryStorage;
  /** Listing to read with; one over the adapter's filesystem and store by default. */
  listing?: InstallRecordListing;
}

/**
 * User-scope items of the shared user record, with the ids it holds for the
 * host tool (BR16.x); none in WSL or when the record cannot be read (logged).
 * @param reader - Adapter, storage and listing to read with.
 * @returns The items and the host tool's bundle ids.
 */
export const listUserRecordBundles = async (reader: UserRecordReader): Promise<{ items: InstalledBundle[]; hostBundleIds: Set<string> }> => {
  const { adapter, storage } = reader;
  if (!adapter.usesSharedUserRecord()) {
    return { items: [], hostBundleIds: new Set() };
  }
  try {
    const listing = reader.listing ?? new InstallRecordListing({ fs: adapter.fs, store: adapter.store });
    return await listing.listUserBundles(
      adapter.userLocation(),
      adapter.hostTool,
      (bundleId) => path.join(storage.getPaths().root, 'bundles', bundleId)
    );
  } catch (error) {
    Logger.getInstance().warn('Failed to query user bundles from the user record:', error instanceof Error ? error : undefined);
    return { items: [], hostBundleIds: new Set() };
  }
};

/**
 * The shared user record's item for a bundle, when the record holds the host
 * tool's entry for it (BR16.x); `undefined` in WSL or when the record cannot
 * be read. RegistryManager and {@link getInstalledBundleForScope} both use it.
 * @param reader - Adapter, storage and listing to read with.
 * @param bundleId - Bundle id.
 */
// Layer 5 adds an `options: { withLoneUnknown?: boolean } = {}` parameter here
// (an item whose only entry is a migrated `unknown` one, BR21.4) rather than a copy.
export const findUserRecordBundle = async (reader: UserRecordReader, bundleId: string): Promise<InstalledBundle | undefined> => {
  const { items, hostBundleIds } = await listUserRecordBundles(reader);
  return hostBundleIds.has(bundleId) ? items.find((bundle) => bundle.bundleId === bundleId) : undefined;
};

/**
 * Get installed bundle from the appropriate source based on scope.
 *
 * Falls back to RegistryStorage when no workspace is open or the repository listing lacks the bundle.
 * @param storage - The RegistryStorage instance
 * @param bundleId - The bundle ID to look up
 * @param scope - The scope to check
 * @param listRepository - Repository listing; built over `storage` by default
 * @param userRecord - Adapter and listing for the shared user record; built over `storage` by default
 * @returns InstalledBundle if found, undefined otherwise
 */
export async function getInstalledBundleForScope(
    storage: RegistryStorage,
    bundleId: string,
    scope: InstallationScope,
    listRepository?: RepositoryBundleLister,
    userRecord?: Omit<UserRecordReader, 'storage'>
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
  if (stored !== undefined || scope !== 'user') {
    return stored;
  }
  try {
    const adapter = userRecord?.adapter
      ?? new ExtensionRecordAdapter({ sources: { listSources: () => storage.getSources() }, userRecordPath: storage.getPaths().userRecord });
    return await findUserRecordBundle({ adapter, storage, listing: userRecord?.listing }, bundleId);
  } catch (error) {
    logger.warn(`[bundleScopeUtils] Failed to read the user record for bundle ${bundleId}:`, error instanceof Error ? error : undefined);
    return undefined;
  }
}
