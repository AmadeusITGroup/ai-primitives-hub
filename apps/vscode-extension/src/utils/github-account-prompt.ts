import * as vscode from 'vscode';
import {
  Logger,
} from './logger';

/**
 * Prompt the user to select which GitHub account Prompt Registry should use.
 *
 * Uses `clearSessionPreference: true` so VS Code shows its native account
 * picker even when an existing session is already trusted.
 *
 * With `createIfNone: true`, `getSession` either returns a valid session or
 * throws when the user dismisses the picker — it does not return `undefined`.
 * Callers should catch the thrown error to route through their existing
 * cancel / markIncomplete path.
 *
 * Downstream adapter `getSession` calls without `clearSessionPreference`
 * will inherit the account chosen here because VS Code persists the
 * preference after the user picks.
 * @throws {Error} if the user dismisses the picker (`getSession` throws)
 */
export async function promptGitHubAccountSelection(): Promise<void> {
  const logger = Logger.getInstance();

  const session = await vscode.authentication.getSession(
    'github',
    ['repo'],
    { clearSessionPreference: true, createIfNone: true }
  );

  logger.info(`GitHub account selected: ${session.account.label}`);
}
