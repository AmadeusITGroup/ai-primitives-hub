/**
 * Refusal for repository entries another tool owns. The extension changes only
 * its own tool's entries; it throws `RECORD.CLI_MANAGED`, never a silent
 * return, and callers show one warning.
 * @module utils/cli-managed
 */
import {
  isRecordError,
  recordError,
  type RegistryError,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';

/** Extension actions guarded for repository entries of another tool. */
export type CliManagedAction = 'update' | 'uninstall' | 'move-to-user' | 'switch-commit-mode';

/**
 * The CLI command that does the refused action for another tool. Moving to
 * user scope starts with an uninstall at repository level; a commit-mode
 * switch is a reinstall with the other mode.
 */
const CLI_COMMANDS: Readonly<Record<CliManagedAction, string>> = {
  update: 'update',
  uninstall: 'uninstall',
  'move-to-user': 'uninstall',
  'switch-commit-mode': 'install'
};

/**
 * User-facing refusal message, naming the CLI command that changes the bundle.
 * @param bundleId - Refused bundle.
 * @param action - Refused action.
 * @param tool - Tool the bundle's entry belongs to.
 */
export const cliManagedMessage = (bundleId: string, action: CliManagedAction, tool: string): string =>
  `${bundleId} is installed for ${tool}; change it with the CLI: ai-primitives-hub ${CLI_COMMANDS[action]} ${bundleId} --target <a ${tool} target>`;

/**
 * Build the `RECORD.CLI_MANAGED` refusal.
 * @param bundleId - Refused bundle.
 * @param action - Refused action.
 * @param tool - Tool the bundle's entry belongs to.
 */
export const cliManagedError = (bundleId: string, action: CliManagedAction, tool: string): RegistryError =>
  recordError('RECORD.CLI_MANAGED', {
    message: cliManagedMessage(bundleId, action, tool),
    hint: '',
    context: { bundleId, action, tool }
  });

/**
 * Whether an error is the other-tool refusal.
 * @param error - Anything thrown.
 */
export const isCliManagedError = (error: unknown): error is RegistryError =>
  isRecordError(error, 'RECORD.CLI_MANAGED');

/** Errors already shown to the user once (e.g. by `ExtensionRecordAdapter.showRecordError`). */
const shownErrors = new WeakSet<object>();

/**
 * Remember that an error was already shown, so callers do not show it again.
 * @param error - The error shown.
 */
export const markErrorShown = (error: unknown): void => {
  if (typeof error === 'object' && error !== null) {
    shownErrors.add(error);
  }
};

/**
 * Whether an error was already shown to the user.
 * @param error - Anything thrown.
 */
export const wasErrorShown = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && shownErrors.has(error);

/**
 * Show the refusal as one warning notification, when `error` is one. An
 * error already shown elsewhere (a `RECORD.*` error with its "Open file"
 * notification) is handled too, without a second notification.
 * @param error - Anything thrown by a guarded action.
 * @returns `true` when the error was shown and the caller must stop without a success message.
 */
export const showCliManagedWarning = (error: unknown): boolean => {
  if (wasErrorShown(error)) {
    return true;
  }
  if (!isCliManagedError(error)) {
    return false;
  }
  void vscode.window.showWarningMessage(`${error.message} ${error.hint ?? ''}`.trim());
  return true;
};

/**
 * Show one warning listing the bundles a batch skipped because another tool's entry holds them.
 * @param bundleIds - Refused bundle ids; nothing is shown when empty.
 * @param action - The batch action.
 */
export const showCliManagedBatchWarning = (bundleIds: readonly string[], action: CliManagedAction): void => {
  if (bundleIds.length === 0) {
    return;
  }
  const verb = action === 'update' ? 'updated' : 'uninstalled';
  void vscode.window.showWarningMessage(
    `Skipped ${bundleIds.length} bundle(s) installed for another tool; they were not ${verb}: ${bundleIds.join(', ')}. Change them with the ai-primitives-hub CLI.`
  );
};
