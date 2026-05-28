import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

/**
 * Status bar item for Prompt Registry extension
 * Shows a command menu with all available extension commands
 */
export class StatusBar {
  private static instance: StatusBar;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly logger: Logger;

  private constructor() {
    this.logger = Logger.getInstance();

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );

    this.statusBarItem.command = 'promptRegistry.showCommandMenu';
    this.statusBarItem.text = '$(extensions) Prompt Registry';
    this.statusBarItem.tooltip = 'Prompt Registry - Click to show all commands';
  }

  public static getInstance(): StatusBar {
    if (!StatusBar.instance) {
      StatusBar.instance = new StatusBar();
    }
    return StatusBar.instance;
  }

  /**
   * Initialize the status bar
   */
  public async initialize(): Promise<void> {
    try {
      this.statusBarItem.show();
      this.logger.debug('Status bar initialized');
    } catch (error) {
      this.logger.error('Failed to initialize status bar', error as Error);
    }
  }

  /**
   * Dispose of the status bar
   */
  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
