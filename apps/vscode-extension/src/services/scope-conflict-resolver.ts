/**
 * Scope Conflict Resolver
 *
 * Handles scope migration for bundles, ensuring a bundle exists at only one scope
 * at a time. Provides migration with automatic rollback on failure.
 *
 * Requirements: 6.4-6.6
 */

import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  InstallationScope,
  InstalledBundle,
} from '../types/registry';
import {
  getInstalledBundleForScope,
} from '../utils/bundle-scope-utils';
import {
  Logger,
} from '../utils/logger';

/**
 * Result of a bundle migration operation.
 */
export interface MigrationResult {
  /** Whether the migration was successful */
  success: boolean;
  /** The bundle ID that was migrated */
  bundleId: string;
  /** The scope the bundle was migrated from */
  fromScope: InstallationScope;
  /** The scope the bundle was migrated to */
  toScope: InstallationScope;
  /** Error message if migration failed */
  error?: string;
  /** Whether a rollback was attempted after install failure */
  rollbackAttempted?: boolean;
  /** Whether the rollback was successful */
  rollbackSucceeded?: boolean;
}

/**
 * Callback type for uninstalling a bundle during migration.
 */
export type UninstallCallback = (installedBundle: InstalledBundle) => Promise<void>;

/**
 * Callback type for installing a bundle during migration.
 */
export type InstallCallback = (installedBundle: InstalledBundle, targetScope: InstallationScope) => Promise<void>;

/**
 * Service for migrating bundles between scopes with rollback capability.
 *
 * Ensures that a bundle can only exist at one scope at a time,
 * preventing configuration conflicts between user and repository levels.
 */
export class ScopeConflictResolver {
  private readonly logger: Logger;

  constructor(private readonly storage: RegistryStorage) {
    this.logger = Logger.getInstance();
  }

  /**
   * Get installed bundle from the appropriate source based on scope.
   * Delegates to shared utility that handles lockfile vs storage lookup.
   * @param bundleId
   * @param scope
   */
  private async getInstalledBundleForScope(bundleId: string, scope: InstallationScope): Promise<InstalledBundle | undefined> {
    return getInstalledBundleForScope(this.storage, bundleId, scope);
  }

  /**
   * Migrate a bundle from one scope to another.
   *
   * This operation:
   * 1. Verifies the bundle exists at the source scope
   * 2. Uninstalls from the source scope
   * 3. Installs at the target scope
   * 4. If install fails, attempts rollback by re-installing at original scope
   *
   * If any step fails, the migration is aborted and an error is returned.
   * If install fails after uninstall succeeds, a rollback is attempted.
   * @param bundleId - The bundle ID to migrate
   * @param fromScope - The current scope of the bundle
   * @param toScope - The target scope for migration
   * @param uninstallCallback - Function to uninstall the bundle
   * @param installCallback - Function to install the bundle at new scope
   * @returns MigrationResult indicating success or failure
   *
   * Requirements: 6.4, 6.5
   */
  public async migrateBundle(
    bundleId: string,
    fromScope: InstallationScope,
    toScope: InstallationScope,
    uninstallCallback: UninstallCallback,
    installCallback: InstallCallback
  ): Promise<MigrationResult> {
    this.logger.info(`[ScopeConflictResolver] Migrating bundle ${bundleId} from ${fromScope} to ${toScope}`);

    const result: MigrationResult = {
      success: false,
      bundleId,
      fromScope,
      toScope
    };

    try {
      // Step 1: Verify bundle exists at source scope
      // Use the scope-aware helper that checks lockfile for repository scope
      const installedBundle = await this.getInstalledBundleForScope(bundleId, fromScope);

      if (!installedBundle) {
        result.error = `Bundle ${bundleId} is not installed at ${fromScope} scope`;
        this.logger.warn(`[ScopeConflictResolver] ${result.error}`);
        return result;
      }

      // Step 2: Uninstall from source scope
      this.logger.debug(`[ScopeConflictResolver] Uninstalling bundle ${bundleId} from ${fromScope}`);
      try {
        await uninstallCallback(installedBundle);
      } catch (error) {
        result.error = `Failed to uninstall from ${fromScope}: ${(error as Error).message}`;
        this.logger.error(`[ScopeConflictResolver] ${result.error}`);
        return result;
      }

      // Step 3: Install at target scope
      this.logger.debug(`[ScopeConflictResolver] Installing bundle ${bundleId} at ${toScope}`);
      try {
        await installCallback(installedBundle, toScope);
      } catch (installError) {
        const installErrorMessage = (installError as Error).message;
        this.logger.error(`[ScopeConflictResolver] Failed to install at ${toScope}: ${installErrorMessage}`);

        // Step 4: Attempt rollback - re-install at original scope
        result.rollbackAttempted = true;
        this.logger.info(`[ScopeConflictResolver] Attempting rollback: re-installing bundle ${bundleId} at ${fromScope}`);

        try {
          await installCallback(installedBundle, fromScope);
          result.rollbackSucceeded = true;
          result.error = `Failed to install at ${toScope}: ${installErrorMessage}. Rollback successful - bundle restored at ${fromScope}.`;
          this.logger.info(`[ScopeConflictResolver] Rollback successful: bundle ${bundleId} restored at ${fromScope}`);
        } catch (rollbackError) {
          result.rollbackSucceeded = false;
          const rollbackErrorMessage = (rollbackError as Error).message;
          result.error = `Failed to install at ${toScope}: ${installErrorMessage}. Rollback also failed: ${rollbackErrorMessage}. Bundle may be in inconsistent state.`;
          this.logger.error(`[ScopeConflictResolver] Rollback failed for bundle ${bundleId}: ${rollbackErrorMessage}`);
        }

        return result;
      }

      result.success = true;
      this.logger.info(`[ScopeConflictResolver] Successfully migrated bundle ${bundleId} from ${fromScope} to ${toScope}`);
      return result;
    } catch (error) {
      result.error = `Migration failed: ${(error as Error).message}`;
      this.logger.error(`[ScopeConflictResolver] ${result.error}`);
      return result;
    }
  }
}
