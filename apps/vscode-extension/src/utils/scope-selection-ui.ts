/**
 * Scope Selection UI Utility
 *
 * Provides a unified scope selection dialog for bundle installation.
 * Implements Requirements 2.1-2.6, 1.8 for repository-level installation.
 */

import * as vscode from 'vscode';
import {
  InstallationScope,
  RepositoryCommitMode,
} from '../types/registry';

/**
 * Result of scope selection dialog
 */
export interface ScopeSelectionResult {
  scope: InstallationScope;
  commitMode?: RepositoryCommitMode;
}

/**
 * Internal option structure for QuickPick items
 */
interface ScopeSelectionOption {
  label: string;
  description: string;
  detail?: string;
  scope: InstallationScope;
  commitMode?: RepositoryCommitMode;
  disabled: boolean;
}

/**
 * Extended QuickPickItem with internal metadata for scope selection
 */
export interface ScopeQuickPickItem extends vscode.QuickPickItem {
  _scope: InstallationScope;
  _commitMode?: RepositoryCommitMode;
  _disabled: boolean;
  _originalDetail?: string;
}

/**
 * Warning message shown when a disabled option is selected
 */
const DISABLED_OPTION_WARNING = '⚠️ Requires an open workspace - please select another option';

/**
 * Creates the QuickPick items for scope selection
 * @param hasWorkspace
 */
export function createScopeQuickPickItems(hasWorkspace: boolean): ScopeQuickPickItem[] {
  const options: ScopeSelectionOption[] = [
    {
      label: '$(repo) Repository - Commit to Git (Recommended)',
      description: 'Install in .github/, tracked in version control',
      detail: hasWorkspace ? undefined : '(Requires an open workspace)',
      scope: 'repository',
      commitMode: 'commit',
      disabled: !hasWorkspace
    },
    {
      label: '$(eye-closed) Repository - Local Only',
      description: 'Install in .github/, excluded via .git/info/exclude',
      detail: hasWorkspace ? undefined : '(Requires an open workspace)',
      scope: 'repository',
      commitMode: 'local-only',
      disabled: !hasWorkspace
    },
    {
      label: '$(account) User Profile',
      description: 'Install in user config, available everywhere',
      scope: 'user',
      disabled: false
    }
  ];

  return options.map((opt) => ({
    label: opt.label,
    description: opt.description,
    detail: opt.detail,
    picked: opt.scope === 'repository' && opt.commitMode === 'commit' && hasWorkspace,
    _scope: opt.scope,
    _commitMode: opt.commitMode,
    _disabled: opt.disabled,
    _originalDetail: opt.detail
  }));
}

/**
 * Shows the scope selection dialog for bundle installation.
 *
 * Presents three options:
 * 1. Repository - Commit to Git (Recommended) - tracked in version control
 * 2. Repository - Local Only - excluded via .git/info/exclude
 * 3. User Profile - available everywhere
 *
 * Repository options are disabled when no workspace is open.
 * When a disabled option is clicked, the dialog remains open and shows an inline warning.
 * @param bundleName - Optional bundle name to display in the dialog title
 * @returns The selected scope and commit mode, or undefined if cancelled
 * @example
 * ```typescript
 * const result = await showScopeSelectionDialog('my-bundle');
 * if (result) {
 *     console.log(`Installing to ${result.scope} scope`);
 *     if (result.commitMode) {
 *         console.log(`Commit mode: ${result.commitMode}`);
 *     }
 * }
 * ```
 */
export async function showScopeSelectionDialog(bundleName?: string): Promise<ScopeSelectionResult | undefined> {
  const hasWorkspace = hasOpenWorkspace();
  const quickPickItems = createScopeQuickPickItems(hasWorkspace);

  const title = bundleName
    ? `Install ${bundleName} - Select Scope`
    : 'Select Installation Scope';

  // Use custom QuickPick to handle disabled option selection
  return new Promise<ScopeSelectionResult | undefined>((resolve) => {
    const quickPick = vscode.window.createQuickPick<ScopeQuickPickItem>();
    quickPick.items = quickPickItems;
    quickPick.title = title;
    quickPick.placeholder = 'Choose where to install the bundle';
    quickPick.ignoreFocusOut = true;

    // Handle selection changes - prevent disabled options from being accepted
    quickPick.onDidChangeSelection((selection) => {
      if (selection.length === 0) {
        return;
      }

      const selected = selection[0];

      if (selected._disabled) {
        // Disabled option selected - show inline warning and clear selection
        // Update the detail of the selected item to show warning
        const updatedItems = quickPick.items.map((item) => {
          if (item === selected) {
            return {
              ...item,
              detail: DISABLED_OPTION_WARNING
            };
          }
          // Reset other items to their original detail
          return {
            ...item,
            detail: item._originalDetail
          };
        });

        quickPick.items = updatedItems;

        // Clear the selection to keep dialog open
        quickPick.selectedItems = [];
      }
    });

    // Handle acceptance (Enter key or double-click)
    quickPick.onDidAccept(() => {
      const selection = quickPick.selectedItems;

      if (selection.length === 0) {
        // No selection - do nothing, keep dialog open
        return;
      }

      const selected = selection[0];

      if (selected._disabled) {
        // Disabled option - show warning and keep dialog open
        const updatedItems = quickPick.items.map((item) => {
          if (item === selected) {
            return {
              ...item,
              detail: DISABLED_OPTION_WARNING
            };
          }
          return {
            ...item,
            detail: item._originalDetail
          };
        });

        quickPick.items = updatedItems;
        quickPick.selectedItems = [];
        return;
      }

      // Valid selection - close dialog and return result
      quickPick.hide();
      resolve({
        scope: selected._scope,
        commitMode: selected._commitMode
      });
    });

    // Handle dialog dismissal (Escape or click outside)
    quickPick.onDidHide(() => {
      quickPick.dispose();
      // Only resolve undefined if we haven't already resolved with a result
      resolve(undefined);
    });

    quickPick.show();
  });
}

/**
 * Checks if a workspace is currently open.
 * @returns true if at least one workspace folder is open
 */
export function hasOpenWorkspace(): boolean {
  return !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
}

/**
 * Gets the root path of the first workspace folder.
 * @returns The workspace root path, or undefined if no workspace is open
 */
export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return undefined;
}
