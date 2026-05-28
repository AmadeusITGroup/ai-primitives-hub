/**
 * Bundle Installer Interface Types
 *
 * Defines interfaces for bundle installation operations to avoid circular dependencies.
 * Services that need to install bundles can depend on this interface rather than
 * directly importing RegistryManager.
 */

import {
  InstalledBundle,
  InstallOptions,
} from './registry';

/**
 * Interface for bundle installation operations.
 *
 * This interface breaks the circular dependency between RepositoryActivationService
 * and RegistryManager by defining a minimal contract for bundle installation.
 *
 * Implementations:
 * - RegistryManager implements this interface
 * - Services that need to install bundles depend on this interface
 */
export interface IBundleInstaller {
  /**
   * Install a bundle with the given options.
   * @param bundleId - The unique identifier of the bundle to install
   * @param options - Installation options including scope and version
   * @param silent - If true, suppress user notifications
   * @returns Promise resolving to the installed bundle information
   */
  installBundle(bundleId: string, options: InstallOptions, silent?: boolean): Promise<InstalledBundle>;
}
