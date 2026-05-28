import * as vscode from 'vscode';
import {
  NotificationManager,
} from '../services/notification-manager';
import {
  Logger,
} from '../utils/logger';

/**
 * Specialized notification handler for extension self-updates and installation
 * Uses generic NotificationManager for display
 */
export class ExtensionNotifications {
  private static instance: ExtensionNotifications;
  private readonly notificationManager: NotificationManager;
  private readonly logger: Logger;

  private constructor() {
    this.notificationManager = NotificationManager.getInstance();
    this.logger = Logger.getInstance();
  }

  public static getInstance(): ExtensionNotifications {
    if (!ExtensionNotifications.instance) {
      ExtensionNotifications.instance = new ExtensionNotifications();
    }
    return ExtensionNotifications.instance;
  }

  /**
   * Show first install welcome notification with button to open marketplace
   */
  public async showWelcomeNotification(): Promise<'marketplace' | 'dismiss' | undefined> {
    const message = 'Welcome to Prompt Registry! Browse and install AI prompt bundles for GitHub Copilot.';

    const action = await this.notificationManager.showInfo(message, 'Open Marketplace', 'Dismiss');

    switch (action) {
      case 'Open Marketplace': {
        await vscode.commands.executeCommand('vscode.openView', 'promptregistry.marketplace');
        return 'marketplace';
      }
      case 'Dismiss': {
        return 'dismiss';
      }
      default: {
        return undefined;
      }
    }
  }

  /**
   * Show generic error notification
   * Provided for backward compatibility with existing extension code
   * New code should use NotificationManager directly for better separation of concerns
   * @param message
   * @param {...string} actions
   */
  public async showError(message: string, ...actions: string[]): Promise<string | undefined> {
    return await this.notificationManager.showError(message, ...actions);
  }
}
