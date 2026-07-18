/**
 * Update Scheduler Service
 * Manages the timing and triggering of update checks
 */

import * as vscode from 'vscode';
import {
  BundleUpdateNotifications,
} from '../notifications/bundle-update-notifications';
import {
  getValidNotificationPreference,
  getValidUpdateCheckFrequency,
  UpdateCheckFrequency,
} from '../utils/config-type-guards';
import {
  Logger,
} from '../utils/logger';
import {
  AutoUpdateService,
} from './auto-update-service';
import {
  UpdateCheckResult,
} from './update-cache';
import {
  UpdateChecker,
} from './update-checker';

// Re-export for backward compatibility

/**
 * Update scheduler configuration
 */
export interface UpdateSchedulerConfig {
  enabled: boolean;
  frequency: UpdateCheckFrequency;
  startupCheckDelay: number; // milliseconds
}

/**
 * Update scheduler constants
 */
const SCHEDULER_CONSTANTS = {
  STARTUP_CHECK_DELAY_MS: 5000, // 5 seconds per requirements
  DAILY_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 hours
  WEEKLY_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  UPDATE_CHECK_TIMEOUT_MS: 30_000 // 30 seconds timeout for update checks
} as const;

/**
 * Update scheduler service
 * Orchestrates automatic update checks on startup and periodic intervals
 */
export class UpdateScheduler {
  private readonly updateChecker: UpdateChecker;
  private readonly bundleNotifications: BundleUpdateNotifications;
  private readonly autoUpdateService?: AutoUpdateService;
  private readonly logger: Logger;
  private scheduledCheckTimer?: NodeJS.Timeout;
  private startupCheckTimer?: NodeJS.Timeout;
  private lastCheckTime?: Date;
  private readonly config: UpdateSchedulerConfig;
  private isInitialized = false;
  private isCheckInProgress = false;
  private readonly isTestEnvironment: boolean;

  // Event emitter for update detection - typed with UpdateCheckResult[]
  private readonly _onUpdatesDetected = new vscode.EventEmitter<UpdateCheckResult[]>();
  public readonly onUpdatesDetected = this._onUpdatesDetected.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    updateChecker: UpdateChecker,
    bundleNameResolver?: (bundleId: string) => Promise<string>,
    autoUpdateService?: AutoUpdateService
  ) {
    this.updateChecker = updateChecker;
    this.bundleNotifications = new BundleUpdateNotifications(bundleNameResolver);
    this.autoUpdateService = autoUpdateService;
    this.logger = Logger.getInstance();

    // Test Environment Detection
    // ---------------------------
    // This detection exists because Node.js timers (setTimeout/setInterval) keep the
    // process alive, causing test runners to hang. While dependency injection for a
    // TimerStrategy interface would be more "pure", this pragmatic approach:
    // 1. Avoids adding complexity for a single use case
    // 2. Is well-tested via property tests (UpdateScheduler.property.test.ts)
    // 3. Allows opt-in via UPDATE_SCHEDULER_ALLOW_TIMERS_IN_TESTS for integration tests
    // 4. Uses explicit detection rather than mocking internals
    const isNodeTestEnvironment =
      process.env.NODE_ENV === 'test'
      || process.argv.some((arg) => arg.includes('mocha'))
      || process.argv.some((arg) => arg.includes('test'));
    const allowTimersOverride = process.env.UPDATE_SCHEDULER_ALLOW_TIMERS_IN_TESTS === 'true';
    this.isTestEnvironment = isNodeTestEnvironment && !allowTimersOverride;

    // Load configuration
    this.config = this.loadConfiguration();

    // Register for automatic disposal when extension deactivates (if subscriptions available)
    if (context?.subscriptions) {
      context.subscriptions.push({
        dispose: () => this.dispose()
      });
    }
  }

  /**
   * Schedule startup update check
   * Triggers within configured delay after activation
   */
  private scheduleStartupCheck(): void {
    this.logger.debug(`Scheduling startup check in ${this.config.startupCheckDelay}ms`);

    this.startupCheckTimer = setTimeout(async () => {
      try {
        this.logger.info('Performing startup update check');
        await this.performUpdateCheck();
      } catch (error) {
        this.logger.error('Startup update check failed', error as Error);
      } finally {
        this.startupCheckTimer = undefined;
      }
    }, this.config.startupCheckDelay);
  }

  /**
   * Perform an update check with timeout protection
   * CRITICAL: Triggers notifications when updates are detected
   * @param bypassCache
   */
  private async performUpdateCheck(bypassCache = false): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    let checkPromise: Promise<any>;

    if (this.isTestEnvironment) {
      // In test environment, avoid creating long-lived timers that can cause test hangs
      checkPromise = this.updateChecker.checkForUpdates(bypassCache);
    } else {
      // Add timeout protection for update checks in normal operation
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Update check timed out')),
          SCHEDULER_CONSTANTS.UPDATE_CHECK_TIMEOUT_MS
        );
      });

      checkPromise = Promise.race([
        this.updateChecker.checkForUpdates(bypassCache),
        timeoutPromise
      ]);
    }

    try {
      const updates = await checkPromise;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }

      this.lastCheckTime = new Date();

      // Defensive check: ensure updates is an array
      if (!Array.isArray(updates)) {
        this.logger.warn('UpdateChecker.checkForUpdates() returned non-array, treating as no updates');
        return;
      }

      this.logger.info(`Update check complete: ${updates.length} updates found`);

      // Emit event for update detection (for tree view updates)
      if (updates.length > 0) {
        this.logger.debug(`Updates available for: ${updates.map((u) => u.bundleId).join(', ')}`);
        this._onUpdatesDetected.fire(updates);

        // 1. Check global auto-update setting
        const config = vscode.workspace.getConfiguration('promptregistry.updateCheck');
        const globalAutoUpdateEnabled = config.get<boolean>('autoUpdate', false);

        // 2. If global auto-update is enabled, trigger background updates for opted-in bundles
        if (globalAutoUpdateEnabled && this.autoUpdateService) {
          this.logger.info(`Global auto-update enabled, processing ${updates.length} updates`);
          try {
            await this.autoUpdateService.autoUpdateBundles(updates);
            this.logger.info('Auto-update batch completed');
          } catch (error) {
            this.logger.error('Auto-update batch failed', error as Error);
            // Continue to show notifications even if auto-update fails
          }
        } else if (globalAutoUpdateEnabled && !this.autoUpdateService) {
          this.logger.warn('Global auto-update enabled but AutoUpdateService not available');
        } else {
          this.logger.debug('Global auto-update disabled, skipping background updates');
        }

        // 3. Show notifications for all applicable updates (including those that failed auto-update)
        const rawNotificationPreference = config.get<string>('notificationPreference', 'all');

        // Validate and sanitize notification preference
        const notificationPreference = getValidNotificationPreference(rawNotificationPreference, 'all');

        // Log warning if invalid value was provided
        if (rawNotificationPreference !== notificationPreference) {
          this.logger.warn(
            `Invalid notification preference "${rawNotificationPreference}" in configuration. Using default "${notificationPreference}".`
          );
        }

        this.logger.debug(`Showing update notification with preference: ${notificationPreference}`);
        await this.bundleNotifications.showUpdateNotification({
          updates,
          notificationPreference
        });
      }
    } catch (error) {
      this.logger.error('Update check failed', error as Error);
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    }
  }

  /**
   * Get check interval in milliseconds based on frequency
   */
  private getCheckInterval(): number {
    switch (this.config.frequency) {
      case 'daily': {
        return SCHEDULER_CONSTANTS.DAILY_INTERVAL_MS;
      }
      case 'weekly': {
        return SCHEDULER_CONSTANTS.WEEKLY_INTERVAL_MS;
      }
      default: {
        return 0;
      } // No automatic checks
    }
  }

  /**
   * Load configuration from VS Code settings
   */
  private loadConfiguration(): UpdateSchedulerConfig {
    const config = vscode.workspace.getConfiguration('promptregistry.updateCheck');
    const rawFrequency = config.get<string>('frequency', 'daily');

    // Validate and sanitize frequency
    const frequency = getValidUpdateCheckFrequency(rawFrequency, 'daily');

    // Log warning if invalid value was provided
    if (rawFrequency !== frequency) {
      this.logger.warn(
        `Invalid update check frequency "${rawFrequency}" in configuration. Using default "${frequency}".`
      );
    }

    return {
      enabled: config.get<boolean>('enabled', true),
      frequency,
      startupCheckDelay: SCHEDULER_CONSTANTS.STARTUP_CHECK_DELAY_MS
    };
  }

  /**
   * Initialize scheduler and perform startup check
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.debug('UpdateScheduler already initialized');
      return;
    }

    this.logger.info('Initializing UpdateScheduler');

    // Schedule startup check
    if (this.config.enabled && !this.isTestEnvironment) {
      this.scheduleStartupCheck();
      this.schedulePeriodicChecks();
    } else if (!this.config.enabled) {
      this.logger.debug('UpdateScheduler disabled by configuration, skipping timers');
    } else if (this.isTestEnvironment) {
      this.logger.debug('Test environment detected, skipping scheduler timers');
    }

    this.isInitialized = true;
    this.logger.info('UpdateScheduler initialized successfully');
  }

  /**
   * Schedule periodic update checks based on configuration
   */
  public schedulePeriodicChecks(): void {
    if (this.isTestEnvironment) {
      this.logger.debug('Test environment detected, skipping periodic check timers');
      return;
    }

    // Clear existing timer
    if (this.scheduledCheckTimer) {
      clearTimeout(this.scheduledCheckTimer);
      this.scheduledCheckTimer = undefined;
    }

    // Don't schedule if disabled or manual-only
    if (!this.config.enabled || this.config.frequency === 'manual') {
      this.logger.debug('Periodic checks disabled or set to manual');
      return;
    }

    const intervalMs = this.getCheckInterval();
    this.logger.debug(`Scheduling periodic checks every ${intervalMs}ms (${this.config.frequency})`);

    this.scheduledCheckTimer = setTimeout(async () => {
      // Prevent overlapping checks
      if (this.isCheckInProgress) {
        this.logger.warn('Previous check still in progress, skipping this cycle');
        this.schedulePeriodicChecks();
        return;
      }

      this.isCheckInProgress = true;
      try {
        this.logger.info('Performing scheduled update check');
        await this.performUpdateCheck();
      } catch (error) {
        this.logger.error('Scheduled update check failed', error as Error);
      } finally {
        this.isCheckInProgress = false;
        // Reschedule next check
        this.schedulePeriodicChecks();
      }
    }, intervalMs);
  }

  /**
   * Manually trigger an update check
   * Bypasses cache and schedule
   */
  public async checkNow(): Promise<void> {
    this.logger.info('Manual update check triggered');
    await this.performUpdateCheck(true);
  }

  /**
   * Update check frequency when settings change
   * @param frequency
   */
  public updateSchedule(frequency: UpdateCheckFrequency): void {
    this.logger.info(`Updating check frequency to: ${frequency}`);
    this.config.frequency = frequency;

    // Reschedule with new frequency
    this.schedulePeriodicChecks();
  }

  /**
   * Update enabled state when settings change
   * @param enabled
   */
  public updateEnabled(enabled: boolean): void {
    this.logger.info(`Updating enabled state to: ${enabled}`);
    this.config.enabled = enabled;

    if (enabled) {
      this.schedulePeriodicChecks();
    } else {
      // Clear scheduled checks
      if (this.scheduledCheckTimer) {
        clearTimeout(this.scheduledCheckTimer);
        this.scheduledCheckTimer = undefined;
      }
    }
  }

  /**
   * Cleanup timers
   */
  public dispose(): void {
    this.logger.debug('Disposing UpdateScheduler');

    if (this.startupCheckTimer) {
      clearTimeout(this.startupCheckTimer);
      this.startupCheckTimer = undefined;
    }

    if (this.scheduledCheckTimer) {
      clearTimeout(this.scheduledCheckTimer);
      this.scheduledCheckTimer = undefined;
    }

    this._onUpdatesDetected.dispose();

    this.isInitialized = false;
  }
}

export { type UpdateCheckFrequency } from '../utils/config-type-guards';
