/**
 * List installed bundles across scopes — ported from the extension's
 * `src/services/registry-manager.ts`
 * (`RegistryManager.listInstalledBundles`).
 *
 * Repository-scoped installs are lockfile-backed (via `LockfileManager`,
 * not yet ported — see the migration plan's `RegistryManager` scoping
 * pass) so this module only orchestrates *which* store(s) to query for
 * a given scope; the actual repository-bundle read, including resolving
 * the workspace root and tolerating a missing/unreadable lockfile, is a
 * caller-supplied port kept deliberately opaque here (see
 * `ListInstalledBundlesPorts.getRepositoryInstalledBundles`).
 * @module registry/list-installed-bundles
 */
import type {
  InstallationScope,
  InstalledBundle,
} from '@ai-primitives-hub/core';

/**
 * Read access `listInstalledBundles` needs: user/workspace installs
 * (the extension's `RegistryStorage`) and repository installs (the
 * extension's lockfile-backed adapter). Kept as two separate methods
 * rather than a single `getInstalledBundles(scope)` covering all three
 * scopes, since the two backing stores are unrelated today.
 */
export interface ListInstalledBundlesPorts {
  getInstalledBundles(scope?: InstallationScope): Promise<InstalledBundle[]>;
  getRepositoryInstalledBundles(): Promise<InstalledBundle[]>;
}

/**
 * List installed bundles, combining the storage port (user/workspace)
 * and the repository port depending on `scope`:
 * - `'repository'`: repository installs only.
 * - `'user'` | `'workspace'`: that scope's storage installs only.
 * - `undefined`: both storage (all scopes) and repository installs.
 * @param scope - Scope filter, or `undefined` to combine all scopes.
 * @param ports - Read access to both backing stores.
 */
export async function listInstalledBundles(
  scope: InstallationScope | undefined,
  ports: ListInstalledBundlesPorts
): Promise<InstalledBundle[]> {
  const bundles: InstalledBundle[] = [];

  // Query user/workspace bundles from the storage port
  if (scope !== 'repository') {
    const storageBundles = await ports.getInstalledBundles(scope);
    bundles.push(...storageBundles);
  }

  // Query repository bundles from the repository port
  if (scope === 'repository' || scope === undefined) {
    const repoBundles = await ports.getRepositoryInstalledBundles();
    bundles.push(...repoBundles);
  }

  return bundles;
}
