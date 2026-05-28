import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  Logger,
} from '../utils/logger';

/**
 * Command to force re-authentication with GitHub
 * Useful when the token expires or user wants to switch accounts
 */
export class GitHubAuthCommand {
  private readonly logger = Logger.getInstance();

  constructor(private readonly registryManager: RegistryManager) {}

  public async execute(): Promise<void> {
    try {
      this.logger.info('Executing Force GitHub Authentication command');

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Authenticating with GitHub...',
        cancellable: false
      }, async () => {
        await this.registryManager.forceAuthentication();
      });

      vscode.window.showInformationMessage('GitHub authentication refreshed successfully');
    } catch (error) {
      this.logger.error('Failed to refresh GitHub authentication', error as Error);
      vscode.window.showErrorMessage(`Authentication failed: ${(error as Error).message}`);
    }
  }
}
