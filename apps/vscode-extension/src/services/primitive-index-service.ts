/**
 * VS Code delivery adapter for the shared primitive index.
 *
 * The service owns only extension concerns: receiving the resolved index path
 * or storage adapter and supplying a bundle provider. Index construction and
 * ranking remain in `@ai-primitives-hub/app`/`@ai-primitives-hub/infra` so
 * CLI and VS Code use the same profile and persisted-index contract.
 * @module services/primitive-index-service
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildIndex,
  getSearchProfile,
  searchIndex,
} from '@ai-primitives-hub/app';
import type {
  BuildIndexResult,
  SearchProfileId,
} from '@ai-primitives-hub/app';
import type {
  AppStorage,
  BundleProvider,
  PrimitiveIndexKey,
  PrimitiveIndexStore,
} from '@ai-primitives-hub/core';
import type {
  SearchQuery,
  SearchResult,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  VsCodeAppStorage,
} from '../storage/vscode-app-storage';
import {
  Logger,
} from '../utils/logger';

export interface PrimitiveIndexServiceOptions {
  /** Provider factory; source-specific enumeration stays outside this service. */
  providerFactory: () => BundleProvider | Promise<BundleProvider>;
  /**
   * Optional explicit path, primarily useful for tests, diagnostics, and
   * migration compatibility. Prefer `storage` in production composition.
   */
  indexPath?: string;
  /**
   * Storage seam for the shared semantic cache. The composition root selects
   * the physical policy; this service must not select a client-specific root.
   */
  storage?: Pick<AppStorage, 'getPaths'>;
  /** Shared namespaced index resolver selected by the composition root. */
  indexStore?: PrimitiveIndexStore;
  /** Hub/source/profile key for the shared index resolver. */
  indexKey?: PrimitiveIndexKey;
  /** Resolve the active hub and source snapshot for each index operation. */
  indexKeyProvider?: () => PrimitiveIndexKey | Promise<PrimitiveIndexKey>;
  /** Resolve a search key without remote revision lookups. */
  searchIndexKeyProvider?: () => PrimitiveIndexKey | Promise<PrimitiveIndexKey>;
  /** Resolve the current installation snapshot for query-time filtering. */
  installedBundleKeysProvider?: () => string[] | Promise<string[]>;
  /** Resolve locally known source IDs for compatible fallback selection. */
  searchIndexSourceIdsProvider?: () => string[] | Promise<string[]>;
  /** Shared ranking profile used for build and search. */
  profile?: SearchProfileId;
  /** Delay first-use index work until the initial registry sync is complete. */
  initializationReady?: Promise<void>;
}

const INITIALIZATION_READY_TIMEOUT_MS = 5000;
const INSTALLED_BUNDLE_OVERLAY_TIMEOUT_MS = 1000;

/**
 * Thin VS Code adapter over the app-level primitive-index use cases.
 */
export class PrimitiveIndexService {
  private readonly indexPath: string;
  private readonly profile: SearchProfileId;
  private readonly providerFactory: PrimitiveIndexServiceOptions['providerFactory'];
  private readonly indexStore?: PrimitiveIndexStore;
  private readonly indexKey?: PrimitiveIndexKey;
  private readonly indexKeyProvider?: PrimitiveIndexServiceOptions['indexKeyProvider'];
  private readonly searchIndexKeyProvider?: PrimitiveIndexServiceOptions['searchIndexKeyProvider'];
  private readonly installedBundleKeysProvider?: PrimitiveIndexServiceOptions['installedBundleKeysProvider'];
  private readonly searchIndexSourceIdsProvider?: PrimitiveIndexServiceOptions['searchIndexSourceIdsProvider'];
  private readonly initializationReady?: Promise<void>;
  private readonly legacyIndexPath?: string;
  private readonly logger = Logger.getInstance();
  private rebuildTimer?: ReturnType<typeof setTimeout>;
  private rebuildQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private emptyIndexRecoveryAttempted = false;
  private fallbackIndexPath?: string;

  public constructor(context: vscode.ExtensionContext, options: PrimitiveIndexServiceOptions) {
    this.profile = options.profile ?? 'ternlight-dual-v1';
    // Resolve eagerly so invalid profile configuration fails during activation,
    // rather than on the first search request.
    getSearchProfile(this.profile);

    const storage = options.storage ?? new VsCodeAppStorage(context);
    this.indexStore = options.indexStore;
    this.installedBundleKeysProvider = options.installedBundleKeysProvider;
    this.searchIndexSourceIdsProvider = options.searchIndexSourceIdsProvider;
    this.initializationReady = options.initializationReady;
    this.indexKeyProvider = options.indexKeyProvider;
    this.searchIndexKeyProvider = options.searchIndexKeyProvider;
    this.indexKey = options.indexKey ?? (!this.indexKeyProvider && this.indexStore
      ? {
        hubId: 'active',
        sourceRevision: 'current',
        searchProfileId: this.profile
      }
      : undefined);
    this.legacyIndexPath = this.indexStore && !options.indexPath
      ? path.join(storage.getPaths().cache, 'primitive-index.json')
      : undefined;
    this.indexPath = options.indexPath
      ?? (this.indexStore && this.indexKey
        ? this.indexStore.getIndexPath(this.indexKey)
        : path.join(storage.getPaths().cache, 'primitive-index.json'));
    this.providerFactory = options.providerFactory;
  }

  /**
   * Prefer the legacy cache only until the first namespaced rebuild succeeds.
   * @param indexKey
   */
  private async shouldUseLegacyIndex(indexKey: PrimitiveIndexKey | undefined): Promise<boolean> {
    if (!this.legacyIndexPath || !this.indexStore || !indexKey) {
      return false;
    }
    try {
      await fs.access(this.indexStore.getIndexPath(indexKey));
      return false;
    } catch {
      return this.isLegacyIndexCompatible();
    }
  }

  private async isLegacyIndexCompatible(): Promise<boolean> {
    if (!this.legacyIndexPath) {
      return false;
    }
    try {
      const raw = await fs.readFile(this.legacyIndexPath, 'utf8');
      const metadata = JSON.parse(raw) as {
        searchProfileId?: string | null;
        embeddingsMeta?: { embeddingStrategy?: string } | null;
      };
      const persistedProfile = metadata.searchProfileId
        ?? (metadata.embeddingsMeta
          ? (metadata.embeddingsMeta.embeddingStrategy === 'dual' ? 'ternlight-dual-v1' : 'ternlight-single-v1')
          : 'bm25-v1');
      return persistedProfile === this.profile;
    } catch {
      return false;
    }
  }

  private async performRebuild(): Promise<BuildIndexResult> {
    const provider = await this.providerFactory();
    const indexKey = this.indexKeyProvider ? await this.indexKeyProvider() : this.indexKey;
    const result = await buildIndex({
      provider,
      ...(this.indexStore && indexKey
        ? { indexStore: this.indexStore, indexKey }
        : { outFile: this.indexPath }),
      profile: this.profile,
      onLog: (message) => this.logger.info(`Primitive index rebuild: ${message}`),
      // A transient source/network failure must not replace the last-known-good
      // semantic snapshot with an empty index.
      persistEmpty: false
    });
    if (result.primitives === 0) {
      await this.resolveFallbackIndexPath(indexKey);
    }
    return result;
  }

  private async resolveFallbackIndexPath(indexKey: PrimitiveIndexKey | undefined): Promise<string | undefined> {
    this.fallbackIndexPath = undefined;
    if (!this.indexStore || !indexKey?.hubId || !this.indexStore.findLatestIndexPath) {
      return undefined;
    }
    const sourceIds = this.searchIndexSourceIdsProvider
      ? await this.searchIndexSourceIdsProvider()
      : undefined;
    const candidate = await this.indexStore.findLatestIndexPath(indexKey.hubId, this.profile, sourceIds);
    if (candidate && candidate !== this.indexStore.getIndexPath(indexKey)) {
      this.fallbackIndexPath = candidate;
      this.logger.warn(`Using last-known-good primitive index snapshot: ${candidate}`);
      return candidate;
    }
    return undefined;
  }

  private async hasPrimitives(indexPath: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as { primitives?: unknown[] };
      return Array.isArray(parsed.primitives) && parsed.primitives.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * The installed overlay enriches hits but is not required for ranking. Keep
   * slow repository/lockfile reads from blocking semantic Marketplace search.
   */
  private async resolveInstalledBundleKeys(): Promise<string[] | undefined> {
    if (!this.installedBundleKeysProvider) {
      return undefined;
    }

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const installedBundleKeys = await Promise.race([
        this.installedBundleKeysProvider(),
        new Promise<undefined>((resolve) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            resolve(undefined);
          }, INSTALLED_BUNDLE_OVERLAY_TIMEOUT_MS);
        })
      ]);
      if (timedOut) {
        this.logger.warn(
          `Installed bundle overlay timed out after ${String(INSTALLED_BUNDLE_OVERLAY_TIMEOUT_MS)}ms; continuing without overlay`
        );
      }
      return installedBundleKeys;
    } catch (error) {
      this.logger.warn(`Installed bundle overlay failed; continuing without overlay: ${String(error)}`);
      return undefined;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Wait for the initial source sync without allowing Marketplace searches to
   * remain pending forever when the sync lifecycle has stalled.
   */
  private async waitForInitializationReady(): Promise<boolean> {
    if (!this.initializationReady) {
      return true;
    }

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.initializationReady,
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            resolve();
          }, INITIALIZATION_READY_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      this.logger.warn(`Initial source sync readiness failed; continuing with cached index: ${String(error)}`);
      return false;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    if (timedOut) {
      this.logger.warn(`Initial source sync readiness timed out after ${String(INITIALIZATION_READY_TIMEOUT_MS)}ms`);
    }
    return !timedOut;
  }

  /** Absolute path of the persisted extension index. */
  public getIndexPath(): string {
    return this.indexPath;
  }

  /** Profile shared by build and search operations. */
  public getProfile(): SearchProfileId {
    return this.profile;
  }

  /** Rebuild and persist the index from the configured source provider. */
  public async rebuild(): Promise<BuildIndexResult> {
    this.logger.info(`Primitive index rebuild started (profile=${this.profile})`);
    let result!: BuildIndexResult;
    const operation = this.rebuildQueue.then(async () => {
      result = await this.performRebuild();
    });
    this.rebuildQueue = operation.then(() => undefined, () => undefined);
    try {
      await operation;
      this.logger.info(
        `Primitive index rebuild completed: ${result.primitives} primitive${result.primitives === 1 ? '' : 's'} `
        + `from ${result.bundles} bundle${result.bundles === 1 ? '' : 's'} (${result.outFile})`
      );
      return result;
    } catch (error) {
      this.logger.error('Primitive index rebuild failed', error as Error);
      throw error;
    }
  }

  /**
   * Search the persisted index using the same profile used to build it.
   * @param query
   */
  public async search(query: SearchQuery): Promise<SearchResult> {
    const installedBundleKeys = await this.resolveInstalledBundleKeys();
    const indexKey = this.searchIndexKeyProvider
      ? await this.searchIndexKeyProvider()
      : (this.indexKeyProvider ? await this.indexKeyProvider() : this.indexKey);
    const currentIndexPath = this.indexStore && indexKey
      ? this.indexStore.getIndexPath(indexKey)
      : this.indexPath;
    let useFallbackIndex = false;
    if (!(await this.hasPrimitives(currentIndexPath))) {
      await this.resolveFallbackIndexPath(indexKey);
      useFallbackIndex = Boolean(this.fallbackIndexPath);
    }
    const useLegacyIndex = !useFallbackIndex && await this.shouldUseLegacyIndex(indexKey);
    let location: {
      indexPath?: string;
      indexStore?: PrimitiveIndexStore;
      indexKey?: PrimitiveIndexKey;
    };
    if (useFallbackIndex) {
      location = { indexPath: this.fallbackIndexPath! };
    } else if (useLegacyIndex) {
      location = { indexPath: this.legacyIndexPath! };
    } else if (this.indexStore && indexKey) {
      location = { indexStore: this.indexStore, indexKey };
    } else {
      location = { indexPath: this.indexPath };
    }
    return searchIndex({
      ...location,
      query: installedBundleKeys ? { ...query, installedBundleKeys } : query,
      profile: this.profile
    });
  }

  /** Build the index on first use when no persisted index exists yet. */
  public async ensureBuilt(): Promise<void> {
    const initializationReady = await this.waitForInitializationReady();
    if (!initializationReady) {
      // Do not start a competing full rebuild while the initial source sync is
      // still running. Search can use the current or last-known-good snapshot;
      // if neither exists, search will report the normal metadata fallback.
      this.logger.warn('Primitive index initialization is still in progress; using an existing snapshot if available');
      return;
    }
    const indexKey = this.indexKeyProvider ? await this.indexKeyProvider() : this.indexKey;
    const indexPath = this.indexStore && indexKey
      ? this.indexStore.getIndexPath(indexKey)
      : this.indexPath;
    try {
      await fs.access(indexPath);
      if (!this.emptyIndexRecoveryAttempted) {
        const raw = await fs.readFile(indexPath, 'utf8');
        const parsed = JSON.parse(raw) as { primitives?: unknown[] };
        if (Array.isArray(parsed.primitives) && parsed.primitives.length === 0) {
          this.emptyIndexRecoveryAttempted = true;
          await this.rebuild();
        }
      }
    } catch {
      if (await this.isLegacyIndexCompatible()) {
        return;
      }
      await this.rebuild();
    }
  }

  /**
   * Schedule a debounced rebuild after a registry lifecycle event.
   * Rebuilds are serialized so a burst of source-sync events cannot corrupt or
   * overwrite the persisted index out of order.
   * @param reason
   * @param delayMs
   */
  public scheduleRebuild(reason: string, delayMs = 500): void {
    if (this.disposed) {
      return;
    }

    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      this.rebuildQueue = this.rebuildQueue.then(async () => {
        try {
          const result = await this.performRebuild();
          this.logger.info(
            `Primitive index rebuilt after ${reason}: ${result.primitives} primitives from ${result.bundles} bundles`
          );
        } catch (error) {
          this.logger.error(`Primitive index rebuild failed after ${reason}`, error as Error);
        }
      });
    }, delayMs);
  }

  /** Cancel pending rebuild work when the extension is deactivated. */
  public dispose(): void {
    this.disposed = true;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = undefined;
    }
  }
}
