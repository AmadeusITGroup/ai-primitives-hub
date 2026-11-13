/**
 * RepositoryActivationService
 *
 * On workspace open, lists the sources and hubs the repository's install
 * records and old lockfiles name that are not configured. A recorded hub comes
 * from a repository file, so it is only offered for import in a trusted
 * workspace, only for a GitHub or HTTPS reference, and only after the user
 * confirms the reference shown. A local folder source outside the repository
 * is skipped, and a `credentialRef` is shown by name only.
 */

import * as path from 'node:path';
import {
  isLocalSourceInsideRoot,
  isLocalType,
  toRecordHub,
} from '@ai-primitives-hub/app';
import {
  type HubReference,
  isJsonObject,
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
  /** Ids of the recorded hubs imported after the user confirmed. */
  importedHubs: string[];
}

/** Label of the button that imports one recorded hub. */
export const IMPORT_HUB_ACTION = 'Import hub';

/**
 * The reference to import for a recorded hub entry: a GitHub or HTTPS hub
 * that is not a local path; `undefined` for anything else.
 * @param hubId - Recorded hub id.
 * @param entry - The record's `hubs` entry; untrusted.
 */
export const importableHubReference = (hubId: string, entry: unknown): { name: string; reference: HubReference } | undefined => {
  if (!isJsonObject(entry) || typeof entry.type !== 'string' || typeof entry.location !== 'string') {
    return undefined;
  }
  const hub = toRecordHub(hubId, typeof entry.name === 'string' ? entry.name : '', {
    type: entry.type,
    location: entry.location,
    ref: typeof entry.ref === 'string' ? entry.ref : undefined,
    configFile: typeof entry.configFile === 'string' ? entry.configFile : undefined
  });
  // A recorded location that `toRecordHub` had to clean held credentials: never offered.
  if (hub === undefined || hub.location !== entry.location) {
    return undefined;
  }
  const isHttps = (() => {
    try {
      return new URL(hub.location).protocol === 'https:';
    } catch {
      return false;
    }
  })();
  if (hub.type === 'github' && (isHttps || !hub.location.includes(':'))) {
    return { name: hub.name, reference: { type: 'github', location: hub.location, ...(hub.ref === undefined ? {} : { ref: hub.ref }) } };
  }
  if ((hub.type === 'url' || hub.type === 'artifactory') && isHttps) {
    return {
      name: hub.name,
      reference: { type: hub.type, location: hub.location, ...(hub.configFile === undefined ? {} : { configFile: hub.configFile }) }
    };
  }
  return undefined;
};

/**
 * How a hub reference is shown before it is imported.
 * @param reference - Hub reference.
 */
const describeReference = (reference: HubReference): string =>
  `${reference.type} ${reference.location}${reference.ref === undefined ? '' : ` @ ${reference.ref}`}${reference.configFile === undefined ? '' : ` (${reference.configFile})`}`;

/** A source an install record or old lockfile names. */
export interface RepositorySourceEntry {
  type: string;
  url: string;
  /** External credential reference; shown by name, never resolved. */
  credentialRef?: string;
  /** Recorded hub the source came from. */
  hubId?: string;
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
   * Add a recorded source unless it is a local folder source outside the root.
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
   * Add the hubs of one file, keeping the first occurrence of an id.
   * @param into - Hubs collected so far.
   * @param hubs - Hubs of one file.
   */
  private collectHubs(into: Record<string, unknown>, hubs: unknown): void {
    if (!isJsonObject(hubs)) {
      return;
    }
    for (const [id, hub] of Object.entries(hubs)) {
      if (!Object.hasOwn(into, id)) {
        into[id] = hub;
      }
    }
  }

  /**
   * Sources and hubs of both record files and both old lockfiles; the first occurrence of an id is kept.
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
        this.collectHubs(result.hubs, record.hubs);
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
      this.collectHubs(result.hubs, old.lock.hubs);
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
   * List the missing sources and hubs, and offer to import each recorded hub that can be imported
   * @param recorded - Sources and hubs the repository's records name
   * @returns Result with missing sources/hubs and whether offer was made
   */
  public async checkAndOfferMissingSources(recorded: RepositorySources): Promise<MissingSourcesResult> {
    const result: MissingSourcesResult = {
      missingSources: [],
      missingHubs: [],
      offeredToAdd: false,
      importedHubs: []
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

      const trusted = vscode.workspace.isTrusted;
      const importable = new Map<string, { name: string; reference: HubReference }>();
      for (const id of result.missingHubs) {
        const hub = trusted ? importableHubReference(id, recorded.hubs?.[id]) : undefined;
        if (hub !== undefined) {
          importable.set(id, hub);
        }
      }
      // Importing a hub brings its sources, so they are not listed twice.
      const unlisted = [
        ...result.missingSources.filter((id) => !importable.has(recorded.sources[id]?.hubId ?? '')),
        ...result.missingHubs.filter((id) => !importable.has(id))
      ];
      if (unlisted.length > 0) {
        const hubCount = unlisted.length - result.missingSources.filter((id) => unlisted.includes(id)).length;
        const itemType = hubCount > 0 ? 'sources and hubs' : 'sources';
        const credentialRefs = result.missingSources
          .filter((id) => unlisted.includes(id))
          .map((id) => recorded.sources[id]?.credentialRef)
          .filter((ref): ref is string => typeof ref === 'string' && ref !== '');
        const credentialNote = credentialRefs.length === 0
          ? ''
          : ` They need these credentials: ${[...new Set(credentialRefs)].join(', ')}.`;
        const trustNote = !trusted && result.missingHubs.length > 0 ? ' Trust this workspace to import its hubs.' : '';
        result.offeredToAdd = true;
        void vscode.window.showInformationMessage(
          `${unlisted.length} ${itemType} from the install records are not configured: ${unlisted.join(', ')}.${credentialNote}${trustNote}`
        );
      }
      for (const [id, hub] of importable) {
        result.offeredToAdd = true;
        const choice = await vscode.window.showInformationMessage(
          `The install records use hub "${hub.name}" (${id}), which is not configured. Import it from ${describeReference(hub.reference)}?`,
          IMPORT_HUB_ACTION,
          'Not now'
        );
        if (choice !== IMPORT_HUB_ACTION) {
          continue;
        }
        try {
          await this.hubManager.importHub(hub.reference, id);
          result.importedHubs.push(id);
          this.logger.info(`Imported hub ${id} from ${describeReference(hub.reference)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to import hub ${id}`, error instanceof Error ? error : undefined);
          void vscode.window.showErrorMessage(`Could not import hub "${hub.name}": ${message}`);
        }
      }
    } catch (error) {
      this.logger.error('Failed to check for missing sources/hubs:', error instanceof Error ? error : undefined);
    }

    return result;
  }
}
