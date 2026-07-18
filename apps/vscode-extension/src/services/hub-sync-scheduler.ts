/**
 * Hub Sync Scheduler Service
 * Periodically syncs the active hub configuration to keep it up-to-date
 */

import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';
import {
  HubManager,
} from './hub-manager';

const SCHEDULER_CONSTANTS = {
  SYNC_INTERVAL_MS: 24 * 60 * 60 * 1000 // 24 hours
} as const;

/**
 * Schedules periodic hub sync to keep hub configuration fresh.
 * Follows the UpdateScheduler pattern: setTimeout re-scheduling with overlap guard.
 */
export class HubSyncScheduler {
  private readonly logger: Logger;
  private scheduledSyncTimer?: NodeJS.Timeout;
  private isSyncInProgress = false;
  private isInitialized = false;
  private readonly isTestEnvironment: boolean;

  constructor(
    context: vscode.ExtensionContext,
    private readonly hubManager: HubManager
  ) {
    this.logger = Logger.getInstance();

    // Test environment detection — same pattern as UpdateScheduler.
    // Node.js timers keep the process alive, causing test runners to hang.
    const isNodeTestEnvironment =
      process.env.NODE_ENV === 'test'
      || process.argv.some((arg) => arg.includes('mocha'))
      || process.argv.some((arg) => arg.includes('test'));
    const allowTimersOverride = process.env.HUB_SYNC_SCHEDULER_ALLOW_TIMERS_IN_TESTS === 'true';
    this.isTestEnvironment = isNodeTestEnvironment && !allowTimersOverride;

    // Register for automatic disposal when extension deactivates
    if (context?.subscriptions) {
      context.subscriptions.push({
        dispose: () => this.dispose()
      });
    }
  }

  /**
   * Schedule the next periodic hub sync using setTimeout with re-scheduling.
   */
  private schedulePeriodicSync(): void {
    if (this.isTestEnvironment) {
      this.logger.debug('Test environment detected, skipping periodic sync timers');
      return;
    }

    // Clear existing timer
    if (this.scheduledSyncTimer) {
      clearTimeout(this.scheduledSyncTimer);
      this.scheduledSyncTimer = undefined;
    }

    const intervalMs = SCHEDULER_CONSTANTS.SYNC_INTERVAL_MS;
    this.logger.debug(`Scheduling periodic hub sync in ${intervalMs}ms`);

    this.scheduledSyncTimer = setTimeout(async () => {
      if (this.isSyncInProgress) {
        this.logger.warn('Previous hub sync still in progress, skipping this cycle');
        this.schedulePeriodicSync();
        return;
      }

      this.isSyncInProgress = true;
      try {
        this.logger.info('Performing scheduled hub sync');
        await this.hubManager.syncActiveHub();
      } catch (error) {
        this.logger.error('Scheduled hub sync failed', error as Error);
      } finally {
        this.isSyncInProgress = false;
        this.schedulePeriodicSync();
      }
    }, intervalMs);
  }

  /**
   * Start the periodic hub sync timer.
   */
  public initialize(): void {
    if (this.isInitialized) {
      this.logger.debug('HubSyncScheduler already initialized');
      return;
    }

    this.logger.info('Initializing HubSyncScheduler');

    if (this.isTestEnvironment) {
      this.logger.debug('Test environment detected, skipping hub sync timers');
    } else {
      this.schedulePeriodicSync();
    }

    this.isInitialized = true;
    this.logger.info('HubSyncScheduler initialized successfully');
  }

  /**
   * Cleanup timers.
   */
  public dispose(): void {
    this.logger.debug('Disposing HubSyncScheduler');

    if (this.scheduledSyncTimer) {
      clearTimeout(this.scheduledSyncTimer);
      this.scheduledSyncTimer = undefined;
    }

    this.isInitialized = false;
  }
}
