import * as vscode from 'vscode';
import {
  GitHubSessionError,
  VsCodeSessionTokenProvider,
} from '../adapters/vscode-session-token-provider';
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
        await VsCodeSessionTokenProvider.forceAuthentication();
        await this.registryManager.forceAuthentication();
      });

      this.logger.info('[GitHubAuth] phase=refresh-complete');
      await vscode.window.showInformationMessage('GitHub sign-in refreshed. Retry the source operation; repository access has not been verified.');
    } catch (error) {
      const failure = error instanceof GitHubSessionError
        ? error
        : new GitHubSessionError('FAILED', 'GitHub authentication could not be refreshed. Check the authentication output for details.');
      this.logger.warn(`[GitHubAuth] phase=refresh-failed outcome=${failure.code}`);
      if (failure.code === 'CANCELLED') {
        await vscode.window.showInformationMessage(failure.message);
        return;
      }
      const action = await vscode.window.showErrorMessage(failure.message, 'Show Logs', 'Reload Window');
      if (action === 'Show Logs') {
        this.logger.show();
      } else if (action === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }
  }
}
