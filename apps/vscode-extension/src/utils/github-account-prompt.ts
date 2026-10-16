import * as vscode from 'vscode';
import {
  VsCodeSessionTokenProvider,
} from '../adapters/vscode-session-token-provider';
import {
  Logger,
} from './logger';

/**
 * Prompt the user to select which GitHub account AI Primitives Hub should use.
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

  await VsCodeSessionTokenProvider.selectAccount();
  logger.info('[GitHubAuth] phase=account-selected');
}

const hasGitHubSession = async (): Promise<boolean> => {
  try {
    return (await new VsCodeSessionTokenProvider(false).getToken('github.com')) !== undefined;
  } catch {
    return false;
  }
};

type GitHubAuthenticationCheck = () => Promise<boolean>;

/**
 * Offer sign-in during first-run setup without blocking non-GitHub hubs.
 * @param hasGitHubAuth
 * @returns Whether a GitHub session is available after the offer.
 */
export async function offerGitHubAccountSelection(
  hasGitHubAuth: GitHubAuthenticationCheck = hasGitHubSession
): Promise<boolean> {
  if (await hasGitHubAuth()) {
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    'Sign in to use GitHub hubs. You can continue without GitHub to use Artifactory or local hubs.',
    'Continue without GitHub',
    'Sign in'
  );
  if (choice !== 'Sign in') {
    return false;
  }
  try {
    await promptGitHubAccountSelection();
    return true;
  } catch {
    Logger.getInstance().info('GitHub sign-in was skipped during hub setup');
    return false;
  }
}

/**
 * Require a GitHub session for a GitHub-backed hub import.
 * @param hasGitHubAuth
 * @throws {Error} If the user cancels the sign-in flow.
 */
export async function ensureGitHubAccountSelection(
  hasGitHubAuth: GitHubAuthenticationCheck = hasGitHubSession
): Promise<void> {
  if (await hasGitHubAuth()) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Sign in to import this GitHub hub.',
    'Cancel import',
    'Sign in'
  );
  if (choice !== 'Sign in') {
    throw new Error('GitHub sign-in is required to import this GitHub hub.');
  }
  await promptGitHubAccountSelection();
}
