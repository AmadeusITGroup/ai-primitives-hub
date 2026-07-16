/**
 * Narrow, interface-segregated slices of a registry orchestrator's
 * (the extension's `RegistryManager`, eventually `app`'s own registry
 * use-cases) surface — just enough for the update-checking/auto-update
 * use cases to depend on, without depending on the full orchestrator
 * (which also owns discovery, install, profile management, ...) or
 * risking a circular dependency with it.
 *
 * Ported from `src/services/auto-update-service.ts`'s local
 * `BundleOperations`/`SourceOperations` interfaces (kept field-for-field
 * identical — the extension's production wiring in `extension.ts`
 * already constructs plain object literals satisfying exactly this
 * shape) plus a new `UpdateRegistryReader` for `UpdateChecker`'s
 * slightly different, read-only needs.
 * @module ports/registry-operations
 */
import type {
  Bundle,
  BundleUpdate,
} from '../domain/bundle/types';
import type {
  HubProfileWithMetadata,
  ProfileActivationState,
} from '../domain/hub/types';
import type {
  InstallationScope,
  InstalledBundle,
} from '../domain/install/types';
import type {
  ExportedSettingsConfiguration,
} from '../domain/registry/settings';
import type {
  Profile,
} from '../domain/registry/types';
import type {
  RegistrySource,
} from '../domain/source/types';

/**
 * Bundle-level mutation/query operations needed to perform and verify an
 * update (and roll it back on failure).
 */
export interface BundleOperations {
  updateBundle(bundleId: string, version?: string): Promise<void>;
  listInstalledBundles(): Promise<InstalledBundle[]>;
  getBundleDetails(bundleId: string): Promise<Bundle>;
}

/**
 * Source synchronization operations needed before trusting a source's
 * cached bundle data for an update.
 */
export interface SourceOperations {
  listSources(): Promise<RegistrySource[]>;
  syncSource(sourceId: string): Promise<void>;
}

/**
 * Source read/write operations needed to sync a hub's declared sources
 * into the registry: list existing sources to detect duplicates/updates
 * against, add genuinely new ones, and update ones that already came
 * from the same hub. Deliberately narrower than a full source-CRUD
 * port (no `removeSource`) since hub-source syncing never deletes.
 */
export interface HubSourceSync {
  listSources(): Promise<RegistrySource[]>;
  addSource(source: RegistrySource): Promise<void>;
  updateSource(sourceId: string, updates: Partial<RegistrySource>): Promise<void>;
}

/**
 * Registry operations needed while activating a hub profile: properly
 * deactivate a previously-active profile elsewhere (uninstalling its
 * bundles, not just clearing its flag), and install the newly-active
 * profile's bundles. Optional dependency of `activateProfile` — when
 * absent, the caller falls back to flag-only bookkeeping and skips
 * installation (mirrors the extension's own `if (this.registryManager)`
 * branching in `src/services/hub-manager.ts`).
 */
export interface ProfileLifecycleSync {
  deactivateProfile(profileId: string): Promise<void>;
  installBundles(items: { bundleId: string; options: { scope: 'user'; force: boolean; profileId: string } }[]): Promise<void>;
}

/**
 * The read-only registry surface `UpdateChecker` needs: sync sources,
 * compare installed vs. latest versions, and enrich the result with
 * per-bundle metadata.
 */
export interface UpdateRegistryReader extends SourceOperations {
  getBundleDetails(bundleId: string): Promise<Bundle>;
  checkUpdates(): Promise<BundleUpdate[]>;
}

/**
 * The read-only registry surface needed to detect raw version
 * differences between each installed bundle and its source: resolve a
 * bundle's latest details, list sources for cross-referencing, and read
 * installation records (a single scope, or across scopes).
 *
 * Deliberately NOT `extends UpdateRegistryReader`/`SourceOperations`:
 * `UpdateRegistryReader.checkUpdates` is exactly the method this port's
 * consumer (`app`'s `detectBundleUpdates`) computes, so requiring it
 * here would be self-referential, and raw update-detection never calls
 * `syncSource`. The overlap with `getBundleDetails`/`listSources` is
 * intentional, narrow, per-consumer duplication (interface segregation)
 * rather than inheritance.
 */
export interface UpdateDetectionReader {
  getBundleDetails(bundleId: string): Promise<Bundle>;
  listSources(): Promise<RegistrySource[]>;
  getInstalledBundles(scope?: InstallationScope): Promise<InstalledBundle[]>;
  getInstalledBundle(bundleId: string, scope: InstallationScope): Promise<InstalledBundle | undefined>;
}

/**
 * CRUD access to the extension's local (non-hub) `Profile` records.
 * Ported from `RegistryManager`'s direct use of its `RegistryStorage`
 * facade's `getProfiles`/`addProfile`/`updateProfile`/`removeProfile` —
 * needs a `core` port (rather than depending on the concrete storage
 * class directly, the way `HubManager` depends on `infra`'s `HubStore`)
 * because `RegistryStorage` is extension-owned with no `infra`
 * counterpart.
 */
export interface ProfileStore {
  getProfiles(): Promise<Profile[]>;
  addProfile(profile: Profile): Promise<void>;
  updateProfile(profileId: string, updates: Partial<Profile>): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
}

/**
 * Read-only view of hub-provided profiles, needed to merge them
 * alongside local ones (`RegistryManager.listProfiles`/`isHubProfile`).
 * Ported from the extension's `HubManager.listActiveHubProfiles`/
 * `.listAllActiveProfiles` — extension-owned, no alternate
 * implementation, hence a `core` port rather than a concrete class
 * dependency.
 */
export interface HubProfileReader {
  listActiveHubProfiles(): Promise<HubProfileWithMetadata[]>;
  listAllActiveProfiles(): Promise<ProfileActivationState[]>;
}

/**
 * `HubProfileReader` plus the two mutating hub operations
 * `RegistryManager.activateProfile`/`.deactivateProfile` delegate to
 * when the target profile turns out to be hub-provided.
 */
export interface HubProfileSync extends HubProfileReader {
  activateProfile(hubId: string, profileId: string, options: { installBundles: boolean }): Promise<unknown>;
  deactivateProfile(hubId: string, profileId: string): Promise<unknown>;
}

/**
 * Registry-wide operations needed to export/import the extension's
 * complete settings (sources + profiles + configuration). `listSources`/
 * `addSource` are deliberately narrow, opaque callbacks (mirroring
 * `RegistryManager`'s own already-validating `addSource`, not raw
 * storage) rather than a source-CRUD port, since import only ever adds.
 * `getConfiguration`/`updateConfiguration` bridge the 3
 * `promptregistry.*` VS Code settings `exportSettings`/`importSettings`
 * read and write.
 */
export interface RegistrySettingsOperations extends ProfileStore {
  listSources(): Promise<RegistrySource[]>;
  addSource(source: RegistrySource): Promise<void>;
  /** Wipes all sources/profiles/caches — used only by the `'replace'` import strategy. */
  clearAll(): Promise<void>;
  getConfiguration(): ExportedSettingsConfiguration;
  updateConfiguration(updates: ExportedSettingsConfiguration): Promise<void>;
}
