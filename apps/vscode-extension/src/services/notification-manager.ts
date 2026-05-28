import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

/**
 * Generic notification manager - central service for all notifications
 * Used by specialized notification handlers (ExtensionNotifications, BundleUpdateNotifications, etc.)
 */
export class NotificationManager {
  private static instance: NotificationManager;
  private readonly logger: Logger;

  private constructor() {
    this.logger = Logger.getInstance();
  }

  public static getInstance(): NotificationManager {
    if (!NotificationManager.instance) {
      NotificationManager.instance = new NotificationManager();
    }
    return NotificationManager.instance;
  }

  /**
   * Show information notification with automatic logging
   * @param message - The notification message to display
   * @param actions - Optional action button labels
   * @returns The label of the action button clicked by user, or undefined if dismissed
   * @example
   * const action = await notificationManager.showInfo('Update available', 'Update', 'Dismiss');
   * if (action === 'Update') {
   *     // Handle update action
   * }
   */
  public async showInfo(message: string, ...actions: string[]): Promise<string | undefined> {
    this.logger.info(`Notification (Info): ${message}`);
    return await vscode.window.showInformationMessage(message, ...actions);
  }

  /**
   * Show error notification with automatic logging
   * @param message - The error message to display
   * @param actions - Optional action button labels
   * @returns The label of the action button clicked by user, or undefined if dismissed
   * @example
   * const action = await notificationManager.showError('Operation failed', 'Retry', 'Show Logs');
   * if (action === 'Show Logs') {
   *     // Show error logs
   * }
   */
  public async showError(message: string, ...actions: string[]): Promise<string | undefined> {
    this.logger.error(`Notification (Error): ${message}`);
    return await vscode.window.showErrorMessage(message, ...actions);
  }
}
