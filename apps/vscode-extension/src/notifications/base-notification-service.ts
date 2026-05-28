/**
 * Base Notification Service
 * Provides common notification patterns and utilities
 */

import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

/**
 * Base class for notification services
 * Provides consistent notification patterns across the extension
 */
export abstract class BaseNotificationService {
  protected logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
  }

  /**
   * Show success message with optional actions
   * @param message
   * @param actions
   */
  protected async showSuccessWithActions(
    message: string,
    actions: string[] = []
  ): Promise<string | undefined> {
    this.logger.info(`Success notification: ${message}`);
    return await vscode.window.showInformationMessage(message, ...actions);
  }

  /**
   * Show warning message with optional actions
   * @param message
   * @param actions
   */
  protected async showWarningWithActions(
    message: string,
    actions: string[] = []
  ): Promise<string | undefined> {
    this.logger.warn(`Warning notification: ${message}`);
    return await vscode.window.showWarningMessage(message, ...actions);
  }

  /**
   * Show error message with optional actions
   * @param message
   * @param actions
   */
  protected async showErrorWithActions(
    message: string,
    actions: string[] = []
  ): Promise<string | undefined> {
    this.logger.error(`Error notification: ${message}`);
    return await vscode.window.showErrorMessage(message, ...actions);
  }

  /**
   * Show modal confirmation dialog
   * @param message
   * @param confirmText
   * @param cancelText
   */
  protected async showConfirmation(
    message: string,
    confirmText = 'Confirm',
    cancelText = 'Cancel'
  ): Promise<boolean> {
    const result = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      confirmText,
      cancelText
    );
    return result === confirmText;
  }

  /**
   * Show progress notification with custom task
   * @param title
   * @param task
   */
  protected async showProgress<T>(
    title: string,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>
  ): Promise<T> {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false
      },
      task
    );
  }

  /**
   * Format bundle name for display
   * Handles cases where bundle details might not be available
   * @param bundleId
   */
  protected async getBundleDisplayName(bundleId: string): Promise<string> {
    try {
      // This should be implemented by concrete classes
      return await this.resolveBundleName(bundleId);
    } catch {
      this.logger.debug(`Could not resolve bundle name for '${bundleId}', using ID`);
      return bundleId;
    }
  }

  /**
   * Abstract method for resolving bundle names
   * Must be implemented by concrete notification services
   */
  protected abstract resolveBundleName(bundleId: string): Promise<string>;
}
