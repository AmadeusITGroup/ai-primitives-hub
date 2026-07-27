/**
 * Storage layer for registry configuration and data
 * Handles persistence of sources, profiles, bundles, and settings
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import type {
  AppStorage,
  AppStoragePaths,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import {
  Bundle,
  InstallationScope,
  InstalledBundle,
  Profile,
  RegistryConfig,
  RegistrySettings,
  RegistrySource,
} from '../types/registry';
import {
  VsCodeAppStorage,
} from './vscode-app-storage';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rename = promisify(fs.rename);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const unlink = promisify(fs.unlink);

/**
 * Storage paths
 */
type StoragePaths = AppStoragePaths;

/**
 * Default registry settings
 */
const DEFAULT_SETTINGS: RegistrySettings = {
  autoUpdate: true,
  updateCheckInterval: 24, // hours
  telemetry: false,
  installationScope: 'user',
  preferredEnvironment: 'vscode'
};

/**
 * Default registry configuration
 */
function createDefaultConfig(): RegistryConfig {
  return {
    version: '1.0.0',
    sources: [],
    profiles: [],
    settings: { ...DEFAULT_SETTINGS }
  };
}

/**
 * Registry storage manager
 * Handles all file-based persistence for the registry
 */
export class RegistryStorage {
  // Constants for ID sanitization
  private static readonly MAX_FILENAME_LENGTH = 200;
  private static readonly ALLOWED_CHARS_REGEX = /[^A-Za-z0-9._-]/g;
  private readonly paths: StoragePaths;
  private readonly appStorage: AppStorage;
  private configCache?: RegistryConfig;
  private configMutationQueue: Promise<void> = Promise.resolve();

  // ===== Update Preferences Management =====

  /**
   * Bundle update preferences
   */
  private readonly UPDATE_PREFERENCES_KEY = 'bundleUpdatePreferences';

  /**
   * Create a RegistryStorage.
   * @param context - VS Code extension context.
   * @param storage - Storage-root/state port (ADR-0005). Defaults to
   *   `VsCodeAppStorage`, backed by `context.globalStorageUri`/
   *   `context.globalState` — the extension's existing, unchanged
   *   on-disk layout. Injectable for tests and for any future
   *   non-VS-Code caller (e.g. `infra`'s `XdgAppStorage`).
   */
  constructor(private readonly context: vscode.ExtensionContext, storage?: AppStorage) {
    this.appStorage = storage ?? new VsCodeAppStorage(context);
    this.paths = this.appStorage.getPaths();
  }

  /**
   * Ensure all required directories exist
   */
  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.paths.root,
      this.paths.cache,
      this.paths.sourcesCache,
      this.paths.bundlesCache,
      this.paths.installed,
      this.paths.userInstalled,
      this.paths.profilesInstalled,
      this.paths.profiles,
      this.paths.logs
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
  }

  /**
   * Sanitize an ID for safe use in filenames
   * Replaces characters outside [A-Za-z0-9._-] with underscore
   * Enforces maximum length to prevent filesystem issues
   * @param id - The bundle ID, source ID, or other identifier
   * @returns Sanitized string safe for use in filenames
   */
  private sanitizeFilename(id: string): string {
    if (!id || id.length === 0) {
      throw new Error('ID cannot be empty');
    }

    // Replace disallowed characters with underscore
    let sanitized = id.replace(RegistryStorage.ALLOWED_CHARS_REGEX, '_');

    // Enforce max length (leave room for .json extension)
    if (sanitized.length > RegistryStorage.MAX_FILENAME_LENGTH) {
      sanitized = sanitized.substring(0, RegistryStorage.MAX_FILENAME_LENGTH);
    }

    return sanitized;
  }

  private async writeConfig(config: RegistryConfig): Promise<void> {
    const data = JSON.stringify(config, null, 2);
    await writeFile(this.paths.config, data, 'utf8');
    this.configCache = config;
  }

  private async enqueueConfigMutation(mutation: () => Promise<void>): Promise<void> {
    const queuedMutation = this.configMutationQueue.then(mutation);
    this.configMutationQueue = queuedMutation.catch(() => undefined);
    await queuedMutation;
  }

  private async mutateConfig(mutation: (config: RegistryConfig) => void): Promise<void> {
    await this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      mutation(config);
      await this.writeConfig(config);
    });
  }

  /**
   * Get the list of supported scopes for querying installed bundles.
   * Repository scope bundles are tracked via LockfileManager, not RegistryStorage.
   * See: src/services/LockfileManager.ts - read() method for repository bundle queries
   * @param scope - Optional scope to filter by
   * @returns Array of supported scopes to query
   */
  private getSupportedScopes(scope?: InstallationScope): ('user' | 'workspace')[] {
    // Repository scope bundles are tracked via LockfileManager, not RegistryStorage
    if (scope === 'repository') {
      return [];
    }
    if (scope === 'user' || scope === 'workspace') {
      return [scope];
    }
    // No scope specified - return all supported scopes
    return ['user', 'workspace'];
  }

  /**
   * Get installation path for bundle
   * @param bundle
   */
  private getInstalledBundlePath(bundle: InstalledBundle): string {
    const scopePath = bundle.scope === 'user' ? this.paths.userInstalled : this.paths.installed;
    const sanitizedId = this.sanitizeFilename(bundle.bundleId);
    return path.join(scopePath, `${sanitizedId}.json`);
  }

  /**
   * Get the extension context
   */
  public getContext(): vscode.ExtensionContext {
    return this.context;
  }

  /**
   * Initialize storage directories
   */
  public async initialize(): Promise<void> {
    await this.ensureDirectories();

    // Create default config if doesn't exist
    if (!fs.existsSync(this.paths.config)) {
      await this.saveConfig(createDefaultConfig());
    }
  }

  /**
   * Load registry configuration
   */
  public async loadConfig(): Promise<RegistryConfig> {
    if (this.configCache) {
      return this.configCache;
    }

    try {
      const data = await readFile(this.paths.config, 'utf8');
      const config = JSON.parse(data) as RegistryConfig;

      // Merge with defaults for any missing settings
      config.settings = { ...DEFAULT_SETTINGS, ...config.settings };

      this.configCache = config;
      return config;
    } catch {
      // Return default config if file doesn't exist or is invalid
      return createDefaultConfig();
    }
  }

  /**
   * Save registry configuration
   * @param config
   */
  public async saveConfig(config: RegistryConfig): Promise<void> {
    await this.enqueueConfigMutation(async () => {
      await this.writeConfig(config);
    });
  }

  /**
   * Get storage paths
   */
  public getPaths(): StoragePaths {
    return { ...this.paths };
  }

  // ===== Source Management =====

  /**
   * Add a source to configuration
   * @param source
   */
  public async addSource(source: RegistrySource): Promise<void> {
    await this.mutateConfig((config) => {
      if (config.sources.some((s) => s.id === source.id)) {
        throw new Error(`Source with ID '${source.id}' already exists`);
      }

      config.sources.push(source);
    });
  }

  /**
   * Update a source
   * @param sourceId
   * @param updates
   */
  public async updateSource(sourceId: string, updates: Partial<RegistrySource>): Promise<void> {
    await this.mutateConfig((config) => {
      const index = config.sources.findIndex((s) => s.id === sourceId);

      if (index === -1) {
        throw new Error(`Source '${sourceId}' not found`);
      }

      config.sources[index] = { ...config.sources[index], ...updates };
    });
  }

  /**
   * Remove a source
   * @param sourceId
   */
  public async removeSource(sourceId: string): Promise<void> {
    await this.mutateConfig((config) => {
      config.sources = config.sources.filter((s) => s.id !== sourceId);
    });

    // Clean up source cache
    await this.clearSourceCache(sourceId);
  }

  /**
   * Get all sources
   */
  public async getSources(): Promise<RegistrySource[]> {
    const config = await this.loadConfig();
    return config.sources;
  }

  // ===== Profile Management =====

  /**
   * Add a profile
   * @param profile
   */
  public async addProfile(profile: Profile): Promise<void> {
    await this.mutateConfig((config) => {
      if (config.profiles.some((p) => p.id === profile.id)) {
        throw new Error(`Profile with ID '${profile.id}' already exists`);
      }

      config.profiles.push(profile);
    });
  }

  /**
   * Update a profile
   * @param profileId
   * @param updates
   */
  public async updateProfile(profileId: string, updates: Partial<Profile>): Promise<void> {
    await this.mutateConfig((config) => {
      const index = config.profiles.findIndex((p) => p.id === profileId);

      if (index === -1) {
        throw new Error(`Profile '${profileId}' not found`);
      }

      config.profiles[index] = { ...config.profiles[index], ...updates };
    });
  }

  /**
   * Remove a profile
   * @param profileId
   */
  public async removeProfile(profileId: string): Promise<void> {
    await this.mutateConfig((config) => {
      config.profiles = config.profiles.filter((p) => p.id !== profileId);
    });
  }

  /**
   * Get all profiles
   */
  public async getProfiles(): Promise<Profile[]> {
    const config = await this.loadConfig();
    return config.profiles;
  }

  // ===== Bundle Cache Management =====

  /**
   * Get cached bundle metadata
   * @param bundleId
   */
  public async getCachedBundleMetadata(bundleId: string): Promise<Bundle | undefined> {
    try {
      const sanitizedId = this.sanitizeFilename(bundleId);
      const filepath = path.join(this.paths.bundlesCache, `${sanitizedId}.json`);
      const data = await readFile(filepath, 'utf8');
      return JSON.parse(data) as Bundle;
    } catch {
      return undefined;
    }
  }

  /**
   * Cache source bundles
   * @param sourceId
   * @param bundles
   */
  public async cacheSourceBundles(sourceId: string, bundles: Bundle[]): Promise<void> {
    const sanitizedId = this.sanitizeFilename(sourceId);
    const filepath = path.join(this.paths.sourcesCache, `${sanitizedId}.json`);
    const data = JSON.stringify(bundles, null, 2);
    // Write atomically: progressive sync calls this repeatedly while the UI reads
    // the same file (see getCachedSourceBundles). A plain writeFile truncates then
    // streams, so a concurrent read could see partial JSON and fail to parse,
    // flickering the source to empty. Writing to a temp file then renaming makes
    // every read observe either the old or the new content, never a partial one.
    const tempPath = `${filepath}.${process.pid}.tmp`;
    await writeFile(tempPath, data, 'utf8');
    await rename(tempPath, filepath);
  }

  /**
   * Get cached source bundles
   * @param sourceId
   */
  public async getCachedSourceBundles(sourceId: string): Promise<Bundle[]> {
    try {
      const sanitizedId = this.sanitizeFilename(sourceId);
      const filepath = path.join(this.paths.sourcesCache, `${sanitizedId}.json`);
      const data = await readFile(filepath, 'utf8');
      return JSON.parse(data) as Bundle[];
    } catch {
      return [];
    }
  }

  /**
   * Clear source cache
   * @param sourceId
   */
  public async clearSourceCache(sourceId: string): Promise<void> {
    try {
      const sanitizedId = this.sanitizeFilename(sourceId);
      const filepath = path.join(this.paths.sourcesCache, `${sanitizedId}.json`);
      if (fs.existsSync(filepath)) {
        await unlink(filepath);
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Clear all caches
   */
  public async clearAllCaches(): Promise<void> {
    try {
      const files = await readdir(this.paths.bundlesCache);
      for (const file of files) {
        await unlink(path.join(this.paths.bundlesCache, file));
      }
    } catch {
      // Ignore errors
    }

    try {
      const files = await readdir(this.paths.sourcesCache);
      for (const file of files) {
        await unlink(path.join(this.paths.sourcesCache, file));
      }
    } catch {
      // Ignore errors
    }
  }

  // ===== Installed Bundles Management =====

  /**
   * Record installed bundle
   * @param bundle
   */
  public async recordInstallation(bundle: InstalledBundle): Promise<void> {
    const filepath = this.getInstalledBundlePath(bundle);
    const data = JSON.stringify(bundle, null, 2);
    await writeFile(filepath, data, 'utf8');
  }

  /**
   * Remove installation record
   * @param bundleId
   * @param scope
   */
  public async removeInstallation(bundleId: string, scope: InstallationScope): Promise<void> {
    // Repository scope bundles are tracked via LockfileManager, not RegistryStorage.
    // See: src/services/LockfileManager.ts - remove() method
    if (scope === 'repository') {
      return;
    }
    const scopePath = scope === 'user' ? this.paths.userInstalled : this.paths.installed;
    const sanitizedId = this.sanitizeFilename(bundleId);
    const filepath = path.join(scopePath, `${sanitizedId}.json`);

    if (fs.existsSync(filepath)) {
      await unlink(filepath);
    }
  }

  /**
   * Get all installed bundles
   * @param scope
   */
  public async getInstalledBundles(scope?: InstallationScope): Promise<InstalledBundle[]> {
    const bundles: InstalledBundle[] = [];

    // Get the list of scopes to query
    const scopes = this.getSupportedScopes(scope);

    for (const s of scopes) {
      const scopePath = s === 'user' ? this.paths.userInstalled : this.paths.installed;

      try {
        const files = await readdir(scopePath);

        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              const data = await readFile(path.join(scopePath, file), 'utf8');
              const bundle = JSON.parse(data) as InstalledBundle;
              bundles.push(bundle);
            } catch {
              // Skip invalid files
            }
          }
        }
      } catch {
        // Scope directory doesn't exist
      }
    }

    return bundles;
  }

  /**
   * Get installed bundle metadata
   * @param bundleId
   * @param scope
   */
  public async getInstalledBundle(bundleId: string, scope: InstallationScope): Promise<InstalledBundle | undefined> {
    // Repository scope bundles are tracked via LockfileManager, not RegistryStorage.
    // See: src/services/LockfileManager.ts - read() method for repository bundle queries
    if (scope === 'repository') {
      return undefined;
    }
    try {
      const scopePath = scope === 'user' ? this.paths.userInstalled : this.paths.installed;
      const sanitizedId = this.sanitizeFilename(bundleId);
      const filepath = path.join(scopePath, `${sanitizedId}.json`);
      const data = await readFile(filepath, 'utf8');
      return JSON.parse(data) as InstalledBundle;
    } catch {
      return undefined;
    }
  }

  // ===== Settings Management =====

  /**
   * Clear all data (sources, profiles, caches) - used for replace import strategy
   */
  public async clearAll(): Promise<void> {
    await this.saveConfig(createDefaultConfig());

    // Clear all caches
    await this.clearAllCaches();
  }

  /**
   * Get all update preferences
   */
  public async getUpdatePreferences(): Promise<Record<string, { autoUpdate: boolean; lastChecked?: string }>> {
    return this.appStorage.getState<Record<string, { autoUpdate: boolean; lastChecked?: string }>>(
      this.UPDATE_PREFERENCES_KEY,
      {}
    );
  }

  /**
   * Set update preference for a specific bundle
   * @param bundleId
   * @param autoUpdate
   */
  public async setUpdatePreference(bundleId: string, autoUpdate: boolean): Promise<void> {
    const prefs = await this.getUpdatePreferences();
    prefs[bundleId] = {
      autoUpdate,
      lastChecked: new Date().toISOString()
    };
    await this.appStorage.setState(this.UPDATE_PREFERENCES_KEY, prefs);
  }

  /**
   * Get update preference for a specific bundle
   * Returns false if no preference is set
   * @param bundleId
   */
  public async getUpdatePreference(bundleId: string): Promise<boolean> {
    const prefs = await this.getUpdatePreferences();
    return prefs[bundleId]?.autoUpdate ?? false;
  }
}
