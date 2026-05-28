/**
 * LocalModificationWarningService
 *
 * Detects local file modifications and warns users before updating bundles
 * that would override their changes.
 *
 * Requirements covered:
 * - 14.1-14.10: Local modification detection and warning dialog
 */

import * as vscode from 'vscode';
import {
  ModifiedFileInfo,
} from '../types/lockfile';
import {
  WARNING_RESULTS,
} from '../utils/constants';
import {
  Logger,
} from '../utils/logger';
import {
  LockfileManager,
} from './lockfile-manager';

/**
 * Result of the modification warning dialog
 */
export type ModificationWarningResult = typeof WARNING_RESULTS[keyof typeof WARNING_RESULTS];

/**
 * LocalModificationWarningService
 *
 * Provides functionality to detect local modifications to bundle files
 * and warn users before updates that would override their changes.
 */
export class LocalModificationWarningService {
  private readonly logger: Logger;

  constructor(private readonly lockfileManager: LockfileManager) {
    this.logger = Logger.getInstance();
  }

  /**
   * Build the warning message for the dialog
   * @param bundleId - ID of the bundle
   * @param modifiedFiles - Array of modified file information
   * @returns Formatted warning message
   */
  private buildWarningMessage(bundleId: string, modifiedFiles: ModifiedFileInfo[]): string {
    const fileCount = modifiedFiles.length;
    const fileWord = fileCount === 1 ? 'file has' : 'files have';

    let message = `The bundle "${bundleId}" has ${fileCount} ${fileWord} been modified locally:\n\n`;

    // List modified files with their modification type
    for (const file of modifiedFiles) {
      const typeIndicator = file.modificationType === 'missing' ? ' (missing)' : '';
      message += `  • ${file.path}${typeIndicator}\n`;
    }

    message += '\nUpdating will override your local changes. What would you like to do?';

    return message;
  }

  /**
   * Check for modifications to a bundle's files
   * @param bundleId - ID of the bundle to check
   * @returns Array of modified file information
   *
   * Requirements: 14.1-14.3
   */
  public async checkForModifications(bundleId: string): Promise<ModifiedFileInfo[]> {
    try {
      return await this.lockfileManager.detectModifiedFiles(bundleId);
    } catch (error) {
      this.logger.error(`Failed to check modifications for bundle ${bundleId}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Show warning dialog for modified files
   *
   * Displays a dialog with the list of modified files and three action buttons:
   * - "Contribute Changes": Opens the bundle's repository URL (if provided)
   * - "Override": Proceeds with the update, overriding local changes
   * - "Cancel": Aborts the update
   * @param bundleId - ID of the bundle being updated
   * @param modifiedFiles - Array of modified file information
   * @param bundleRepoUrl - Optional repository URL for contributing changes
   * @returns User's choice: 'contribute', 'override', or 'cancel'
   *
   * Requirements: 14.4-14.10
   */
  public async showWarningDialog(
    bundleId: string,
    modifiedFiles: ModifiedFileInfo[],
    bundleRepoUrl?: string
  ): Promise<ModificationWarningResult> {
    // Build the warning message
    const message = this.buildWarningMessage(bundleId, modifiedFiles);

    // Show dialog with three action buttons
    const choice = await vscode.window.showWarningMessage(
      message,
      'Contribute Changes',
      'Override',
      'Cancel'
    );

    // Handle user choice
    if (choice === 'Contribute Changes') {
      // Open repository URL if provided
      if (bundleRepoUrl) {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(bundleRepoUrl));
        } catch (error) {
          this.logger.warn(`Failed to open repository URL: ${bundleRepoUrl}`, error instanceof Error ? error : undefined);
          // Continue even if URL fails to open
        }
      }
      return 'contribute';
    } else if (choice === 'Override') {
      return 'override';
    } else {
      // Cancel or dismissed
      return 'cancel';
    }
  }

  /**
   * Check for modifications and show warning dialog if needed
   *
   * Combines checkForModifications and showWarningDialog into a single call.
   * Returns null if no modifications are detected (no dialog shown).
   * @param bundleId - ID of the bundle to check
   * @param bundleRepoUrl - Optional repository URL for contributing changes
   * @returns User's choice if modifications exist, null otherwise
   *
   * Requirements: 14.1-14.10
   */
  public async checkAndWarn(
    bundleId: string,
    bundleRepoUrl?: string
  ): Promise<ModificationWarningResult | null> {
    // Check for modifications
    const modifiedFiles = await this.checkForModifications(bundleId);

    // If no modifications, return null (no dialog needed)
    if (modifiedFiles.length === 0) {
      return null;
    }

    // Show warning dialog and return result
    return await this.showWarningDialog(bundleId, modifiedFiles, bundleRepoUrl);
  }
}
