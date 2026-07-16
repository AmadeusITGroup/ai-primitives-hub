/**
 * Bundle update-preference persistence — the narrow slice of the
 * extension's `RegistryStorage` (`src/storage/registry-storage.ts`)
 * that the update-checking/auto-update use cases need. `RegistryStorage`
 * already exposes exactly this shape (`getUpdatePreference`/
 * `setUpdatePreference`/`getUpdatePreferences`), so it satisfies this
 * port with zero changes.
 * @module ports/update-store
 */

/**
 * Per-bundle auto-update preference record.
 */
export interface UpdatePreferenceRecord {
  autoUpdate: boolean;
  lastChecked?: string;
}

/**
 * Read/write access to per-bundle auto-update preferences.
 */
export interface UpdatePreferenceStore {
  getUpdatePreference(bundleId: string): Promise<boolean>;
  setUpdatePreference(bundleId: string, autoUpdate: boolean): Promise<void>;
  getUpdatePreferences(): Promise<Record<string, UpdatePreferenceRecord>>;
}
