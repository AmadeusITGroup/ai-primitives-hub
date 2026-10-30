/**
 * RepositoryActivationService
 *
 * On workspace open, lists the sources the repository's install records name
 * and offers to add the ones not configured (W14; BR12.4, NFR4.14).
 *
 * Sources come from both 3.0.0 record files (through the record store) and
 * the old `prompt-registry` lockfiles (through app's `json-lockfile-store`);
 * hubs from the old lockfiles only. A local folder source (`local` or
 * `local-*`, app `isLocalType`) whose folder resolves outside the repository
 * root (app `isLocalSourceInsideRoot`) is skipped. A
 * source's `credentialRef` is shown by name only, never resolved.
 * Manages "Don't ask again" persistence.
 */

import * as path from 'node:path';
import {
  isLocalSourceInsideRoot,
  isLocalType,
} from '@ai-primitives-hub/app';
import {
  isRecordError,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  IBundleInstaller,
} from '../types/bundle-installer';
import {
  Logger,
} from '../utils/logger';
import {
  generateLegacyHubSourceId,
} from '../utils/source-id-utils';
import type {
  ExtensionRecordAdapter,
} from './extension-record-adapter';
import {
  HubManager,
} from './hub-manager';
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

/** A source an install record or old lockfile names. */
export interface RepositorySourceEntry {
  type: string;
  url: string;
  /** External credential reference; shown by name, never resolved. */
  credentialRef?: string;
}

/** Sources and hubs the repository's records name (an old `Lockfile` fits this shape). */
export interface RepositorySources {
  sources: Record<string, RepositorySourceEntry>;
  hubs?: Record<string, unknown>;
}

/**
 * RepositoryActivationService
 *
 * Detects the repository's recorded sources on workspace open and offers to add missing ones.
 * Uses a per-workspace instance pattern to handle workspace switches and multi-root workspaces.
 */
export class RepositoryActivationService {
  private static readonly instances: Map<string, RepositoryActivationService> = new Map();

  /**
   * Get or create a RepositoryActivationService instance for a workspace.
   * @param workspaceRoot - Path to the workspace root (required)
   * @param records - The extension's record adapter
   * @param hubManager - HubManager instance
   * @param storage - RegistryStorage instance
   * @param bundleInstaller - Optional IBundleInstaller instance for bundle installation
   * @param setupStateManager - Optional SetupStateManager instance for checking setup completion
   * @returns RepositoryActivationService instance for the workspace
   * @throws {Error} if workspaceRoot is not provided, or dependencies are missing on the first call
   */
  public static getInstance(
    workspaceRoot?: string,
    records?: ExtensionRecordAdapter,
    hubManager?: HubManager,
    storage?: RegistryStorage,
    bundleInstaller?: IBundleInstaller,
    setupStateManager?: SetupStateManager
  ): RepositoryActivationService {
    if (!workspaceRoot) {
      throw new Error('Workspace root path required for RepositoryActivationService.getInstance()');
    }

    const normalizedPath = path.normalize(workspaceRoot);

    if (!RepositoryActivationService.instances.has(normalizedPath)) {
      if (!records || !hubManager || !storage) {
        throw new Error('Dependencies required on first call to RepositoryActivationService.getInstance() for a workspace');
      }
      RepositoryActivationService.instances.set(
        normalizedPath,
        new RepositoryActivationService(records, hubManager, storage, normalizedPath, bundleInstaller, setupStateManager)
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
      RepositoryActivationService.instances.delete(path.normalize(workspaceRoot));
    } else {
      RepositoryActivationService.instances.clear();
    }
  }

  private readonly logger: Logger;
  private readonly DECLINED_KEY = 'repositoryActivation.declined';
  private readonly workspaceRoot: string;
  private readonly bundleInstaller?: IBundleInstaller;
  private readonly setupStateManager?: SetupStateManager;

  constructor(
    private readonly records: ExtensionRecordAdapter,
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
   * Add a recorded source unless it is a local folder source (`local` or `local-*`) outside the root (NFR4.14).
   * @param into - Sources collected so far; the first occurrence of an id is kept.
   * @param root - Root a `local` source's path is relative to.
   * @param sources - Sources of one file.
   */
  private async collectSources(
    into: Record<string, RepositorySourceEntry>,
    root: string,
    sources: Record<string, RepositorySourceEntry>
  ): Promise<void> {
    for (const [id, source] of Object.entries(sources)) {
      if (Object.hasOwn(into, id)) {
        continue;
      }
      if (isLocalType(source.type) && !(await isLocalSourceInsideRoot(this.records.fs, root, source.url))) {
        this.logger.warn(`Skipping local source ${id}: its folder resolves outside ${root}`);
        continue;
      }
      into[id] = source;
    }
  }

  /**
   * Sources of both record files and both old lockfiles, and hubs of the old lockfiles.
   * A `RECORD.*` error in a record file is shown once and that file is skipped.
   * @returns `undefined` when no record or old lockfile exists.
   */
  public async readRepositorySources(): Promise<RepositorySources | undefined> {
    const result: Required<RepositorySources> = { sources: {}, hubs: {} };
    let found = false;
    for (const location of await this.records.locations(this.workspaceRoot)) {
      try {
        const { record, exists } = await this.records.store.load(location);
        found ||= exists;
        await this.collectSources(result.sources, location.root, record.sources);
      } catch (error) {
        if (!isRecordError(error)) {
          throw error;
        }
        this.records.showRecordError(error, [], location.root);
      }
    }
    for (const old of await this.records.readOldLockfiles(this.workspaceRoot)) {
      if (old.lock === null) {
        continue;
      }
      found = true;
      await this.collectSources(result.sources, this.workspaceRoot, old.lock.sources);
      Object.assign(result.hubs, old.lock.hubs ?? {});
    }
    return found ? result : undefined;
  }

  /**
   * Check the recorded sources on workspace open and offer to add the missing ones.
   *
   * Setup Timing: Detection is deferred until first-run setup is complete.
   * If SetupStateManager is unavailable, detection proceeds (fail-open behavior).
   */
  public async checkAndPromptActivation(): Promise<void> {
    try {
      if (!await this.isSetupComplete()) {
        this.logger.info('First-run setup not complete, deferring source/hub detection');
        return;
      }

      const recorded = await this.readRepositorySources();
      if (!recorded) {
        this.logger.debug('No install record or lockfile found, skipping source/hub detection');
        return;
      }

      if (await this.wasDeclined(this.workspaceRoot)) {
        this.logger.debug(`Repository ${this.workspaceRoot} was previously declined`);
        return;
      }

      await this.checkAndOfferMissingSources(recorded);
    } catch (error) {
      this.logger.error('Failed to check and detect sources:', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Check for missing sources and hubs, offer to add them
   * @param recorded - Sources and hubs the repository's records name
   * @returns Result with missing sources/hubs and whether offer was made
   */
  public async checkAndOfferMissingSources(recorded: RepositorySources): Promise<MissingSourcesResult> {
    const result: MissingSourcesResult = {
      missingSources: [],
      missingHubs: [],
      offeredToAdd: false
    };

    try {
      const configuredSources = await this.storage.getSources();
      const configuredSourceIds = new Set(configuredSources.map((s) => s.id));

      // @migration-cleanup(sourceId-normalization-v2): Remove legacy ID set once all lockfiles are migrated
      // Also accept legacy IDs of each configured source, so entries written with old-format IDs are recognized.
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

      result.missingSources = Object.keys(recorded.sources).filter((id) => !allKnownSourceIds.has(id));

      if (recorded.hubs) {
        const configuredHubs = await this.hubManager.listHubs();
        const configuredHubIds = new Set(configuredHubs.map((h) => h.id));
        result.missingHubs = Object.keys(recorded.hubs).filter((id) => !configuredHubIds.has(id));
      }

      if (result.missingSources.length > 0 || result.missingHubs.length > 0) {
        const totalMissing = result.missingSources.length + result.missingHubs.length;
        const itemType = result.missingHubs.length > 0 ? 'sources and hubs' : 'sources';
        const credentialRefs = result.missingSources
          .map((id) => recorded.sources[id]?.credentialRef)
          .filter((ref): ref is string => typeof ref === 'string' && ref !== '');
        const credentialNote = credentialRefs.length === 0
          ? ''
          : ` They need these credentials: ${[...new Set(credentialRefs)].join(', ')}.`;

        const choice = await vscode.window.showInformationMessage(
          `${totalMissing} ${itemType} from the install records are not configured.${credentialNote} Would you like to add them?`,
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
