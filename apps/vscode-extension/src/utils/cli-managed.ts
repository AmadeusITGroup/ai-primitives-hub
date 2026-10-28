/**
 * Refusal for bundles the ai-primitives-hub CLI installed (BR5.6, NFR4.3).
 *
 * Until U3 moves update, uninstall, move and the commit-mode switch onto the
 * shared install-record service, the extension refuses these actions on
 * repository items that come from a 3.0.0 install record
 * (`recordOrigin === 'install-record'`). The refusal is a core
 * `RegistryError` with code `RECORD.CLI_MANAGED`, never a silent return, so no
 * caller can report it as a success. Callers turn it into one warning.
 * @module utils/cli-managed
 */
import {
  isRecordError,
  recordError,
  type RegistryError,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';

/** Extension actions guarded for CLI-installed repository items. */
export type CliManagedAction = 'update' | 'uninstall' | 'move-to-user' | 'switch-commit-mode';

const ACTION_PHRASES: Readonly<Record<Exclude<CliManagedAction, 'update'>, string>> = {
  uninstall: 'uninstall it',
  'move-to-user': 'move it to user scope',
  'switch-commit-mode': 'change its commit mode'
};

/**
 * User-facing refusal message, per action (security-design.md, "Message wording").
 * @param bundleId - Refused bundle.
 * @param action - Refused action.
 * @returns The message; the update wording names the CLI command that works in U1.
 */
export const cliManagedMessage = (bundleId: string, action: CliManagedAction): string => {
  if (action === 'update') {
    return `"${bundleId}" was installed with the ai-primitives-hub CLI. To update it, run "ai-primitives-hub install ${bundleId}" again.`;
  }
  return `"${bundleId}" was installed with the ai-primitives-hub CLI. The extension can't ${ACTION_PHRASES[action]} yet; this arrives in a later release.`;
};

/**
 * Build the `RECORD.CLI_MANAGED` refusal.
 * @param bundleId - Refused bundle.
 * @param action - Refused action.
 * @returns The error, ready to throw.
 */
export const cliManagedError = (bundleId: string, action: CliManagedAction): RegistryError =>
  recordError('RECORD.CLI_MANAGED', {
    message: cliManagedMessage(bundleId, action),
    context: { bundleId, action }
  });

/**
 * Whether an error is the CLI-managed refusal.
 * @param error - Anything thrown.
 */
export const isCliManagedError = (error: unknown): error is RegistryError =>
  isRecordError(error, 'RECORD.CLI_MANAGED');

/**
 * Show the refusal as one warning notification, when `error` is one.
 * @param error - Anything thrown by a guarded action.
 * @returns `true` when the warning was shown and the caller must stop without a success message.
 */
export const showCliManagedWarning = (error: unknown): boolean => {
  if (!isCliManagedError(error)) {
    return false;
  }
  void vscode.window.showWarningMessage(`${error.message} ${error.hint ?? ''}`.trim());
  return true;
};

/**
 * Show one warning listing the bundles a batch skipped because the CLI installed them.
 * @param bundleIds - Refused bundle ids; nothing is shown when empty.
 * @param action - The batch action.
 */
export const showCliManagedBatchWarning = (bundleIds: readonly string[], action: CliManagedAction): void => {
  if (bundleIds.length === 0) {
    return;
  }
  const verb = action === 'update' ? 'updated' : 'uninstalled';
  void vscode.window.showWarningMessage(
    `Skipped ${bundleIds.length} bundle(s) installed with the ai-primitives-hub CLI; they were not ${verb}: ${bundleIds.join(', ')}.`
  );
};
