/**
 * HubManager - Orchestrates hub operations
 * Handles hub importing, loading, validation, and synchronization
 */

import {
  exec,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  HubStorage,
  LoadHubResult,
} from '../storage/hub-storage';
import {
  ConflictResolutionDialog,
  HubConfig,
  HubProfile,
  HubProfileBundle,
  HubReference,
  HubSource,
  ProfileActivationOptions,
  ProfileActivationResult,
  ProfileActivationState,
  ProfileChanges,
  ProfileDeactivationResult,
  sanitizeHubId,
  validateHubConfig,
} from '../types/hub';
import {
  RegistrySource,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';
import {
  generateHubSourceId,
} from '../utils/source-id-utils';
import {
  SchemaValidator,
  ValidationResult,
} from './schema-validator';
import {
  SourceTypeReconciler,
} from './source-type-reconciler';

const execAsync = promisify(exec);

/**
 * Resolved bundle with its download URL
 */
export interface ResolvedBundle {
  bundle: HubProfileBundle;
  url: string;
}

/**
 * Hub profile with hub metadata
 */
export interface HubProfileWithMetadata extends HubProfile {
  hubId: string;
  hubName: string;
}

/**
 * Hub information including config, reference, and metadata
 */
export interface HubInfo {
  id: string;
  config: HubConfig;
  reference: HubReference;
  metadata: {
    name: string;
    description: string;
    lastModified: Date;
    size: number;
  };
}

/**
 * Hub list item with basic information
 */
export interface HubListItem {
  id: string;
  name: string;
  description: string;
  reference: HubReference;
}

/**
 * HubManager orchestrates all hub-related operations
 */
export class HubManager {
  private readonly storage: HubStorage;
  private readonly validator: SchemaValidator;
  private readonly hubSchemaPath: string;
  private readonly logger: Logger;
  private readonly _onHubImported = new vscode.EventEmitter<string>();
  private readonly _onHubDeleted = new vscode.EventEmitter<string>();
  private readonly _onHubSynced = new vscode.EventEmitter<string>();
  private readonly _onFavoritesChanged = new vscode.EventEmitter<void>();
  private readonly _onActiveHubChanged = new vscode.EventEmitter<{ oldHubId: string | null; newHubId: string | null }>();

  private authToken: string | undefined;
  private authMethod: 'vscode' | 'gh-cli' | 'explicit' | 'none' = 'none';

  /**
   * Initialize HubManager
   * @param storage HubStorage instance for persistence
   * @param validator SchemaValidator instance for validation
   * @param extensionPath Path to the extension directory
   */
  public readonly onHubImported = this._onHubImported.event;
  public readonly onHubDeleted = this._onHubDeleted.event;
  public readonly onHubSynced = this._onHubSynced.event;
  public readonly onFavoritesChanged = this._onFavoritesChanged.event;
  public readonly onActiveHubChanged = this._onActiveHubChanged.event;

  constructor(
    storage: HubStorage,
    validator: SchemaValidator,
    extensionPath: string,
    private readonly bundleInstaller?: any,
    private readonly registryManager?: any
  ) {
    if (!storage) {
      throw new Error('storage is required');
    }
    if (!validator) {
      throw new Error('validator is required');
    }
    if (!extensionPath) {
      throw new Error('extensionPath is required');
    }

    this.storage = storage;
    this.validator = validator;
    this.hubSchemaPath = path.join(extensionPath, 'schemas', 'hub-config.schema.json');
    this.logger = Logger.getInstance();
  }

  /**
   * Cleanup resources linked to a hub (sources, profiles, favorites)
   * Called when hub is deleted or switched away from
   * @param hubId Hub identifier to cleanup
   */
  private async cleanupHubResources(hubId: string): Promise<void> {
    this.logger.info(`Cleaning up resources for hub: ${hubId}`);

    // 1. Remove favorites for this hub
    const favorites = await this.getFavoriteProfiles();
    if (favorites[hubId]) {
      delete favorites[hubId];
      await this.storage.saveFavoriteProfiles(favorites);
      this._onFavoritesChanged.fire();
      this.logger.info(`Removed favorites for hub: ${hubId}`);
    }

    // 2. Deactivate and remove sources linked to this hub
    if (this.registryManager) {
      const sources = await this.registryManager.listSources();
      for (const source of sources) {
        if (source.hubId === hubId) {
          try {
            await this.registryManager.removeSource(source.id);
            this.logger.info(`Removed source ${source.id} linked to hub ${hubId}`);
          } catch (error) {
            this.logger.warn(`Failed to remove source ${source.id}`, error);
          }
        }
      }

      // 3. Deactivate profiles linked to this hub
      const profiles = await this.registryManager.listProfiles();
      for (const profile of profiles) {
        if (profile.hubId === hubId && profile.active) {
          try {
            await this.registryManager.updateProfile(profile.id, { active: false });
            this.logger.info(`Deactivated profile ${profile.id} linked to hub ${hubId}`);
          } catch (error) {
            this.logger.warn(`Failed to deactivate profile ${profile.id}`, error);
          }
        }
      }
    }
  }

  /**
   * Validate hub reference
   * @param reference Hub reference to validate
   * @returns Validation result
   */
  private async validateReference(reference: HubReference): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!reference.type) {
      errors.push('Reference type is required');
    }

    if (!reference.location) {
      errors.push('Reference location is required');
    }

    // Type-specific validation
    switch (reference.type) {
      case 'github': {
        if (!reference.location.includes('/')) {
          errors.push('Invalid GitHub location format. Expected: owner/repo');
        }
        break;
      }
      case 'url': {
        try {
          new URL(reference.location);
        } catch {
          errors.push('Invalid URL format');
        }
        break;
      }
      case 'local': {
        // Local path validation is done during fetch
        break;
      }
      default: {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- value is safely stringifiable at runtime
        errors.push(`Unsupported reference type: ${reference.type}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: []
    };
  }

  /**
   * Fetch hub configuration from source
   * @param reference Hub reference
   * @returns Hub configuration
   */
  private async fetchHubConfig(reference: HubReference): Promise<HubConfig> {
    switch (reference.type) {
      case 'local': {
        return this.fetchFromLocal(reference.location);
      }
      case 'url': {
        return this.fetchFromUrl(reference.location);
      }
      case 'github': {
        return this.fetchFromGitHub(reference.location, reference.ref);
      }
      default: {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- value is safely stringifiable at runtime
        throw new Error(`Unsupported reference type: ${reference.type}`);
      }
    }
  }

  /**
   * Fetch hub config from local file
   * @param filePath Local file path
   * @returns Hub configuration
   */
  private async fetchFromLocal(filePath: string): Promise<HubConfig> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return yaml.load(content) as HubConfig;
    } catch (error) {
      throw new Error(`Failed to load hub config from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get authentication token using fallback chain:
   * 1. VSCode GitHub API (if user is logged in)
   * 2. gh CLI (if installed and authenticated)
   * 3. Explicit token from source configuration
   */
  private async getAuthenticationToken(): Promise<string | undefined> {
    // Return cached token if already resolved
    if (this.authToken !== undefined) {
      this.logger.debug(`[HubManager] Using cached token (method: ${this.authMethod})`);
      return this.authToken;
    }

    this.logger.info('[HubManager] Attempting authentication...');

    // Try VSCode GitHub authentication first
    try {
      this.logger.debug('[HubManager] Trying VSCode GitHub authentication...');
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      if (session) {
        this.authToken = session.accessToken;
        this.authMethod = 'vscode';
        this.logger.info('[HubManager] ✓ Using VSCode GitHub authentication');
        this.logger.debug(`[HubManager] Token preview: ${this.authToken.substring(0, 8)}...`);
        return this.authToken;
      }
      this.logger.debug('[HubManager] VSCode auth session not found');
    } catch (error) {
      this.logger.warn(`[HubManager] VSCode auth failed: ${error}`);
    }

    // Try gh CLI authentication
    try {
      this.logger.debug('[HubManager] Trying gh CLI authentication...');
      const { stdout } = await execAsync('gh auth token');
      const token = stdout.trim();
      if (token && token.length > 0) {
        this.authToken = token;
        this.authMethod = 'gh-cli';
        this.logger.info('[HubManager] ✓ Using gh CLI authentication');
        this.logger.debug(`[HubManager] Token preview: ${this.authToken.substring(0, 8)}...`);
        return this.authToken;
      }
      this.logger.debug('[HubManager] gh CLI returned empty token');
    } catch (error) {
      this.logger.warn(`[HubManager] gh CLI auth failed: ${error}`);
    }

    // No authentication available
    this.authMethod = 'none';
    this.logger.warn('[HubManager] ✗ No authentication available - API rate limits will apply and private repos will be inaccessible');
    return undefined;
  }

  /**
   * Fetch hub config from URL
   * Handles redirects (301/302) by following the Location header
   * @param url URL to fetch from
   * @param redirectDepth Current redirect depth (for loop prevention)
   * @returns Hub configuration
   */
  private async fetchFromUrl(url: string, redirectDepth = 0): Promise<HubConfig> {
    /**
     * Maximum redirect depth to prevent infinite loops.
     */
    const MAX_REDIRECTS = 10;
    if (redirectDepth >= MAX_REDIRECTS) {
      this.logger.error(`[HubManager] Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
      throw new Error(`Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
    }

    // Prepare headers with authentication for GitHub URLs
    const headers: { [key: string]: string } = {};

    // Get authentication token using fallback chain
    const token = await this.getAuthenticationToken();
    if (token) {
      // Use Bearer token format for OAuth tokens (recommended)
      headers.Authorization = `token ${token}`;
      this.logger.debug(`[HubManager] Request to ${url} with auth (method: ${this.authMethod})`);
    } else {
      this.logger.debug(`[HubManager] Request to ${url} WITHOUT auth`);
    }

    // Log headers (sanitized)
    const sanitizedHeaders = { ...headers };
    if (sanitizedHeaders.Authorization) {
      sanitizedHeaders.Authorization = sanitizedHeaders.Authorization.substring(0, 15) + '...';
    }
    this.logger.debug(`[HubManager] Request headers: ${JSON.stringify(sanitizedHeaders)}`);

    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const options: any = { headers };
      protocol.get(url, options, (res) => {
        // Handle redirects (301/302)
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.logger.debug(`[HubManager] Following redirect (depth ${redirectDepth + 1}) to: ${redirectUrl}`);
            this.fetchFromUrl(redirectUrl, redirectDepth + 1).then(resolve).catch(reject);
            return;
          }
        }

        if (res.statusCode !== 200) {
          this.logger.error(`[HubManager] Failed to fetch hub config: HTTP ${res.statusCode}`, undefined);
          reject(new Error(`Failed to fetch hub config: HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            this.logger.debug(`[HubManager] Successfully fetched hub config, ${data.length} bytes`);
            const config = yaml.load(data) as HubConfig;
            resolve(config);
          } catch (error) {
            this.logger.error(`[HubManager] Failed to parse hub config`, error as Error);
            reject(new Error(`Failed to parse hub config: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      }).on('error', (error) => {
        this.logger.error(`[HubManager] Network error fetching hub config`, error);
        reject(new Error(`Failed to fetch hub config: ${error.message}`));
      });
    });
  }

  /**
   * Fetch hub config from GitHub
   * @param location GitHub repository (owner/repo)
   * @param ref Git reference (branch, tag, or commit)
   * @returns Hub configuration
   */
  private async fetchFromGitHub(location: string, ref = 'main'): Promise<HubConfig> {
    const branch = ref;
    // Add timestamp to bypass GitHub raw content cache
    const timestamp = Date.now();
    const url = `https://raw.githubusercontent.com/${location}/${branch}/hub-config.yml?t=${timestamp}`;

    return this.fetchFromUrl(url);
  }

  /**
   * Generate hub ID from config
   * @param config Hub configuration
   * @returns Generated hub ID
   */
  private generateHubId(config: HubConfig): string {
    // Use metadata name, sanitized
    let id = config.metadata.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // Add timestamp to ensure uniqueness
    const timestamp = Date.now().toString().slice(-6);
    id = `${id}-${timestamp}`;

    return id;
  }

  /**
   * Check if a source is a duplicate based on URL and config
   * Compares URL, type, branch, and collectionsPath to determine if sources are identical
   * @param source Source to check
   * @param existingSources List of existing sources
   * @returns The existing duplicate source or undefined
   */
  private findDuplicateSource(
    source: HubSource,
    existingSources: RegistrySource[]
  ): RegistrySource | undefined {
    return existingSources.find((existing: RegistrySource) => {
      // Must have same type and URL
      if (existing.type !== source.type || existing.url !== source.url) {
        return false;
      }

      // For sources with config, compare relevant fields
      const existingConfig = existing.config || {};
      const sourceConfig = source.config || {};

      // Compare branch (for git-based sources)
      const existingBranch = existingConfig.branch || 'main';
      const sourceBranch = sourceConfig.branch || 'main';
      if (existingBranch !== sourceBranch) {
        return false;
      }

      // Compare collectionsPath (for awesome-copilot sources)
      const existingPath = existingConfig.collectionsPath || 'collections';
      const sourcePath = sourceConfig.collectionsPath || 'collections';
      if (existingPath !== sourcePath) {
        return false;
      }

      // If all criteria match, it's a duplicate
      return true;
    });
  }

  /**
   * Clear cached authentication state so that the next call to
   * getAuthenticationToken() performs a fresh authentication attempt.
   * Used when re-triggering setup after a user previously declined auth.
   */
  public clearAuthCache(): void {
    this.authToken = undefined;
    this.authMethod = 'none';
    this.logger.info('[HubManager] Authentication cache cleared');
  }

  /**
   * Import hub from remote or local source
   * @param reference Hub reference (GitHub, URL, or local path)
   * @param hubId Optional hub identifier (auto-generated if not provided)
   * @returns Hub identifier
   */
  public async importHub(reference: HubReference, hubId?: string): Promise<string> {
    // Validate reference
    const refValidation = await this.validateReference(reference);
    if (!refValidation.valid) {
      throw new Error(`Invalid reference: ${refValidation.errors.join(', ')}`);
    }

    // Fetch hub config from source
    const config = await this.fetchHubConfig(reference);

    // Validate hub config
    const validation = await this.validateHub(config);
    if (!validation.valid) {
      this.logger.error('Hub validation failed:', undefined, {
        errors: validation.errors,
        warnings: validation.warnings
      });
      throw new Error(`Hub validation failed: Validation error: ${validation.errors.join(', ')}`);
    }

    // Generate hub ID if not provided
    if (!hubId) {
      hubId = this.generateHubId(config);
    }

    // Validate hub ID
    try {
      sanitizeHubId(hubId);
    } catch (error) {
      throw new Error(`Invalid hub ID: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Save to storage first
    await this.storage.saveHub(hubId, config, reference);

    // Load hub sources into RegistryManager
    if (this.registryManager) {
      await this.loadHubSources(hubId);
    }

    this._onHubImported.fire(hubId);

    return hubId;
  }

  /**
   * Load hub from storage
   * @param hubId Hub identifier
   * @returns Loaded hub configuration and reference
   */
  public async loadHub(hubId: string): Promise<LoadHubResult> {
    const result = await this.storage.loadHub(hubId);

    // Validate loaded config
    const validation = await this.validateHub(result.config);
    if (!validation.valid) {
      this.logger.error('Hub validation failed on load:', undefined, {
        hubId,
        errors: validation.errors,
        warnings: validation.warnings
      });
      throw new Error(`Hub validation failed: ${validation.errors.join(', ')}`);
    }

    return result;
  }

  /**
   * Validate hub configuration
   * @param config Hub configuration to validate
   * @returns Validation result
   */
  public async validateHub(config: HubConfig): Promise<ValidationResult> {
    // Schema validation
    const schemaResult = await this.validator.validate(config, this.hubSchemaPath);
    if (!schemaResult.valid) {
      return schemaResult;
    }

    // Runtime validation
    const runtimeResult = validateHubConfig(config);
    if (!runtimeResult.valid) {
      return {
        valid: false,
        errors: runtimeResult.errors,
        warnings: []
      };
    }

    return {
      valid: true,
      errors: [],
      warnings: []
    };
  }

  /**
   * List all imported hubs
   * @returns Array of hub list items
   */
  public async listHubs(): Promise<HubListItem[]> {
    const hubIds = await this.storage.listHubs();
    const hubs: HubListItem[] = [];

    for (const id of hubIds) {
      try {
        const result = await this.storage.loadHub(id);
        hubs.push({
          id,
          name: result.config.metadata.name,
          description: result.config.metadata.description,
          reference: result.reference
        });
      } catch (error) {
        // Skip hubs that fail to load
        console.error(`Failed to load hub ${id}:`, error);
      }
    }

    return hubs;
  }

  /**
   * Delete hub from storage
   * @param hubId Hub identifier to delete
   */
  public async deleteHub(hubId: string): Promise<void> {
    // Cleanup resources linked to this hub before deleting
    await this.cleanupHubResources(hubId);

    await this.storage.deleteHub(hubId);
    this._onHubDeleted.fire(hubId);
  }

  public async deleteAllHubs(): Promise<void> {
    const hubIds = await this.storage.listHubs();
    await Promise.allSettled(hubIds.map(async (hubId) => {
      try {
        await this.deleteHub(hubId);
      } catch (error) {
        this.logger.warn(`Failed to delete hub ${hubId} during cleanup`, error);
      }
    }));
  }

  /**
   * Sync the currently active hub from remote source.
   * Resolves the active hub ID from storage and delegates to syncHub().
   * No-ops silently if no hub is active.
   */
  public async syncActiveHub(): Promise<void> {
    const activeHubId = await this.storage.getActiveHubId();
    if (!activeHubId) {
      this.logger.info('No active hub configured, skipping sync');
      return;
    }
    await this.syncHub(activeHubId);
  }

  /**
   * Sync hub from remote source
   * @param hubId Hub identifier to sync
   */
  public async syncHub(hubId: string): Promise<void> {
    // Load existing hub to get reference
    const existing = await this.storage.loadHub(hubId);

    // Fetch latest config from source
    const config = await this.fetchHubConfig(existing.reference);

    // Validate updated config
    const validation = await this.validateHub(config);
    if (!validation.valid) {
      throw new Error(`Hub validation failed after sync: ${validation.errors.join(', ')}`);
    }

    // Update storage
    await this.storage.saveHub(hubId, config, existing.reference);

    // Reload hub sources into RegistryManager
    if (this.registryManager) {
      await this.loadHubSources(hubId);
    }

    this._onHubSynced.fire(hubId);
  }

  /**
   * Get detailed hub information
   * @param hubId Hub identifier
   * @returns Hub information
   */
  public async getHubInfo(hubId: string): Promise<HubInfo> {
    const result = await this.storage.loadHub(hubId);
    const metadata = await this.storage.getHubMetadata(hubId);

    return {
      id: hubId,
      config: result.config,
      reference: result.reference,
      metadata: {
        name: result.config.metadata.name,
        description: result.config.metadata.description,
        lastModified: metadata.lastModified,
        size: metadata.size
      }
    };
  }

  /**
   * Verify if a hub is accessible without importing it
   * Used to validate default hubs before offering them in the first-run selector
   * @param reference Hub reference to verify
   * @returns true if hub is accessible, false otherwise
   */
  public async verifyHubAvailability(reference: HubReference): Promise<boolean> {
    try {
      // Validate reference format
      const refValidation = await this.validateReference(reference);
      if (!refValidation.valid) {
        this.logger.debug(`Hub verification failed: invalid reference - ${refValidation.errors.join(', ')}`);
        return false;
      }

      // Try to fetch the hub config
      await this.fetchHubConfig(reference);

      this.logger.debug(`Hub verification successful: ${reference.type}:${reference.location}`);
      return true;
    } catch (error) {
      this.logger.debug(`Hub verification failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * List all profiles from a specific hub
   * @param hubId Hub identifier
   * @returns Array of profiles from the hub
   */
  public async listProfilesFromHub(hubId: string): Promise<HubProfile[]> {
    const hub = await this.storage.loadHub(hubId);
    if (!hub) {
      throw new Error(`Hub not found: ${hubId}`);
    }

    const profiles = hub.config.profiles || [];

    // Enrich with activation state
    try {
      const activeState = await this.storage.getActiveProfileForHub(hubId);
      if (activeState) {
        return profiles.map((profile) => ({
          ...profile,
          active: activeState.profileId === profile.id
        }));
      }
    } catch (error) {
      this.logger.warn(`Failed to check profile activation state for hub ${hubId}`, error);
    }

    return profiles;
  }

  /**
   * Get a specific profile from a hub
   * @param hubId Hub identifier
   * @param profileId Profile identifier
   * @returns The requested profile
   */
  public async getHubProfile(hubId: string, profileId: string): Promise<HubProfile> {
    const profiles = await this.listProfilesFromHub(hubId);
    this.logger.info(`Found ${profiles.length} profiles in hub ${hubId}`);

    const profile = profiles.find((p) => p.id === profileId);

    if (!profile) {
      this.logger.error(`Profile ${profileId} not found in hub ${hubId}. Available: ${profiles.map((p) => p.id).join(', ')}`);
      throw new Error(`Profile not found: ${profileId} in hub ${hubId}`);
    }

    this.logger.info(`Found profile ${profileId}: ${profile.name}`);
    this.logger.info(`Profile bundles: ${JSON.stringify(profile.bundles?.map((b) => ({ id: b.id, version: b.version })) || [])}`);

    return profile;
  }

  /**
   * List all profiles from all imported hubs
   * @returns Array of profiles with hub information
   */
  public async listAllHubProfiles(): Promise<HubProfileWithMetadata[]> {
    const hubs = await this.listHubs();
    const allProfiles: HubProfileWithMetadata[] = [];

    for (const hubItem of hubs) {
      const profiles = await this.listProfilesFromHub(hubItem.id);
      for (const profile of profiles) {
        allProfiles.push({
          ...profile,
          hubId: hubItem.id,
          hubName: hubItem.name
        });
      }
    }

    return allProfiles;
  }

  /**
   * Get the ID of the currently active hub.
   * @returns Active hub ID, or null if no hub is active
   */
  public async getActiveHubId(): Promise<string | null> {
    return this.storage.getActiveHubId();
  }

  /**
   * Get the currently active hub
   * @returns Active hub ID, config and reference, or null if no hub is active
   */
  public async getActiveHub(): Promise<LoadHubResult | null> {
    const activeHubId = await this.storage.getActiveHubId();

    if (!activeHubId) {
      return null;
    }

    try {
      return await this.storage.loadHub(activeHubId);
    } catch {
      // If active hub was deleted, clear the activeHubId
      await this.storage.setActiveHubId(null);
      return null;
    }
  }

  /**
   * Set the currently active hub
   * @param hubId Hub identifier to set as active
   */
  public async setActiveHub(hubId: string | null): Promise<void> {
    // Get current active hub to check if we're switching
    const currentActiveHubId = await this.storage.getActiveHubId();

    // Cleanup previous hub if switching to a different one
    if (currentActiveHubId && currentActiveHubId !== hubId) {
      await this.cleanupHubResources(currentActiveHubId);
    }

    if (hubId !== null) {
      // Verify hub exists when setting (not clearing)
      const hub = await this.getHub(hubId);
      if (!hub) {
        throw new Error(`Hub not found: ${hubId}`);
      }

      // Load hub sources into RegistryManager when activating
      if (this.registryManager) {
        await this.loadHubSources(hubId);
      }
    }

    // Set or clear active hub
    await this.storage.setActiveHubId(hubId);
    this.logger.info(hubId ? `Set active hub: ${hubId}` : 'Cleared active hub');

    if (currentActiveHubId !== hubId) {
      this._onActiveHubChanged.fire({ oldHubId: currentActiveHubId ?? null, newHubId: hubId });
    }
  }

  /**
   * Load hub sources into RegistryManager.
   * Converts HubSource objects to RegistrySource and adds them to the registry.
   * Skips sources that are duplicates (same URL, type, branch, and collectionsPath).
   *
   * SourceId Format: Uses `generateHubSourceId(type, url, config)` to create stable IDs
   * in the format `{type}-{12-char-hash}`. The hash includes branch and collectionsPath
   * to prevent collisions when the same URL is used with different configurations.
   * This makes lockfiles portable across different hub configurations since IDs are
   * based on source properties, not hub ID.
   *
   * Backward Compatibility: Existing sources with legacy hub-prefixed IDs
   * (`hub-{hubId}-{sourceId}`) continue to work. Duplicate detection uses URL
   * matching, not ID matching, to handle both formats.
   * @param hubId Hub identifier
   */
  public async loadHubSources(hubId: string): Promise<void> {
    if (!this.registryManager) {
      this.logger.warn('RegistryManager not available, skipping source loading');
      return;
    }

    this.logger.info(`Loading sources from hub: ${hubId}`);

    try {
      const hubData = await this.storage.loadHub(hubId);
      const hubSources = hubData.config.sources || [];

      this.logger.info(`Found ${hubSources.length} sources in hub ${hubId}`);

      // Get existing sources to avoid duplicates
      let existingSources = await this.registryManager.listSources();

      let addedCount = 0;
      let skippedCount = 0;
      let updatedCount = 0;

      for (const hubSource of hubSources) {
        // Skip disabled sources
        if (!hubSource.enabled) {
          this.logger.debug(`Skipping disabled source: ${hubSource.id}`);
          skippedCount++;
          continue;
        }

        // Generate stable sourceId based on type, URL, and config (branch, collectionsPath)
        const sourceId = generateHubSourceId(hubSource.type, hubSource.url, {
          branch: hubSource.config?.branch,
          collectionsPath: hubSource.config?.collectionsPath
        });

        // Check if source with same ID already exists (from this hub)
        const existingSourceById = existingSources.find((s: RegistrySource) => s.id === sourceId);

        if (existingSourceById) {
          // Update existing source from same hub
          this.logger.info(`Updating existing hub source: ${sourceId}`);
          await this.registryManager.updateSource(sourceId, {
            name: hubSource.name,
            type: hubSource.type,
            url: hubSource.url,
            enabled: hubSource.enabled,
            priority: hubSource.priority,
            private: hubSource.private,
            token: hubSource.token,
            metadata: hubSource.metadata,
            config: hubSource.config,
            hubId: hubId
          });
          updatedCount++;
          continue;
        }

        // Check if duplicate source already exists (same URL + config)
        const duplicateSource = this.findDuplicateSource(hubSource, existingSources);

        if (duplicateSource) {
          this.logger.info(
            `Skipping duplicate source: ${hubSource.name} `
            + `(already exists as "${duplicateSource.name}" with ID: ${duplicateSource.id})`
          );
          this.logger.debug(
            `Duplicate detected - URL: ${hubSource.url}, `
            + `Branch: ${hubSource.config?.branch || 'main'}, `
            + `CollectionsPath: ${hubSource.config?.collectionsPath || 'collections'}`
          );
          skippedCount++;
          continue;
        }

        // @migration-cleanup(source-type-migration): Remove this block once all sources have migrated
        // Detect awesome-copilot → github type change by URL match
        const typeChangedSource = SourceTypeReconciler.detectTypeChange(hubSource, existingSources);
        if (typeChangedSource) {
          this.logger.info(
            `Detected source type change: ${typeChangedSource.id} (${typeChangedSource.type}) → ${hubSource.type} for URL ${hubSource.url}`
          );

          try {
            const reconciler = new SourceTypeReconciler(
              this.registryManager,
              this.registryManager.getStorage(),
              this.storage
            );

            const reconcileResult = await reconciler.reconcile(
              typeChangedSource,
              hubSource,
              hubId,
              sourceId
            );

            existingSources = await this.registryManager.listSources();
            if (reconcileResult.bundleResults.some((r) => r.success)) {
              updatedCount++;
            }
          } catch (error) {
            this.logger.error(
              `Failed to reconcile source type change for ${hubSource.url}`,
              error as Error
            );
          }

          continue;
        }

        // Add new source
        this.logger.info(`Adding new hub source: ${sourceId} (${hubSource.name})`);

        // Convert HubSource to RegistrySource
        const registrySource: RegistrySource = {
          id: sourceId,
          name: hubSource.name,
          type: hubSource.type,
          url: hubSource.url,
          enabled: hubSource.enabled,
          priority: hubSource.priority,
          private: hubSource.private,
          token: hubSource.token,
          metadata: hubSource.metadata,
          config: hubSource.config,
          hubId: hubId
        };

        try {
          await this.registryManager.addSource(registrySource);
          addedCount++;
        } catch (sourceError) {
          this.logger.warn(
            `Failed to add hub source ${sourceId} (${hubSource.name}): `
            + `${sourceError instanceof Error ? sourceError.message : String(sourceError)}`
          );
          skippedCount++;
        }
      }

      this.logger.info(
        `Hub source loading complete for ${hubId}: `
        + `${addedCount} added, ${updatedCount} updated, ${skippedCount} skipped`
      );
    } catch (error) {
      this.logger.error(`Failed to load sources from hub ${hubId}`, error as Error);
      throw error;
    }
  }

  /**
   * List profiles from the active hub only
   * @returns Profiles from active hub, or empty array if no hub is active
   */
  public async listActiveHubProfiles(): Promise<HubProfileWithMetadata[]> {
    const activeHubId = await this.storage.getActiveHubId();

    if (!activeHubId) {
      return [];
    }

    const activeHub = await this.getActiveHub();
    if (!activeHub) {
      return [];
    }

    const profiles = activeHub.config.profiles || [];
    return profiles.map((profile) => ({
      ...profile,
      hubId: activeHubId,
      hubName: activeHub.config.metadata.name
    }));
  }

  /**
   * Resolve all bundles in a profile
   * @param hubId
   * @param profileId
   */
  public async resolveProfileBundles(
    hubId: string,
    profileId: string
  ): Promise<ResolvedBundle[]> {
    const profile = await this.getHubProfile(hubId, profileId);
    const resolved: ResolvedBundle[] = [];

    this.logger.info(`Resolving bundles for profile ${profileId} in hub ${hubId}`);
    this.logger.info(`Profile has ${profile.bundles?.length || 0} bundles`);

    if (!profile.bundles || profile.bundles.length === 0) {
      this.logger.warn(`No bundles found in profile ${profileId}`);
      return resolved;
    }

    for (const bundle of profile.bundles) {
      this.logger.info(`Resolving bundle: ${bundle.id} v${bundle.version} from source: ${bundle.source}`);
      // Note: We don't resolve URLs anymore since registryManager.installBundle()
      // searches sources by bundle ID and uses the appropriate adapter
      resolved.push({ bundle: bundle, url: '' }); // URL not needed
    }

    this.logger.info(`Resolved ${resolved.length} bundles total`);
    return resolved;
  }

  /**
   * Activate a hub profile
   * @param hubId
   * @param profileId
   * @param options
   */
  public async activateProfile(
    hubId: string,
    profileId: string,
    options: ProfileActivationOptions
  ): Promise<ProfileActivationResult> {
    try {
      this.logger.info(`[HubManager] activateProfile called: hubId=${hubId}, profileId=${profileId}, installBundles=${options.installBundles}`);

      // Verify hub and profile exist (throws if not found)
      await this.getHubProfile(hubId, profileId);

      // Deactivate ALL active hub profiles across ALL hubs (enforce single active profile globally)
      // This will uninstall bundles from previously active profiles
      const allHubIds = await this.storage.listHubs();
      for (const currentHubId of allHubIds) {
        // Load hub config to check for active profiles in YAML (not activation states)
        const hubData = await this.storage.loadHub(currentHubId);
        const activeProfile = hubData.config.profiles.find((p) => p.active);

        if (activeProfile && activeProfile.id !== profileId) {
          this.logger.info(`Deactivating hub profile from hub ${currentHubId}: ${activeProfile.id}`);

          // Use RegistryManager to properly deactivate profile and uninstall its bundles
          if (this.registryManager) {
            try {
              await this.registryManager.deactivateProfile(activeProfile.id);
            } catch (error) {
              this.logger.error(`Failed to deactivate profile ${activeProfile.id}`, error as Error);
            }
          } else {
            // Fallback: just update flags if RegistryManager not available
            await this.storage.setProfileActiveFlag(currentHubId, activeProfile.id, false);
            await this.storage.deleteProfileActivationState(currentHubId, activeProfile.id);
          }
        }
      }

      // Resolve all bundles in the profile
      const resolvedBundles = await this.resolveProfileBundles(hubId, profileId);

      // Create activation state with bundle versions
      const syncedBundleVersions: Record<string, string> = {};
      resolvedBundles.forEach((rb) => {
        syncedBundleVersions[rb.bundle.id] = rb.bundle.version;
      });

      const activationState: ProfileActivationState = {
        hubId,
        profileId,
        activatedAt: new Date().toISOString(),
        syncedBundles: resolvedBundles.map((rb) => rb.bundle.id),
        syncedBundleVersions
      };

      // Save activation state
      await this.storage.saveProfileActivationState(hubId, profileId, activationState);

      // Mark profile as active in hub config
      await this.storage.setProfileActiveFlag(hubId, profileId, true);

      // Install bundles if requested and RegistryManager is available
      if (options.installBundles && this.registryManager) {
        this.logger.info(`Installing ${resolvedBundles.length} bundles for profile ${profileId}`);

        const bundlesToInstall = resolvedBundles.map((rb) => ({
          bundleId: rb.bundle.id,
          options: {
            scope: 'user' as const,
            force: false,
            profileId: profileId // Tag bundle with profile ID for tracking
          }
        }));

        try {
          await this.registryManager.installBundles(bundlesToInstall);

          // Assuming success if no error thrown (installBundles handles errors internally but doesn't return individual results easily yet, but logs them)
          this.logger.info(`Bundle installation complete`);
        } catch (error) {
          this.logger.error('Batch bundle installation failed', error as Error);
        }
      } else if (options.installBundles && !this.registryManager) {
        this.logger.warn('Bundle installation requested but RegistryManager not available');
      }

      // Note: Hub profiles are managed separately and displayed in tree view via HubManager
      // No need to sync to local profile storage - that would create duplicates
      /* DISABLED - Hub profiles don't need local sync
            // Sync with local profile in RegistryManager
            if (this.registryManager) {
                try {
                    const localProfiles = await this.registryManager.listProfiles();
                    const localProfile = localProfiles.find((p: any) => p.id === profileId);

                    // Convert hub profile bundles to local profile format
                    const profileBundles = resolvedBundles.map(rb => ({
                        id: rb.bundle.id,
                        version: rb.bundle.version,
                        required: true
                    }));

                    if (localProfile) {
                        // Update existing profile
                        this.logger.info(`Updating local profile: ${profileId}`);
                        await this.registryManager.updateProfile(profileId, {
                            bundles: profileBundles,
                            active: true
                        });
                    } else {
                        // Create new profile
                        this.logger.info(`Creating local profile: ${profileId}`);
                        await this.registryManager.createProfile({
                            id: profileId,
                            name: profile.name,
                            description: profile.description || `Profile from hub ${hubId}`,
                            icon: profile.icon || '📦',
                            bundles: profileBundles,
                            active: true
                        });
                    }
                    this.logger.info(`Local profile ${profileId} synced successfully`);
                } catch (error) {
                    this.logger.error(`Failed to sync local profile: ${profileId}`, error as Error);
                }
            } else {
                this.logger.warn('RegistryManager not available, local profile not synced');
            }
            */

      return {
        success: true,
        hubId,
        profileId,
        resolvedBundles: resolvedBundles.map((rb) => ({
          bundle: rb.bundle,
          url: rb.url
        }))
      };
    } catch (error) {
      return {
        success: false,
        hubId,
        profileId,
        resolvedBundles: [],
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Deactivate a profile
   * @param hubId
   * @param profileId
   */
  public async deactivateProfile(hubId: string, profileId: string): Promise<ProfileDeactivationResult> {
    try {
      // Verify profile exists (throws if not found)
      await this.getHubProfile(hubId, profileId);

      // Get current activation state to track removed bundles
      const currentState = await this.storage.getProfileActivationState(hubId, profileId);
      const removedBundles = currentState ? currentState.syncedBundles : [];

      // Remove activation state
      await this.storage.deleteProfileActivationState(hubId, profileId);

      // Mark profile as inactive
      await this.storage.setProfileActiveFlag(hubId, profileId, false);

      return {
        success: true,
        hubId: hubId,
        profileId: profileId,
        removedBundles: removedBundles
      };
    } catch (error) {
      return {
        success: false,
        hubId: hubId,
        profileId: profileId,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Get the currently active profile for a hub
   * @param hubId
   */
  public async getActiveProfile(hubId: string): Promise<ProfileActivationState | null> {
    return this.storage.getActiveProfileForHub(hubId);
  }

  /**
   * List all active profiles across all hubs
   */
  public async listAllActiveProfiles(): Promise<ProfileActivationState[]> {
    return this.storage.listActiveProfiles();
  }

  /**
   * Get a single hub by ID
   * @param hubId
   */
  public async getHub(hubId: string): Promise<{ id: string; config: HubConfig; reference: HubReference } | null> {
    try {
      const result = await this.storage.loadHub(hubId);
      return {
        id: hubId,
        config: result.config,
        reference: result.reference
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if an active profile has changes in the hub
   * @param hubId
   * @param profileId
   */
  public async hasProfileChanges(hubId: string, profileId: string): Promise<boolean> {
    const changes = await this.getProfileChanges(hubId, profileId);
    if (!changes) {
      return false;
    }
    return (
      (changes.bundlesAdded !== undefined && changes.bundlesAdded.length > 0)
      || (changes.bundlesRemoved !== undefined && changes.bundlesRemoved.length > 0)
      || (changes.bundlesUpdated !== undefined && changes.bundlesUpdated.length > 0)
      || (changes.metadataChanged !== undefined && Object.keys(changes.metadataChanged).length > 0)
    );
  }

  /**
   * Get detailed changes for an active profile
   * @param hubId
   * @param profileId
   */
  public async getProfileChanges(hubId: string, profileId: string): Promise<ProfileChanges | null> {
    // Get activation state
    const state = await this.storage.getProfileActivationState(hubId, profileId);
    if (!state) {
      return null;
    }

    // Get current profile from hub
    const currentProfile = await this.getHubProfile(hubId, profileId);

    // Get synced bundles from activation state
    const syncedBundles = state.syncedBundles;

    // Compare bundles
    const currentBundleIds = currentProfile.bundles.map((b) => b.id);
    const bundlesAdded = currentProfile.bundles.filter((b) => !syncedBundles.includes(b.id));
    const bundlesRemoved = syncedBundles.filter((id) => !currentBundleIds.includes(id));

    // Check for version changes using stored bundle versions
    const bundlesUpdated: { id: string; oldVersion: string; newVersion: string }[] = [];
    const profileUpdated = new Date(currentProfile.updatedAt) > new Date(state.activatedAt);

    if (state.syncedBundleVersions) {
      // Compare each current bundle version with synced version
      for (const bundle of currentProfile.bundles) {
        const syncedVersion = state.syncedBundleVersions[bundle.id];
        if (syncedVersion && syncedVersion !== bundle.version) {
          bundlesUpdated.push({
            id: bundle.id,
            oldVersion: syncedVersion,
            newVersion: bundle.version
          });
        }
      }
    }

    // Check metadata changes by comparing updated timestamp
    const metadataChanged: { name?: boolean; description?: boolean; icon?: boolean } = {};
    if (profileUpdated) {
      metadataChanged.name = true;
      metadataChanged.description = true;
    }

    const changes: ProfileChanges = {};
    if (bundlesAdded.length > 0) {
      changes.bundlesAdded = bundlesAdded;
    }
    if (bundlesRemoved.length > 0) {
      changes.bundlesRemoved = bundlesRemoved;
    }
    if (bundlesUpdated.length > 0) {
      changes.bundlesUpdated = bundlesUpdated;
    }
    if (Object.keys(metadataChanged).length > 0) {
      changes.metadataChanged = metadataChanged;
    }

    return changes;
  }

  /**
   * Sync a profile (update activation state)
   * @param hubId
   * @param profileId
   */
  public async syncProfile(hubId: string, profileId: string): Promise<void> {
    // Re-activate to update the state
    await this.activateProfile(hubId, profileId, { installBundles: false });
  }

  /**
   * Check if a profile is favorited
   * @param hubId Hub identifier
   * @param profileId Profile identifier
   */
  public async isProfileFavorite(hubId: string, profileId: string): Promise<boolean> {
    const favorites = await this.storage.getFavoriteProfiles();
    return favorites[hubId]?.includes(profileId) || false;
  }

  /**
   * Get favorite profiles
   * @returns Map of hub ID to list of profile IDs
   */
  public async getFavoriteProfiles(): Promise<Record<string, string[]>> {
    return this.storage.getFavoriteProfiles();
  }

  /**
   * Toggle profile favorite status
   * @param hubId Hub identifier
   * @param profileId Profile identifier
   */
  public async toggleProfileFavorite(hubId: string, profileId: string): Promise<void> {
    const favorites = await this.getFavoriteProfiles();
    const hubFavorites = favorites[hubId] || [];

    const index = hubFavorites.indexOf(profileId);
    if (index === -1) {
      // Add to favorites
      hubFavorites.push(profileId);
    } else {
      // Remove from favorites
      hubFavorites.splice(index, 1);
    }

    favorites[hubId] = hubFavorites;

    // Clean up empty hubs
    if (favorites[hubId].length === 0) {
      delete favorites[hubId];
    }

    await this.storage.saveFavoriteProfiles(favorites);
    this._onFavoritesChanged.fire();
  }

  /**
   * Cleanup orphaned favorites - remove favorites for hubs that no longer exist
   * This handles stale data from hubs that were deleted before cleanup logic was implemented
   */
  public async cleanupOrphanedFavorites(): Promise<void> {
    const favorites = await this.getFavoriteProfiles();
    const existingHubs = await this.listHubs();
    const existingHubIds = new Set(existingHubs.map((h) => h.id));

    let changed = false;
    for (const hubId of Object.keys(favorites)) {
      if (!existingHubIds.has(hubId)) {
        this.logger.info(`Removing orphaned favorites for non-existent hub: ${hubId}`);
        delete favorites[hubId];
        changed = true;
      }
    }

    if (changed) {
      await this.storage.saveFavoriteProfiles(favorites);
      this._onFavoritesChanged.fire();
    }
  }

  /**
   * Format change summary as human-readable string
   * @param changes
   */
  public formatChangeSummary(changes: ProfileChanges): string {
    const lines: string[] = [];

    if (changes.bundlesAdded && changes.bundlesAdded.length > 0) {
      lines.push('Added bundles:');
      for (const bundle of changes.bundlesAdded) {
        lines.push(`  + ${bundle.id} v${bundle.version}`);
      }
    }

    if (changes.bundlesRemoved && changes.bundlesRemoved.length > 0) {
      lines.push('Removed bundles:');
      for (const bundleId of changes.bundlesRemoved) {
        lines.push(`  - ${bundleId}`);
      }
    }

    if (changes.bundlesUpdated && changes.bundlesUpdated.length > 0) {
      lines.push('Updated bundles:');
      for (const update of changes.bundlesUpdated) {
        lines.push(`  ~ ${update.id}: ${update.oldVersion} → ${update.newVersion}`);
      }
    }

    if (changes.metadataChanged && Object.keys(changes.metadataChanged).length > 0) {
      lines.push('Metadata changes:');
      if (changes.metadataChanged.name) {
        lines.push('  ~ name changed');
      }
      if (changes.metadataChanged.description) {
        lines.push('  ~ description changed');
      }
      if (changes.metadataChanged.icon) {
        lines.push('  ~ icon changed');
      }
    }

    return lines.join('\n');
  }

  /**
   * Create conflict resolution dialog
   * @param changes
   */
  public createConflictResolutionDialog(changes: ProfileChanges): ConflictResolutionDialog {
    const changeCount =
      (changes.bundlesAdded?.length || 0)
      + (changes.bundlesRemoved?.length || 0)
      + (changes.bundlesUpdated?.length || 0)
      + (changes.metadataChanged ? 1 : 0);

    return {
      title: 'Profile Updates Available',
      message: `${changeCount} change${changeCount > 1 ? 's' : ''} detected in the profile`,
      options: [
        {
          label: 'Sync Now',
          description: 'Accept all changes and update profile',
          action: 'sync'
        },
        {
          label: 'Review Changes',
          description: 'View detailed changes before syncing',
          action: 'review'
        },
        {
          label: 'Cancel',
          description: 'Keep current profile version',
          action: 'cancel'
        }
      ]
    };
  }
}
