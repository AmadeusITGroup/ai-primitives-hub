import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  Logger,
} from '../utils/logger';

/** Scopes the extension needs; private hubs are unreadable without `repo`. */
const REQUIRED_SCOPES = ['repo'];

/**
 * Command to force re-authentication with GitHub.
 *
 * Delegating to `RegistryManager.forceAuthentication()` alone is not
 * enough — and was in fact a no-op: it iterates the *source* adapters,
 * none of which implement the optional `forceAuthentication()` hook, and
 * during first-run setup there are no sources registered at all. Nothing
 * in that path touches `vscode.authentication`, so the extension kept
 * reusing the same cached session token while reporting success.
 *
 * This command therefore drives VS Code's authentication API directly.
 * Note the limit of what any extension can do: VS Code has no API to
 * revoke a token server-side. `forceNewSession` makes VS Code run a fresh
 * sign-in and hand back a *new* token; a previously issued token is only
 * invalidated by GitHub itself (revoke the OAuth app's access in GitHub
 * settings) if that is what the user needs.
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
        // `forceNewSession` and `createIfNone` are mutually exclusive in
        // the VS Code API, and `forceNewSession` already implies a sign-in
        // flow. `clearSessionPreference` additionally lets the user land
        // on a different account than the remembered one, which is the
        // other half of "my token is wrong" (right token, wrong account).
        const session = await vscode.authentication.getSession('github', REQUIRED_SCOPES, {
          forceNewSession: true,
          clearSessionPreference: true
        });

        this.logger.info(`[GitHubAuth] New GitHub session issued (account=${session.account.label}, scopes=[${session.scopes.join(', ')}])`);

        const missingScopes = REQUIRED_SCOPES.filter((scope) => !session.scopes.includes(scope));
        if (missingScopes.length > 0) {
          this.logger.warn(`[GitHubAuth] Session is missing required scope(s): ${missingScopes.join(', ')}. Private hubs will not be readable.`);
        }

        // Source adapters still get their chance to re-resolve credentials.
        await this.registryManager.forceAuthentication();
      });

      vscode.window.showInformationMessage('GitHub authentication refreshed successfully');
    } catch (error) {
      this.logger.error('Failed to refresh GitHub authentication', error as Error);
      vscode.window.showErrorMessage(`Authentication failed: ${(error as Error).message}`);
    }
  }
}
