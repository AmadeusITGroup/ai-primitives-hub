/**
 * HubSyncCommands - Commands for manual profile synchronization
 * Provides VS Code commands for checking updates and syncing profiles
 */

import {
  HubManager,
} from '../services/hub-manager';
import {
  ConflictResolutionDialog,
  ProfileChanges,
} from '../types/hub';
import {
  HubSyncHistory,
} from './hub-sync-history';

/**
 * Result of checking for updates
 */
export interface UpdateCheckResult {
  hasUpdates: boolean;
  changes?: ProfileChanges;
  message?: string;
}

/**
 * Result of viewing changes
 */
export interface ViewChangesResult {
  summary: string;
  changes: ProfileChanges;
}

/**
 * Result of review and sync
 */
export interface ReviewSyncResult {
  dialog: ConflictResolutionDialog;
  changes: ProfileChanges;
}

/**
 * Commands for manual profile synchronization
 */
export class HubSyncCommands {
  constructor(
    private readonly hubManager: HubManager,
    private readonly syncHistory?: HubSyncHistory
  ) {}

  /**
   * Check if a profile has updates available
   * @param hubId
   * @param profileId
   */
  public async checkForUpdates(hubId: string, profileId: string): Promise<UpdateCheckResult> {
    const state = await this.hubManager.getActiveProfile(hubId);

    if (!state || state.profileId !== profileId) {
      return {
        hasUpdates: false,
        message: 'Profile is not active'
      };
    }

    const hasChanges = await this.hubManager.hasProfileChanges(hubId, profileId);

    if (!hasChanges) {
      return { hasUpdates: false };
    }

    const changes = await this.hubManager.getProfileChanges(hubId, profileId);

    return {
      hasUpdates: true,
      changes: changes || undefined
    };
  }

  /**
   * View detailed changes for a profile
   * @param hubId
   * @param profileId
   */
  public async viewChanges(hubId: string, profileId: string): Promise<ViewChangesResult | null> {
    const changes = await this.hubManager.getProfileChanges(hubId, profileId);

    if (!changes) {
      return null;
    }

    const hasAnyChanges =
      (changes.bundlesAdded !== undefined && changes.bundlesAdded.length > 0)
      || (changes.bundlesRemoved !== undefined && changes.bundlesRemoved.length > 0)
      || (changes.bundlesUpdated !== undefined && changes.bundlesUpdated.length > 0)
      || (changes.metadataChanged !== undefined && Object.keys(changes.metadataChanged).length > 0);

    if (!hasAnyChanges) {
      return null;
    }

    const summary = this.hubManager.formatChangeSummary(changes);

    return {
      summary,
      changes
    };
  }

  /**
   * Sync a profile to accept all changes
   * @param hubId
   * @param profileId
   */
  public async syncProfile(hubId: string, profileId: string): Promise<void> {
    const state = await this.hubManager.getActiveProfile(hubId);

    if (!state || state.profileId !== profileId) {
      throw new Error(`Profile ${profileId} in hub ${hubId} is not active`);
    }

    // Get changes and previous state for history
    const changes = await this.hubManager.getProfileChanges(hubId, profileId);
    const previousState = {
      bundles: [], // Simplified - actual bundles tracked in state
      activatedAt: state.activatedAt
    };

    try {
      await this.hubManager.syncProfile(hubId, profileId);

      // Record successful sync to history
      if (this.syncHistory && changes) {
        const syncChanges = {
          added: changes.bundlesAdded || [],
          updated: (changes.bundlesUpdated || []).map((u) => ({
            id: u.id,
            oldVersion: u.oldVersion,
            newVersion: u.newVersion
          })),
          removed: changes.bundlesRemoved || [],
          metadataChanged: !!(changes.metadataChanged)
        };

        await this.syncHistory.recordSync(
          hubId,
          profileId,
          syncChanges,
          previousState,
          'success'
        );
      }
    } catch (error) {
      // Record failed sync to history
      if (this.syncHistory) {
        await this.syncHistory.recordSync(
          hubId,
          profileId,
          { added: [], updated: [], removed: [], metadataChanged: false },
          previousState,
          'failure',
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
  }

  /**
   * Review changes and provide sync dialog
   * @param hubId
   * @param profileId
   */
  public async reviewAndSync(hubId: string, profileId: string): Promise<ReviewSyncResult | null> {
    const changes = await this.hubManager.getProfileChanges(hubId, profileId);

    if (!changes) {
      return null;
    }

    const hasAnyChanges =
      (changes.bundlesAdded !== undefined && changes.bundlesAdded.length > 0)
      || (changes.bundlesRemoved !== undefined && changes.bundlesRemoved.length > 0)
      || (changes.bundlesUpdated !== undefined && changes.bundlesUpdated.length > 0)
      || (changes.metadataChanged !== undefined && Object.keys(changes.metadataChanged).length > 0);

    if (!hasAnyChanges) {
      return null;
    }

    const dialog = this.hubManager.createConflictResolutionDialog(changes);

    return {
      dialog,
      changes
    };
  }
}
