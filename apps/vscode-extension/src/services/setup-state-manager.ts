/**
 * SetupStateManager - Manages first-run setup state and resumption logic
 * Tracks setup progress through distinct states and provides recovery paths
 */

import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';
import {
  HubManager,
} from './hub-manager';

/**
 * Setup state enum
 */
export enum SetupState {
  NOT_STARTED = 'not_started',
  IN_PROGRESS = 'in_progress',
  COMPLETE = 'complete',
  INCOMPLETE = 'incomplete'
}

/**
 * SetupStateManager manages setup state and provides state transition logic
 */
export class SetupStateManager {
  private static instance: SetupStateManager | undefined;

  /**
   * Get singleton instance.
   *
   * Note: On first call, both context and hubManager are required.
   * Subsequent calls return the existing instance (parameters are ignored).
   * Use resetInstance() in tests to create a fresh instance.
   * @param context - VS Code extension context (required on first call)
   * @param hubManager - HubManager instance (required on first call)
   * @returns SetupStateManager singleton instance
   * @throws {Error} if context or hubManager is missing on first call
   */
  public static getInstance(
    context?: vscode.ExtensionContext,
    hubManager?: HubManager
  ): SetupStateManager {
    if (!SetupStateManager.instance) {
      if (!context || !hubManager) {
        throw new Error('SetupStateManager requires context and hubManager on first call');
      }
      SetupStateManager.instance = new SetupStateManager(context, hubManager);
    }
    return SetupStateManager.instance;
  }

  /**
   * Reset singleton instance (for testing)
   */
  public static resetInstance(): void {
    SetupStateManager.instance = undefined;
  }

  private readonly logger: Logger;
  private readonly SETUP_STATE_KEY = 'promptregistry.setupState';

  // Session-scoped flag (not persisted across extension reloads)
  private resumePromptShown = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly hubManager: HubManager
  ) {
    this.logger = Logger.getInstance();
  }

  /**
   * Transition to a new state with logging
   * @param newState
   */
  private async transitionState(newState: SetupState): Promise<void> {
    const oldState = await this.getState();

    if (oldState === newState) {
      this.logger.debug(`Setup state already ${newState}, no transition needed`);
      return;
    }

    await this.context.globalState.update(this.SETUP_STATE_KEY, newState);
    this.logger.info(`State transition: ${oldState} → ${newState}`);
  }

  /**
   * Get current setup state
   */
  public async getState(): Promise<SetupState> {
    const state = this.context.globalState.get<string>(this.SETUP_STATE_KEY);

    // Validate state value
    if (state && Object.values(SetupState).includes(state as SetupState)) {
      return state as SetupState;
    }

    // Default to NOT_STARTED if invalid or missing
    return SetupState.NOT_STARTED;
  }

  /**
   * Check if setup is complete
   */
  public async isComplete(): Promise<boolean> {
    const state = await this.getState();
    return state === SetupState.COMPLETE;
  }

  /**
   * Check if setup is incomplete
   */
  public async isIncomplete(): Promise<boolean> {
    const state = await this.getState();
    return state === SetupState.INCOMPLETE;
  }

  /**
   * Mark setup as started
   */
  public async markStarted(): Promise<void> {
    await this.transitionState(SetupState.IN_PROGRESS);
  }

  /**
   * Mark setup as complete
   */
  public async markComplete(): Promise<void> {
    await this.transitionState(SetupState.COMPLETE);
  }

  /**
   * Mark setup as incomplete
   */
  public async markIncomplete(): Promise<void> {
    await this.transitionState(SetupState.INCOMPLETE);
    this.logger.info('Setup marked as incomplete');
  }

  /**
   * Reset setup state to not started
   */
  public async reset(): Promise<void> {
    await this.transitionState(SetupState.NOT_STARTED);
    this.resumePromptShown = false;
    this.logger.info('Setup state reset to not_started');
  }

  /**
   * Detect incomplete setup from previous session
   * Handles backward compatibility with old firstRun and hubInitialized flags
   */
  public async detectIncompleteSetup(): Promise<boolean> {
    const state = await this.getState();

    // If state is explicitly set, use it
    if (state !== SetupState.NOT_STARTED) {
      return state === SetupState.INCOMPLETE;
    }

    // Backward compatibility: check old flags
    const firstRun = this.context.globalState.get<boolean>('promptregistry.firstRun', true);
    const hubInitialized = this.context.globalState.get<boolean>('promptregistry.hubInitialized', false);

    // If firstRun=false but no hub, setup is incomplete
    if (!firstRun && !hubInitialized) {
      const hubs = await this.hubManager.listHubs();
      const activeHub = await this.hubManager.getActiveHub();

      if (hubs.length === 0 && !activeHub) {
        // Migrate to new state system
        this.logger.info('Detected incomplete setup from old flags, migrating to new state system');
        await this.markIncomplete();
        return true;
      }
    }

    return false;
  }

  /**
   * Check if resume prompt should be shown
   * Returns true if setup is incomplete and prompt hasn't been shown this session
   */
  public async shouldShowResumePrompt(): Promise<boolean> {
    const isIncomplete = await this.isIncomplete();
    if (!isIncomplete) {
      return false;
    }

    return !this.resumePromptShown;
  }

  /**
   * Mark resume prompt as shown for this session
   */
  public async markResumePromptShown(): Promise<void> {
    this.resumePromptShown = true;
    this.logger.debug('Resume prompt marked as shown for this session');
  }
}
