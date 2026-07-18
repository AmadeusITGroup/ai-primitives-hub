/**
 * MigrationRegistry - Tracks data migrations via context.globalState
 *
 * Follows the SetupStateManager singleton pattern. Each migration is a named
 * entry with pending/completed/skipped status. The registry ensures migrations
 * run at most once (idempotent).
 */

import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

/**
 * Record for a single migration
 */
export interface MigrationRecord {
  status: 'pending' | 'completed' | 'skipped';
  completedAt?: string;
  details?: string;
}

/**
 * MigrationRegistry singleton service
 */
export class MigrationRegistry {
  private static instance: MigrationRegistry | undefined;
  private readonly logger: Logger;
  private readonly STATE_KEY = 'promptregistry.migrations';

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.logger = Logger.getInstance();
  }

  /**
   * Get singleton instance.
   * @param context - VS Code extension context (required on first call)
   */
  public static getInstance(context?: vscode.ExtensionContext): MigrationRegistry {
    if (!MigrationRegistry.instance) {
      if (!context) {
        throw new Error('MigrationRegistry requires context on first call');
      }
      MigrationRegistry.instance = new MigrationRegistry(context);
    }
    return MigrationRegistry.instance;
  }

  /**
   * Reset singleton instance (for testing)
   */
  public static resetInstance(): void {
    MigrationRegistry.instance = undefined;
  }

  /**
   * Mark a migration as completed
   * @param name
   * @param details
   */
  public async markMigrationComplete(name: string, details?: string): Promise<void> {
    const state = await this.getMigrationState();
    state[name] = {
      status: 'completed',
      completedAt: new Date().toISOString(),
      details
    };
    await this.context.globalState.update(this.STATE_KEY, state);
    this.logger.info(`Migration '${name}' marked as completed`);
  }

  /**
   * Get the full migration state
   */
  public async getMigrationState(): Promise<Record<string, MigrationRecord>> {
    return this.context.globalState.get<Record<string, MigrationRecord>>(this.STATE_KEY, {});
  }

  /**
   * Run a migration idempotently. If already completed or skipped, the function is not called.
   * @param name
   * @param fn
   */
  public async runMigration(name: string, fn: () => Promise<void>): Promise<void> {
    const state = await this.getMigrationState();
    const record = state[name];

    if (record?.status === 'completed' || record?.status === 'skipped') {
      this.logger.debug(`Migration '${name}' already ${record.status}, skipping`);
      return;
    }

    this.logger.info(`Running migration '${name}'...`);
    try {
      await fn();
      await this.markMigrationComplete(name);
    } catch (error) {
      this.logger.error(`Migration '${name}' failed`, error as Error);
      throw error;
    }
  }
}
