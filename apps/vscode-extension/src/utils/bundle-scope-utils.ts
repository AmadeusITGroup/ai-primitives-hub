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
  recordIdentityOf,
} from '@ai-primitives-hub/app';
import {
  ExtensionRecordAdapter,
} from '../services/extension-record-adapter';
import {
  InstallRecordListing,
  type UserRecordItems,
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

/** Where the shared user record's items are read from. */
export interface UserRecordReader {
  /** Adapter holding the user record location and the host tool. */
  adapter: ExtensionRecordAdapter;
  /** RegistryStorage, for an item's bundle cache folder. */
  storage: RegistryStorage;
  /** Listing to read with; a new one by default. */
  listing?: InstallRecordListing;
}

const noUserRecordItems = (): UserRecordItems => ({ items: [], hostBundleIds: new Set(), hostKeys: new Map() });

/**
 * User-scope items of the shared user record and its host-tool keys;
 * none in WSL or when the record cannot be read.
 * @param reader - Adapter, storage and listing to read with.
 */
export const listUserRecordBundles = async (reader: UserRecordReader): Promise<UserRecordItems> => {
  const { adapter, storage } = reader;
  if (!adapter.usesSharedUserRecord()) {
    return noUserRecordItems();
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
    return noUserRecordItems();
  }
};

/**
 * Whether a user-scope item is the same bundle as a host-tool key of the user
 * record, at any version; the record's item then wins over it.
 * @param listed - Result of {@link listUserRecordBundles}.
 * @param bundle - Item from elsewhere, e.g. RegistryStorage.
 */
export const isInUserRecord = (listed: UserRecordItems, bundle: Pick<InstalledBundle, 'bundleId' | 'version'>): boolean =>
  listed.hostKeys.has(bundle.bundleId) || new Set(listed.hostKeys.values()).has(recordIdentityOf(bundle.bundleId, bundle.version));

/**
 * The shared user record's host-tool item of a bundle: under its key, or the
 * one listed for the same identity; `undefined` in WSL or when the record cannot be read.
 * @param reader - Adapter, storage and listing to read with.
 * @param bundleId - Bundle id.
 * @param version - Version `bundleId` carries; without it, a key of the user record or a bare identity.
 */
export const findUserRecordBundle = async (reader: UserRecordReader, bundleId: string, version?: string): Promise<InstalledBundle | undefined> => {
  const { items, hostBundleIds, hostKeys } = await listUserRecordBundles(reader);
  if (hostBundleIds.has(bundleId)) {
    return items.find((bundle) => bundle.bundleId === bundleId);
  }
  const identity = hostKeys.get(bundleId) ?? (version === undefined ? bundleId : recordIdentityOf(bundleId, version));
  return items.find((bundle) => hostBundleIds.has(bundle.bundleId) && hostKeys.get(bundle.bundleId) === identity);
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

  // At user scope, fall back to the shared user record's host-tool item.
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
