import * as vscode from 'vscode';
import {
  HubManager,
} from '../services/hub-manager';
import {
  HubProfileBundle,
} from '../types/hub';

/**
 * History entry for a sync operation
 */
export interface SyncHistoryEntry {
  hubId: string;
  profileId: string;
  timestamp: string;
  status: 'success' | 'failure' | 'rollback';
  changes: {
    added: HubProfileBundle[];
    updated: { id: string; oldVersion: string; newVersion: string }[];
    removed: string[];
    metadataChanged: boolean;
  };
  previousState: {
    bundles: HubProfileBundle[];
    activatedAt: string;
  };
  error?: string;
}

/**
 * QuickPick item for history entry selection
 */
export interface HistoryQuickPickItem extends vscode.QuickPickItem {
  entry: SyncHistoryEntry;
}

/**
 * Manages sync history for hub profiles, including tracking operations and rollback capability
 */
export class HubSyncHistory {
  private readonly historyMap: Map<string, SyncHistoryEntry[]> = new Map();

  constructor(private readonly hubManager: HubManager) {}

  /**
   * Get the history key for a profile
   * @param hubId
   * @param profileId
   */
  private getHistoryKey(hubId: string, profileId: string): string {
    return `${hubId}:${profileId}`;
  }

  /**
   * Record a sync operation in history
   * @param hubId
   * @param profileId
   * @param changes
   * @param previousState
   * @param status
   * @param error
   */
  public async recordSync(
    hubId: string,
    profileId: string,
    changes: SyncHistoryEntry['changes'],
    previousState: SyncHistoryEntry['previousState'],
    status: 'success' | 'failure' | 'rollback' = 'success',
    error?: string
  ): Promise<void> {
    const key = this.getHistoryKey(hubId, profileId);
    const history = this.historyMap.get(key) || [];

    const entry: SyncHistoryEntry = {
      hubId,
      profileId,
      timestamp: new Date().toISOString(),
      status,
      changes,
      previousState,
      ...(error && { error })
    };

    history.unshift(entry); // Add to beginning (most recent first)
    this.historyMap.set(key, history);
  }

  /**
   * Get sync history for a profile
   * @param hubId
   * @param profileId
   * @param limit Maximum number of entries to return (default: all)
   */
  public async getHistory(hubId: string, profileId: string, limit?: number): Promise<SyncHistoryEntry[]> {
    const key = this.getHistoryKey(hubId, profileId);
    const history = this.historyMap.get(key) || [];

    if (limit !== undefined && limit > 0) {
      return history.slice(0, limit);
    }

    return history;
  }

  /**
   * Format a history entry as human-readable text
   * @param entry
   */
  public formatHistoryEntry(entry: SyncHistoryEntry): string {
    const lines: string[] = [];
    const timestamp = new Date(entry.timestamp).toLocaleString();

    lines.push(`Synced at: ${timestamp}`, `Status: ${entry.status}`);

    if (entry.error) {
      lines.push(`Error: ${entry.error}`);
    }

    lines.push('', 'Changes:');

    if (entry.changes.metadataChanged) {
      lines.push('  Metadata: Changed');
    }

    if (entry.changes.added.length > 0) {
      lines.push('', '  Added Bundles:');
      for (const bundle of entry.changes.added) {
        lines.push(`    ${bundle.id} (${bundle.version}) — Added [NEW]`);
      }
    }

    if (entry.changes.updated.length > 0) {
      lines.push('', '  Updated Bundles:');
      for (const update of entry.changes.updated) {
        lines.push(`    ${update.id} — Updated (${update.oldVersion} → ${update.newVersion})`);
      }
    }

    if (entry.changes.removed.length > 0) {
      lines.push('', '  Removed Bundles:');
      for (const bundleId of entry.changes.removed) {
        lines.push(`    ${bundleId} — Removed [DELETED]`);
      }
    }

    if (
      entry.changes.added.length === 0
      && entry.changes.updated.length === 0
      && entry.changes.removed.length === 0
      && !entry.changes.metadataChanged
    ) {
      lines.push('  No changes');
    }

    return lines.join('\n');
  }

  /**
   * Create QuickPick items from history entries
   * @param entries
   */
  public createHistoryQuickPickItems(entries: SyncHistoryEntry[]): HistoryQuickPickItem[] {
    return entries.map((entry) => {
      const timestamp = new Date(entry.timestamp);
      const dateStr = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
      const timeStr = timestamp.toLocaleTimeString();

      const totalChanges =
        entry.changes.added.length
        + entry.changes.updated.length
        + entry.changes.removed.length
        + (entry.changes.metadataChanged ? 1 : 0);

      const changeParts: string[] = [];
      if (entry.changes.added.length > 0) {
        changeParts.push(`${entry.changes.added.length} added`);
      }
      if (entry.changes.updated.length > 0) {
        changeParts.push(`${entry.changes.updated.length} updated`);
      }
      if (entry.changes.removed.length > 0) {
        changeParts.push(`${entry.changes.removed.length} removed`);
      }
      if (entry.changes.metadataChanged) {
        changeParts.push('metadata changed');
      }

      const description = changeParts.length > 0 ? changeParts.join(', ') : 'No changes';

      const label =
        totalChanges === 0
          ? `${dateStr} ${timeStr} — No changes`
          : `${dateStr} ${timeStr} — ${totalChanges} change${totalChanges === 1 ? '' : 's'}`;

      return {
        label,
        description,
        detail: `Status: ${entry.status}`,
        entry
      };
    });
  }

  /**
   * Rollback a profile to a previous state from history
   * @param hubId
   * @param profileId
   * @param entry
   * @param options
   * @param options.installBundles
   */
  public async rollbackToEntry(
    hubId: string,
    profileId: string,
    entry: SyncHistoryEntry,
    options: { installBundles?: boolean } = {}
  ): Promise<void> {
    // Verify profile is active
    const activeProfile = await this.hubManager.getActiveProfile(hubId);
    if (!activeProfile || activeProfile.profileId !== profileId) {
      throw new Error(`Profile ${profileId} is not active in hub ${hubId}`);
    }

    // Get current state for history
    const currentState = await (this.hubManager as any).storage.getProfileActivationState(hubId, profileId);
    if (!currentState) {
      throw new Error(`Could not load current state for profile ${profileId}`);
    }

    // Get hub to reconstruct bundle details
    const hub = await (this.hubManager as any).storage.loadHub(hubId);
    const currentProfile = hub.config.profiles.find((p: { id: string }) => p.id === profileId);
    if (!currentProfile) {
      throw new Error(`Profile ${profileId} not found in hub ${hubId}`);
    }

    // Reconstruct current bundles from profile
    const currentBundles = currentProfile.bundles || [];

    // Calculate changes for rollback history entry
    const currentBundleIds = new Set(currentBundles.map((b: HubProfileBundle) => b.id));
    const targetBundleIds = new Set(entry.previousState.bundles.map((b: HubProfileBundle) => b.id));

    const rollbackChanges = {
      added: entry.previousState.bundles.filter((b: HubProfileBundle) => !currentBundleIds.has(b.id)),
      updated: entry.previousState.bundles
        .filter((b: HubProfileBundle) => {
          const current = currentBundles.find((cb: HubProfileBundle) => cb.id === b.id);
          return current && current.version !== b.version;
        })
        .map((b: HubProfileBundle) => {
          const current = currentBundles.find((cb: HubProfileBundle) => cb.id === b.id)!;
          return {
            id: b.id,
            oldVersion: current.version,
            newVersion: b.version
          };
        }),
      removed: currentBundles.filter((b: HubProfileBundle) => !targetBundleIds.has(b.id)).map((b: HubProfileBundle) => b.id),
      metadataChanged: false
    };

    // Restore the state
    const newState = {
      hubId,
      profileId,
      activatedAt: new Date().toISOString(),
      syncedBundles: entry.previousState.bundles.map((b: HubProfileBundle) => b.id)
    };

    await (this.hubManager as any).storage.saveProfileActivationState(hubId, profileId, newState);

    // Record rollback in history
    await this.recordSync(
      hubId,
      profileId,
      rollbackChanges,
      {
        bundles: currentBundles,
        activatedAt: currentState.activatedAt
      },
      'rollback'
    );

    // Install/uninstall bundles if requested
    if (options.installBundles) {
      // This would integrate with the bundle installer
      // For now, we just update the state
    }
  }

  /**
   * Clear all history for a profile
   * @param hubId
   * @param profileId
   */
  public async clearHistory(hubId: string, profileId: string): Promise<void> {
    const key = this.getHistoryKey(hubId, profileId);
    this.historyMap.delete(key);
  }

  /**
   * Clear all history for all profiles
   */
  public async clearAllHistory(): Promise<void> {
    this.historyMap.clear();
  }
}
