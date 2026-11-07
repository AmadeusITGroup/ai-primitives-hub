/**
 * Extension-only storage types: the per-profile bundle-record folders
 * `RegistryStorage` uses, which are not on the shared `AppStorage` port.
 * @module storage/extension-app-storage
 */

import type {
  AppStorage,
  AppStoragePaths,
} from '@ai-primitives-hub/core';

/** The shared storage paths plus the extension's per-profile record folders. */
export interface ExtensionStoragePaths extends AppStoragePaths {
  /** Bundle records, workspace scope (`<globalStorage>/installed`). */
  installed: string;
  /** Bundle records, user scope (`<globalStorage>/installed/user`). */
  userInstalled: string;
  /** Bundle records for profile-driven installs (`<globalStorage>/installed/profiles`). */
  profilesInstalled: string;
}

/** The shared `AppStorage` with the extension's record folders in its paths. */
export interface ExtensionAppStorage extends AppStorage {
  /** Resolve the shared paths plus the extension's record folders. */
  getPaths(): ExtensionStoragePaths;
}
