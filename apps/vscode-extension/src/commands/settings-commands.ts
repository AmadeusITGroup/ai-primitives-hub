/**
 * Settings Commands
 * Commands for exporting and importing complete registry settings
 */

import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  ExportFormat,
  ImportStrategy,
} from '../types/settings';
import {
  Logger,
} from '../utils/logger';

export class SettingsCommands {
  private readonly logger = Logger.getInstance();

  constructor(private readonly registryManager: RegistryManager) {}

  /**
   * Export complete registry settings (sources + profiles + configuration)
   */
  public async exportSettings(): Promise<void> {
    try {
      // Step 1: Choose format
      const formatChoice = await vscode.window.showQuickPick<vscode.QuickPickItem & { value: ExportFormat }>(
        [
          {
            label: 'JSON',
            description: 'JavaScript Object Notation (widely supported)',
            value: 'json'
          },
          {
            label: 'YAML',
            description: 'YAML Ain\'t Markup Language (human-readable)',
            value: 'yaml'
          }
        ],
        {
          placeHolder: 'Select export format',
          title: 'Export Registry Settings',
          ignoreFocusOut: true
        }
      );

      if (!formatChoice) {
        return;
      }

      // Step 2: Export settings
      this.logger.info(`Exporting settings to ${formatChoice.label}...`);
      const data = await this.registryManager.exportSettings(formatChoice.value);

      // Step 3: Save to file
      const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const defaultFilename = `prompt-registry-settings-${timestamp}.${formatChoice.value}`;

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultFilename),
        filters: {
          [formatChoice.label]: [formatChoice.value]
        },
        title: 'Save Registry Settings'
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf8'));
        this.logger.info(`Settings exported to ${uri.fsPath}`);

        const result = await vscode.window.showInformationMessage(
          `Settings exported successfully to ${uri.fsPath}`,
          'Open File'
        );

        if (result === 'Open File') {
          await vscode.commands.executeCommand('vscode.open', uri);
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to export settings: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to export settings: ${error.message}`);
    }
  }

  /**
   * Import registry settings (sources + profiles + configuration)
   */
  public async importSettings(): Promise<void> {
    try {
      // Step 1: Choose file
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: {
          Settings: ['json', 'yaml', 'yml']
        },
        title: 'Import Registry Settings'
      });

      if (!uris || uris.length === 0) {
        return;
      }

      const fileUri = uris[0];

      // Step 2: Read file
      const content = await vscode.workspace.fs.readFile(fileUri);
      const data = Buffer.from(content).toString('utf8');

      // Step 3: Detect format
      const format: ExportFormat = fileUri.fsPath.endsWith('.json') ? 'json' : 'yaml';
      this.logger.info(`Importing settings from ${format.toUpperCase()} file: ${fileUri.fsPath}`);

      // Step 4: Choose strategy
      const strategyChoice = await vscode.window.showQuickPick<vscode.QuickPickItem & { value: ImportStrategy }>(
        [
          {
            label: 'Merge',
            description: 'Add imported items to existing settings (recommended)',
            detail: 'Existing sources and profiles will be preserved',
            value: 'merge'
          },
          {
            label: 'Replace',
            description: 'Delete all current settings and import new ones',
            detail: '⚠️  Warning: All current sources, profiles, and settings will be lost',
            value: 'replace'
          }
        ],
        {
          placeHolder: 'Choose import strategy',
          title: 'Import Strategy',
          ignoreFocusOut: true
        }
      );

      if (!strategyChoice) {
        return;
      }

      // Step 5: Confirm if replacing
      if (strategyChoice.value === 'replace') {
        const confirm = await vscode.window.showWarningMessage(
          'This will delete all current profiles, sources, and settings. This action cannot be undone. Are you sure you want to continue?',
          { modal: true },
          'Yes, Replace All',
          'Cancel'
        );

        if (confirm !== 'Yes, Replace All') {
          this.logger.info('Import cancelled by user');
          return;
        }
      }

      // Step 6: Import with progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Importing registry settings...',
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Validating settings file...' });

          await this.registryManager.importSettings(
            data,
            format,
            strategyChoice.value
          );

          progress.report({ message: 'Import complete!' });
        }
      );

      this.logger.info('Settings imported successfully');
      vscode.window.showInformationMessage(
        `Settings imported successfully using ${strategyChoice.label.toLowerCase()} strategy`
      );
    } catch (error: any) {
      this.logger.error(`Failed to import settings: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to import settings: ${error.message}`);
    }
  }
}
