/**
 * LocalModificationWarningService
 *
 * Detects local file modifications and warns users before updating bundles
 * that would override their changes (NFR4.13).
 *
 * The files and checksums come from the install record: the host tool's
 * entry when the bundle has one, else the bundle's old `prompt-registry`
 * lockfile entry. The comparison is app's `findModifiedFiles`.
 */

import * as path from 'node:path';
import {
  findModifiedFiles,
  type RecordedFileCheck,
} from '@ai-primitives-hub/app';
import * as vscode from 'vscode';
import {
  WARNING_RESULTS,
} from '../utils/constants';
import {
  Logger,
} from '../utils/logger';
import type {
  ExtensionRecordAdapter,
} from './extension-record-adapter';

/**
 * Result of the modification warning dialog
 */
export type ModificationWarningResult = typeof WARNING_RESULTS[keyof typeof WARNING_RESULTS];

/**
 * A locally modified installed file.
 */
export interface ModifiedFileInfo {
  /** Path relative to the record root (forward slashes). */
  path: string;
  /** `missing` when the file is gone, `modified` otherwise. */
  modificationType: 'modified' | 'missing';
}

/**
 * LocalModificationWarningService
 *
 * Provides functionality to detect local modifications to bundle files
 * and warn users before updates that would override their changes.
 */
export class LocalModificationWarningService {
  private readonly logger: Logger;

  /**
   * Create a warning service for one workspace folder.
   * @param adapter - The extension's record adapter.
   * @param workspaceFolder - Absolute workspace folder path.
   */
  constructor(private readonly adapter: ExtensionRecordAdapter, private readonly workspaceFolder: string) {
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

    for (const file of modifiedFiles) {
      const typeIndicator = file.modificationType === 'missing' ? ' (missing)' : '';
      message += `  • ${file.path}${typeIndicator}\n`;
    }

    message += '\nUpdating will override your local changes. What would you like to do?';

    return message;
  }

  /**
   * The recorded files of a bundle and the root they are relative to: the
   * host tool's record entry, else the old lockfile entry.
   * @param bundleId - Bundle id.
   */
  private async recordedFiles(bundleId: string): Promise<{ root: string; files: RecordedFileCheck[] } | undefined> {
    const host = await this.adapter.findHostEntry(this.workspaceFolder, bundleId);
    if (host !== undefined) {
      return { root: host.location.root, files: host.entry.files.map((file) => ({ path: file.path, checksum: file.checksum })) };
    }
    const old = await this.adapter.findOldEntry(this.workspaceFolder, bundleId);
    if (old === undefined) {
      return undefined;
    }
    return {
      root: this.workspaceFolder,
      files: old.entry.files.map((file) => ({ path: file.path.replaceAll('\\', '/'), checksum: file.checksum }))
    };
  }

  /**
   * Check for modifications to a bundle's files
   * @param bundleId - ID of the bundle to check
   * @returns Array of modified file information; empty when the bundle has no entry
   * @throws {RegistryError} Any `RECORD.*` error from loading the record.
   */
  public async checkForModifications(bundleId: string): Promise<ModifiedFileInfo[]> {
    try {
      const recorded = await this.recordedFiles(bundleId);
      if (recorded === undefined) {
        return [];
      }
      const modified = await findModifiedFiles(this.adapter.fs, recorded.root, recorded.files);
      const result: ModifiedFileInfo[] = [];
      for (const file of modified) {
        const exists = await this.adapter.fs.lstat(path.join(recorded.root, ...file.split('/'))).catch(() => undefined);
        result.push({ path: file, modificationType: exists === undefined ? 'missing' : 'modified' });
      }
      return result;
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
   */
  public async showWarningDialog(
    bundleId: string,
    modifiedFiles: ModifiedFileInfo[],
    bundleRepoUrl?: string
  ): Promise<ModificationWarningResult> {
    const message = this.buildWarningMessage(bundleId, modifiedFiles);

    const choice = await vscode.window.showWarningMessage(
      message,
      'Contribute Changes',
      'Override',
      'Cancel'
    );

    if (choice === 'Contribute Changes') {
      if (bundleRepoUrl) {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(bundleRepoUrl));
        } catch (error) {
          this.logger.warn(`Failed to open repository URL: ${bundleRepoUrl}`, error instanceof Error ? error : undefined);
        }
      }
      return 'contribute';
    } else if (choice === 'Override') {
      return 'override';
    }
    return 'cancel';
  }

  /**
   * Check for modifications and show warning dialog if needed.
   * Returns null if no modifications are detected (no dialog shown).
   * @param bundleId - ID of the bundle to check
   * @param bundleRepoUrl - Optional repository URL for contributing changes
   * @returns User's choice if modifications exist, null otherwise
   */
  public async checkAndWarn(
    bundleId: string,
    bundleRepoUrl?: string
  ): Promise<ModificationWarningResult | null> {
    const modifiedFiles = await this.checkForModifications(bundleId);
    if (modifiedFiles.length === 0) {
      return null;
    }
    return await this.showWarningDialog(bundleId, modifiedFiles, bundleRepoUrl);
  }
}
