/**
 * RepositoryActivationService
 *
 * Handles detection of lockfiles on workspace open and prompts users to enable
 * repository bundles. Manages "Don't ask again" persistence and missing source/hub detection.
 *
 * Requirements covered:
 * - 13.1-13.7: Repository bundle activation prompt
 * - 12.4-12.5: Missing source/hub detection
 * - 13.6: Missing bundle installation
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  IBundleInstaller,
} from '../types/bundle-installer';
import {
  Lockfile,
} from '../types/lockfile';
import {
  Logger,
} from '../utils/logger';
import {
  generateLegacyHubSourceId,
} from '../utils/source-id-utils';
import {
  HubManager,
} from './hub-manager';
import {
  LockfileManager,
} from './lockfile-manager';
import {
  SetupStateManager,
} from './setup-state-manager';

/**
 * Result of missing source/hub detection
 */
export interface MissingSourcesResult {
  missingSources: string[];
  missingHubs: string[];
  offeredToAdd: boolean;
}

/**
 * RepositoryActivationService
 *
 * Detects lockfiles on workspace open and prompts users to enable repository bundles.
 * Uses a per-workspace instance pattern to properly handle workspace switches and
 * multi-root workspaces (similar to LockfileManager).
 */
export class RepositoryActivationService {
  private static readonly instances: Map<string, RepositoryActivationService> = new Map();

  /**
   * Get or create a RepositoryActivationService instance for a workspace.
   * Supports multi-root workspaces by maintaining separate instances per workspace.
   * @param workspaceRoot - Path to the workspace root (required)
   * @param lockfileManager - LockfileManager instance for the workspace
   * @param hubManager - HubManager instance
   * @param storage - RegistryStorage instance
   * @param bundleInstaller - Optional IBundleInstaller instance for bundle installation
   * @param setupStateManager - Optional SetupStateManager instance for checking setup completion
   * @returns RepositoryActivationService instance for the workspace
   * @throws {Error} if workspaceRoot is not provided on first call
   */
  public static getInstance(
    workspaceRoot?: string,
    lockfileManager?: LockfileManager,
    hubManager?: HubManager,
    storage?: RegistryStorage,
    bundleInstaller?: IBundleInstaller,
    setupStateManager?: SetupStateManager
  ): RepositoryActivationService {
    if (!workspaceRoot) {
      throw new Error('Workspace root path required for RepositoryActivationService.getInstance()');
    }

    // Normalize path for consistent key lookup
    const normalizedPath = path.normalize(workspaceRoot);

    if (!RepositoryActivationService.instances.has(normalizedPath)) {
      if (!lockfileManager || !hubManager || !storage) {
        throw new Error('Dependencies required on first call to RepositoryActivationService.getInstance() for a workspace');
      }
      RepositoryActivationService.instances.set(
        normalizedPath,
        new RepositoryActivationService(lockfileManager, hubManager, storage, normalizedPath, bundleInstaller, setupStateManager)
      );
    }
    return RepositoryActivationService.instances.get(normalizedPath)!;
  }

  /**
   * Reset instance(s) (for testing purposes)
   * @param workspaceRoot - If provided, reset only that workspace's instance. Otherwise, reset all instances.
   */
  public static resetInstance(workspaceRoot?: string): void {
    if (workspaceRoot) {
      const normalizedPath = path.normalize(workspaceRoot);
      RepositoryActivationService.instances.delete(normalizedPath);
    } else {
      // Reset all instances
      RepositoryActivationService.instances.clear();
    }
  }

  private readonly logger: Logger;
  private readonly DECLINED_KEY = 'repositoryActivation.declined';
  private readonly workspaceRoot: string;
  private readonly bundleInstaller?: IBundleInstaller;
  private readonly setupStateManager?: SetupStateManager;

  constructor(
    private readonly lockfileManager: LockfileManager,
    private readonly hubManager: HubManager,
    private readonly storage: RegistryStorage,
    workspaceRoot: string,
    bundleInstaller?: IBundleInstaller,
    setupStateManager?: SetupStateManager
  ) {
    this.logger = Logger.getInstance();
    this.workspaceRoot = workspaceRoot;
    this.bundleInstaller = bundleInstaller;
    this.setupStateManager = setupStateManager;
  }

  /**
   * Check if user previously declined activation for this repository
   * @param repositoryPath - Path to the repository
   * @returns True if previously declined
   */
  private async wasDeclined(repositoryPath: string): Promise<boolean> {
    const declined = await this.getDeclinedRepositories();
    return declined.includes(repositoryPath);
  }

  /**
   * Get list of declined repositories from global state
   * @returns Array of repository paths
   */
  private async getDeclinedRepositories(): Promise<string[]> {
    const context = this.storage.getContext();
    return context.globalState.get<string[]>(this.DECLINED_KEY, []);
  }

  /**
   * Extract repository path from lockfile path
   * @param lockfilePath - Full path to lockfile
   * @returns Repository root path
   */
  private getRepositoryPath(lockfilePath: string): string {
    return path.dirname(lockfilePath);
  }

  /**
   * Check if setup is complete before proceeding with source/hub detection.
   * Fail-open: if SetupStateManager is not available or throws, proceed with detection.
   */
  private async isSetupComplete(): Promise<boolean> {
    if (!this.setupStateManager) {
      this.logger.debug('SetupStateManager not available, proceeding with detection');
      return true;
    }
    try {
      return await this.setupStateManager.isComplete();
    } catch (error) {
      this.logger.warn('Failed to check setup completion, proceeding with detection', error);
      return true;
    }
  }

  /**
   * Check for lockfile and detect missing sources/hubs.
   * Called on workspace open.
   *
   * Setup Timing: Detection is deferred until first-run setup is complete.
   * This prevents confusing users with source configuration prompts before
   * they've configured the extension. If SetupStateManager is unavailable,
   * detection proceeds (fail-open behavior).
   *
   * Note: No longer shows activation prompt - files are already present in repository.
   * Only checks for missing sources and hubs that need to be configured.
   */
  public async checkAndPromptActivation(): Promise<void> {
    try {
      // Check if setup is complete before proceeding
      if (!await this.isSetupComplete()) {
        this.logger.info('First-run setup not complete, deferring source/hub detection');
        return;
      }

      // Check if lockfile exists
      const lockfile = await this.lockfileManager.read();
      if (!lockfile) {
        this.logger.debug('No lockfile found, skipping source/hub detection');
        return;
      }

      // Check if this repository was previously declined
      const lockfilePath = this.lockfileManager.getLockfilePath();
      const repositoryPath = this.getRepositoryPath(lockfilePath);

      if (await this.wasDeclined(repositoryPath)) {
        this.logger.debug(`Repository ${repositoryPath} was previously declined`);
        return;
      }

      // No longer show activation prompt - files are already in repository
      // Just check for missing sources and hubs
      await this.checkAndOfferMissingSources(lockfile);
    } catch (error) {
      this.logger.error('Failed to check and detect sources:', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Check for missing sources and hubs, offer to add them
   * @param lockfile - The lockfile to check
   * @returns Result with missing sources/hubs and whether offer was made
   */
  public async checkAndOfferMissingSources(lockfile: Lockfile): Promise<MissingSourcesResult> {
    const result: MissingSourcesResult = {
      missingSources: [],
      missingHubs: [],
      offeredToAdd: false
    };

    try {
      // Get configured sources
      const configuredSources = await this.storage.getSources();
      const configuredSourceIds = new Set(configuredSources.map((s) => s.id));

      // @migration-cleanup(sourceId-normalization-v2): Remove legacy ID set once all lockfiles are migrated
      // Build a set that also includes legacy IDs for each configured source,
      // so lockfile entries written with old-format IDs are still recognized.
      const allKnownSourceIds = new Set(configuredSourceIds);
      for (const source of configuredSources) {
        const legacyId = generateLegacyHubSourceId(source.type, source.url, {
          branch: source.config?.branch,
          collectionsPath: source.config?.collectionsPath
        });
        if (legacyId) {
          allKnownSourceIds.add(legacyId);
        }
      }

      // Check for missing sources (check both current and legacy IDs)
      const lockfileSourceIds = Object.keys(lockfile.sources);
      result.missingSources = lockfileSourceIds.filter((id) => !allKnownSourceIds.has(id));

      // Check for missing hubs
      if (lockfile.hubs) {
        const configuredHubs = await this.hubManager.listHubs();
        const configuredHubIds = new Set(configuredHubs.map((h) => h.id));

        const lockfileHubIds = Object.keys(lockfile.hubs);
        result.missingHubs = lockfileHubIds.filter((id) => !configuredHubIds.has(id));
      }

      // Offer to add missing sources/hubs
      if (result.missingSources.length > 0 || result.missingHubs.length > 0) {
        const totalMissing = result.missingSources.length + result.missingHubs.length;
        const itemType = result.missingHubs.length > 0 ? 'sources and hubs' : 'sources';

        const choice = await vscode.window.showInformationMessage(
          `${totalMissing} ${itemType} from the lockfile are not configured. Would you like to add them?`,
          'Add Sources',
          'Not now'
        );

        result.offeredToAdd = true;

        if (choice === 'Add Sources') {
          this.logger.info(`User chose to add ${totalMissing} missing ${itemType}`);
          // Note: Actual addition would be handled by RegistryManager/HubManager
          // For now, just log the intent
        }
      }
    } catch (error) {
      this.logger.error('Failed to check for missing sources/hubs:', error instanceof Error ? error : undefined);
    }

    return result;
  }
}
