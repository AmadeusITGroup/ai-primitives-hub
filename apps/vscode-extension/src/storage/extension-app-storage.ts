/**
 * Extension-only storage types.
 *
 * The shared `AppStorage` port (core) carries the paths every client uses.
 * The VS Code extension also keeps its own per-profile bundle records
 * (`RegistryStorage`) under its global storage; those folders belong to the
 * extension alone, so they are declared here instead of on the shared port.
 * Their names and contents are unchanged from earlier releases, so records
 * written before are read as before.
 * @module storage/extension-app-storage
 */

import type {
  AppStorage,
  AppStoragePaths,
} from '@ai-primitives-hub/core';

/**
 * The shared storage paths plus the extension's per-profile bundle-record
 * folders under its global storage.
 */
export interface ExtensionStoragePaths extends AppStoragePaths {
  /** Bundle records, workspace scope (`<globalStorage>/installed`). */
  installed: string;
  /** Bundle records, user scope (`<globalStorage>/installed/user`). */
  userInstalled: string;
  /** Bundle records for profile-driven installs (`<globalStorage>/installed/profiles`). */
  profilesInstalled: string;
}

/**
 * The extension's storage port: the shared `AppStorage` whose paths also
 * carry the per-profile bundle-record folders.
 */
export interface ExtensionAppStorage extends AppStorage {
  /** Resolve the shared paths plus the extension's bundle-record folders. */
  getPaths(): ExtensionStoragePaths;
}
