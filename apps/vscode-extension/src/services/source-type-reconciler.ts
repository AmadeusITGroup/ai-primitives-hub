/**
 * Source Type Reconciler
 *
 * Handles migration when a hub source changes from awesome-copilot to github type.
 * Detects the change, maps old bundle IDs to new ones, and orchestrates
 * uninstall-old/install-new for all scopes.
 */
// @migration-cleanup(source-type-migration): Remove entire file once all sources have migrated

import {
  HubSource,
  ProfileActivationState,
} from '../types/hub';
import {
  Bundle,
  InstallationScope,
  InstalledBundle,
  RegistrySource,
} from '../types/registry';
import {
  BundleIdentityMatcher,
  extractGitHubMetadata,
} from '../utils/bundle-identity-matcher';
import {
  Logger,
} from '../utils/logger';
import {
  normalizeUrl,
} from '../utils/source-id-utils';
import {
  VersionManager,
} from '../utils/version-manager';

/**
 * Result of a single bundle reconciliation attempt
 */
export interface BundleReconciliationResult {
  oldBundleId: string;
  newBundleId: string;
  scope: InstallationScope;
  success: boolean;
  error?: string;
}

/**
 * Result of the full reconciliation process
 */
export interface ReconciliationResult {
  sourceUrl: string;
  oldSourceId: string;
  newSourceId: string;
  bundleResults: BundleReconciliationResult[];
  profilesUpdated: number;
}

/**
 * Interface for RegistryManager operations needed by reconciler.
 * Avoids circular dependency by depending on the interface, not the class.
 */
export interface ReconcilerRegistryOperations {
  uninstallBundle(bundleId: string, scope: InstallationScope, silent?: boolean): Promise<void>;
  installBundle(bundleId: string, options: { scope: InstallationScope; force: boolean; profileId?: string }, silent?: boolean): Promise<InstalledBundle>;
  removeSource(sourceId: string): Promise<void>;
  addSource(source: RegistrySource): Promise<void>;
  syncSource(sourceId: string): Promise<void>;
  getBundleDetails(bundleId: string): Promise<Bundle>;
  listSources(): Promise<RegistrySource[]>;
  listInstalledBundles(scope?: InstallationScope): Promise<InstalledBundle[]>;
}

/**
 * Interface for storage operations needed by reconciler.
 */
export interface ReconcilerStorageOperations {
  getCachedSourceBundles(sourceId: string): Promise<Bundle[]>;
}

/**
 * Interface for hub storage operations needed by reconciler.
 */
export interface ReconcilerHubStorageOperations {
  listActiveProfiles(): Promise<ProfileActivationState[]>;
  saveProfileActivationState(hubId: string, profileId: string, state: ProfileActivationState): Promise<void>;
}

export class SourceTypeReconciler {
  private readonly logger = Logger.getInstance();

  constructor(
    private readonly registry: ReconcilerRegistryOperations,
    private readonly storage: ReconcilerStorageOperations,
    private readonly hubStorage: ReconcilerHubStorageOperations
  ) {}

  /**
   * Build a mapping from old awesome-copilot bundle IDs to new github Bundle objects.
   * @param installedBundles - All installed bundles across scopes
   * @param githubBundles - Candidate bundles from the new github source
   * @param oldSourceId - ID of the old awesome-copilot source
   * @param githubSource - Optional github source whose URL provides owner/repo for precise matching
   */
  public static buildBundleIdMapping(
    installedBundles: InstalledBundle[],
    githubBundles: Bundle[],
    oldSourceId: string,
    githubSource?: RegistrySource
  ): Map<string, Bundle> {
    const logger = Logger.getInstance();
    const sourceMetadata = githubSource?.url
      ? extractGitHubMetadata(githubSource.url)
      : undefined;

    const oldBundles = installedBundles.filter(
      (b) => b.sourceId === oldSourceId
    );

    const entries = oldBundles
      .map((oldBundle): [string, Bundle] | undefined => {
        const matches = githubBundles.filter((gb) =>
          BundleIdentityMatcher.matchesAwesomeCopilotToGithub(
            oldBundle.bundleId,
            gb.id,
            sourceMetadata
          )
        );

        if (matches.length === 0) {
          logger.warn(
            `[SourceTypeReconciler] No github bundle matches '${oldBundle.bundleId}'. Skipping.`
          );
          return undefined;
        }

        // Multiple candidates occur when the repo publishes several releases of
        // the same collection (e.g. v1.0.0 and v1.0.1). Pick the highest semver
        // so users land on the same version they'd get from a fresh install.
        const latest = matches.reduce((best, candidate) =>
          VersionManager.compareVersions(candidate.version, best.version) > 0
            ? candidate
            : best
        );

        if (matches.length === 1) {
          logger.info(
            `[SourceTypeReconciler] Mapped: ${oldBundle.bundleId} → ${latest.id}`
          );
        } else {
          logger.info(
            `[SourceTypeReconciler] Mapped: ${oldBundle.bundleId} → ${latest.id} `
            + `(selected latest of ${matches.length} candidates)`
          );
        }

        return [oldBundle.bundleId, latest];
      })
      .filter((e): e is [string, Bundle] => e !== undefined);

    return new Map(entries);
  }

  /**
   * Detect if a hub source has changed type from awesome-copilot to github.
   * @param newHubSource - Incoming hub source (expected to be github)
   * @param existingSources - Currently-registered sources to scan for a URL match
   */
  public static detectTypeChange(
    newHubSource: HubSource,
    existingSources: RegistrySource[]
  ): RegistrySource | undefined {
    if (newHubSource.type !== 'github') {
      return undefined;
    }

    const newUrl = normalizeUrl(newHubSource.url);

    return existingSources.find(
      (existing) => existing.type === 'awesome-copilot' && normalizeUrl(existing.url) === newUrl
    );
  }

  // Defensive dedup: storage and lockfile layers have non-overlapping scopes
  // in practice, but if an upstream bug surfaces duplicates, double-installing
  // and then double-uninstalling the same bundle would corrupt state.
  private async getAllInstalledBundles(): Promise<InstalledBundle[]> {
    const all = await this.registry.listInstalledBundles();
    const seen = new Set<string>();
    return all.filter((bundle) => {
      const key = `${bundle.bundleId}:${bundle.scope}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private async reconcileBundle(
    oldBundleId: string,
    newBundle: Bundle,
    oldSourceId: string,
    allInstalled: InstalledBundle[]
  ): Promise<BundleReconciliationResult[]> {
    const results: BundleReconciliationResult[] = [];

    const scopeInstalls = allInstalled.filter(
      (b) => b.bundleId === oldBundleId && b.sourceId === oldSourceId
    );

    if (scopeInstalls.length === 0) {
      this.logger.debug(
        `[SourceTypeReconciler] Bundle '${oldBundleId}' not found in any scope. Skipping.`
      );
      return results;
    }

    // Verify the new github bundle is resolvable before uninstalling anything
    let installable = false;
    try {
      await this.registry.getBundleDetails(newBundle.id);
      installable = true;
    } catch (error) {
      this.logger.warn(
        `[SourceTypeReconciler] New github bundle '${newBundle.id}' is not available. `
        + `Keeping old installation for '${oldBundleId}'. Error: ${(error as Error).message}`
      );
    }

    if (!installable) {
      for (const scopeInstall of scopeInstalls) {
        results.push({
          oldBundleId,
          newBundleId: newBundle.id,
          scope: scopeInstall.scope,
          success: false,
          error: 'New github bundle not available'
        });
      }
      return results;
    }

    for (const scopeInstall of scopeInstalls) {
      try {
        const existingTargetInstall = allInstalled.find(
          (b) => b.bundleId === newBundle.id && b.scope === scopeInstall.scope
        );

        if (existingTargetInstall) {
          this.logger.info(
            `[SourceTypeReconciler] Bundle '${newBundle.id}' already installed in scope `
            + `'${scopeInstall.scope}'. Uninstalling old bundle '${oldBundleId}' without reinstall.`
          );
          await this.registry.uninstallBundle(oldBundleId, scopeInstall.scope, true);
          results.push({
            oldBundleId,
            newBundleId: newBundle.id,
            scope: scopeInstall.scope,
            success: true
          });
          continue;
        }

        this.logger.info(
          `[SourceTypeReconciler] Migrating '${oldBundleId}' → '${newBundle.id}' in scope '${scopeInstall.scope}'`
        );

        // Install new bundle first (different IDs so they coexist),
        // then uninstall old — ensures we never leave the user without either.
        await this.registry.installBundle(
          newBundle.id,
          {
            scope: scopeInstall.scope,
            force: true,
            profileId: scopeInstall.profileId
          },
          true
        );
        await this.registry.uninstallBundle(oldBundleId, scopeInstall.scope, true);

        results.push({
          oldBundleId,
          newBundleId: newBundle.id,
          scope: scopeInstall.scope,
          success: true
        });
      } catch (error) {
        const errorMsg = (error as Error).message;
        this.logger.error(
          `[SourceTypeReconciler] Failed to migrate '${oldBundleId}' in scope '${scopeInstall.scope}': ${errorMsg}`
        );
        results.push({
          oldBundleId,
          newBundleId: newBundle.id,
          scope: scopeInstall.scope,
          success: false,
          error: errorMsg
        });
      }
    }

    return results;
  }

  private buildUpdatedProfileState(
    profile: ProfileActivationState,
    mapping: Map<string, Bundle>
  ): ProfileActivationState | undefined {
    const oldVersions = profile.syncedBundleVersions ?? {};
    const syncedChanged = profile.syncedBundles.some((id) => mapping.has(id));
    const versionsChanged = Object.keys(oldVersions).some((id) => mapping.has(id));

    if (!syncedChanged && !versionsChanged) {
      return undefined;
    }

    const newSyncedBundles = profile.syncedBundles.map(
      (id) => mapping.get(id)?.id ?? id
    );
    const newVersions: Record<string, string> = Object.fromEntries(
      Object.entries(oldVersions).map(([id, version]) => {
        const newBundle = mapping.get(id);
        return newBundle ? [newBundle.id, newBundle.version] : [id, version];
      })
    );

    return { ...profile, syncedBundles: newSyncedBundles, syncedBundleVersions: newVersions };
  }

  private async updateProfileActivationStates(
    hubId: string,
    mapping: Map<string, Bundle>
  ): Promise<number> {
    try {
      const activeProfiles = await this.hubStorage.listActiveProfiles();
      const hubProfiles = activeProfiles.filter((p) => p.hubId === hubId);

      const updates = hubProfiles
        .map((profile) => ({ profile, updated: this.buildUpdatedProfileState(profile, mapping) }))
        .filter(
          (e): e is { profile: ProfileActivationState; updated: ProfileActivationState } =>
            e.updated !== undefined
        );

      let updatedCount = 0;
      for (const { profile, updated } of updates) {
        await this.hubStorage.saveProfileActivationState(hubId, profile.profileId, updated);
        updatedCount++;
        this.logger.info(
          `[SourceTypeReconciler] Updated profile activation state: ${profile.profileId}`
        );
      }
      return updatedCount;
    } catch (error) {
      this.logger.warn(
        `[SourceTypeReconciler] Failed to update profile activation states: ${(error as Error).message}`
      );
      return 0;
    }
  }

  private async cleanupOldSource(oldSourceId: string): Promise<void> {
    try {
      await this.registry.removeSource(oldSourceId);
      this.logger.info(`[SourceTypeReconciler] Removed old source: ${oldSourceId}`);
    } catch (error) {
      this.logger.warn(
        `[SourceTypeReconciler] Failed to remove old source '${oldSourceId}': ${(error as Error).message}`
      );
    }
  }

  private async cleanupIfUnreferenced(
    oldSourceId: string,
    installed: InstalledBundle[],
    keepReason: string
  ): Promise<void> {
    const stillReferenced = installed.some((b) => b.sourceId === oldSourceId);
    if (stillReferenced) {
      this.logger.warn(
        `[SourceTypeReconciler] Keeping old source '${oldSourceId}' — ${keepReason}`
      );
      return;
    }
    await this.cleanupOldSource(oldSourceId);
  }

  /**
   * Execute the full reconciliation process.
   * @param oldSource - The outgoing awesome-copilot source
   * @param newHubSource - The incoming github hub source
   * @param hubId - Hub ID owning both sources
   * @param newSourceId - Pre-computed ID for the new github source
   */
  public async reconcile(
    oldSource: RegistrySource,
    newHubSource: HubSource,
    hubId: string,
    newSourceId: string
  ): Promise<ReconciliationResult> {
    this.logger.info(
      `[SourceTypeReconciler] Starting reconciliation: `
      + `${oldSource.id} (awesome-copilot) → ${newSourceId} (github)`
    );

    const result: ReconciliationResult = {
      sourceUrl: newHubSource.url,
      oldSourceId: oldSource.id,
      newSourceId,
      bundleResults: [],
      profilesUpdated: 0
    };

    const newSource: RegistrySource = {
      id: newSourceId,
      name: newHubSource.name,
      type: newHubSource.type,
      url: newHubSource.url,
      enabled: newHubSource.enabled,
      priority: newHubSource.priority,
      private: newHubSource.private,
      token: newHubSource.token,
      metadata: newHubSource.metadata,
      config: newHubSource.config,
      hubId
    };

    const existingSources = await this.registry.listSources();
    const sourceAlreadyRegistered = existingSources.some((s) => s.id === newSourceId);
    if (sourceAlreadyRegistered) {
      this.logger.info(
        `[SourceTypeReconciler] New github source '${newSourceId}' already registered. `
        + `Skipping addSource and proceeding with reconciliation.`
      );
    } else {
      await this.registry.addSource(newSource);
      this.logger.info(`[SourceTypeReconciler] Registered new github source: ${newSourceId}`);
    }

    await this.registry.syncSource(newSourceId);
    const githubBundles = await this.storage.getCachedSourceBundles(newSourceId);
    const allInstalled = await this.getAllInstalledBundles();

    if (githubBundles.length === 0) {
      this.logger.warn(
        `[SourceTypeReconciler] No bundles found from new github source ${newSourceId}. `
        + `Skipping bundle migration.`
      );
      await this.cleanupIfUnreferenced(oldSource.id, allInstalled, 'installed bundles still reference it.');
      return result;
    }

    const mapping = SourceTypeReconciler.buildBundleIdMapping(
      allInstalled,
      githubBundles,
      oldSource.id,
      newSource
    );

    if (mapping.size === 0) {
      this.logger.info(`[SourceTypeReconciler] No bundle mappings found.`);
      await this.cleanupIfUnreferenced(
        oldSource.id,
        allInstalled,
        'installed bundles still reference it but no mapping could be established.'
      );
      return result;
    }

    // Reconcile bundles in parallel. Safe because reconcileBundle catches its
    // own errors (producing per-scope result rows) and different bundle IDs
    // touch disjoint storage paths and lockfile entries. Keeps per-scope
    // granularity that outer allSettled would collapse.
    const perBundleResults = await Promise.all(
      [...mapping].map(([oldBundleId, newBundle]) =>
        this.reconcileBundle(oldBundleId, newBundle, oldSource.id, allInstalled)
      )
    );
    result.bundleResults = perBundleResults.flat();

    // Profile state is scope-agnostic (just bundle IDs), so advance it as soon
    // as any scope migrated. The old source is kept on partial failure, so the
    // failed scope retries on the next loadHubSources — flipping the profile
    // twice (forward here, back on retry) would cause more churn than advancing
    // once and letting retries converge.
    const migratedIds = new Set(
      result.bundleResults.filter((r) => r.success).map((r) => r.oldBundleId)
    );
    const successfulMapping = new Map(
      [...mapping].filter(([oldId]) => migratedIds.has(oldId))
    );
    result.profilesUpdated = await this.updateProfileActivationStates(hubId, successfulMapping);

    // Keep old source on any failure so remaining bundles aren't orphaned.
    const allSucceeded = result.bundleResults.every((r) => r.success);
    if (allSucceeded) {
      await this.cleanupOldSource(oldSource.id);
    } else {
      this.logger.warn(
        `[SourceTypeReconciler] Some bundles failed migration. Keeping old source '${oldSource.id}'.`
      );
    }

    this.logger.info(
      `[SourceTypeReconciler] Reconciliation complete: `
      + `${result.bundleResults.filter((r) => r.success).length} bundles migrated, `
      + `${result.bundleResults.filter((r) => !r.success).length} failed, `
      + `${result.profilesUpdated} profiles updated`
    );

    return result;
  }
}
