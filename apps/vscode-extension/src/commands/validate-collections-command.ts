import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  listCollectionFiles,
  validateAllCollections,
} from '@ai-primitives-hub/app';
import type {
  AllCollectionsResult,
  Collection,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

/**
 * Command to validate collection files in the workspace.
 *
 * Delivery adapter over `@ai-primitives-hub/app`: it runs the same
 * `listCollectionFiles` + `validateAllCollections` as
 * `ai-primitives-hub collection validate`, so both report the same errors
 * and warnings, and renders the result in an output channel and
 * notifications.
 *
 * Attribution: Validation logic inspired by github/awesome-copilot
 * https://github.com/github/awesome-copilot
 */
export class ValidateCollectionsCommand {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly logger: Logger;

  constructor(_context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Collection Validator');
    this.logger = Logger.getInstance();
  }

  private log(message: string, type?: 'error' | 'warning' | 'success'): void {
    let prefix = '';
    switch (type) {
      case 'error': {
        prefix = '❌ ';
        break;
      }
      case 'warning': {
        prefix = '⚠️  ';
        break;
      }
      case 'success': {
        prefix = '✅ ';
        break;
      }
    }
    this.outputChannel.appendLine(prefix + message);
  }

  private logErrors(errors: string[]): void {
    for (const err of errors) {
      this.log(`  ❌ Error: ${err}`, 'error');
    }
  }

  private logWarnings(warnings: string[]): void {
    for (const warn of warnings) {
      this.log(`  ⚠️  Warning: ${warn}`, 'warning');
    }
  }

  private logCollection(collection: Collection): void {
    this.log(`📦 ${collection.name} (id: ${collection.id})`);
    this.log(`   Description: ${collection.description}`);
    this.log(`   Items: ${Array.isArray(collection.items) ? collection.items.length : 0}`);
    if (Array.isArray(collection.tags) && collection.tags.length > 0) {
      this.log(`   Tags: ${collection.tags.join(', ')}`);
    }
    this.log('');
  }

  /**
   * Render a validation result: one block per file, then the errors that
   * belong to no single file (duplicate ids/names), then the summary.
   * @param result - Result of `validateAllCollections`
   * @param listOnly - List collections instead of reporting findings
   */
  private report(result: AllCollectionsResult, listOnly: boolean): void {
    let validCollections = 0;

    for (const fileResult of result.fileResults) {
      if (listOnly) {
        if (typeof fileResult.collection === 'object' && fileResult.collection !== null) {
          this.logCollection(fileResult.collection);
        }
        continue;
      }

      const warnings = fileResult.warnings ?? [];
      this.log(`Validating: ${path.basename(fileResult.file)}`);
      if (fileResult.errors.length === 0 && warnings.length === 0) {
        this.log('  ✅ Valid', 'success');
      } else {
        this.logErrors(fileResult.errors);
        this.logWarnings(warnings);
      }
      if (fileResult.errors.length === 0) {
        validCollections++;
      }
      this.log('');
    }

    if (listOnly) {
      return;
    }

    const fileErrors = new Set(result.fileResults.flatMap((fileResult) => fileResult.errors));
    const crossCollectionErrors = result.errors.filter((err) => !fileErrors.has(err));
    if (crossCollectionErrors.length > 0) {
      this.log('Cross-collection errors:');
      this.logErrors(crossCollectionErrors);
      this.log('');
    }

    const totalErrors = result.errors.length;
    const totalWarnings = result.warnings.length;
    this.log('─'.repeat(50));
    this.log(`\n📊 Summary:`);
    this.log(`   Total collections: ${result.fileResults.length}`);
    this.log(`   Valid: ${validCollections}`);
    this.log(`   Errors: ${totalErrors}`);
    this.log(`   Warnings: ${totalWarnings}\n`);

    if (totalErrors === 0 && totalWarnings === 0) {
      this.log('🎉 All collections are valid!', 'success');
      vscode.window.showInformationMessage(`All ${result.fileResults.length} collection(s) validated successfully!`);
    } else if (totalErrors === 0) {
      vscode.window.showWarningMessage(`Validation complete with ${totalWarnings} warning(s)`);
    } else {
      vscode.window.showErrorMessage(`Validation failed with ${totalErrors} error(s)`);
    }
  }

  private run(listOnly: boolean): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const collectionsDir = path.join(workspaceRoot, 'collections');

    if (!fs.existsSync(collectionsDir)) {
      vscode.window.showErrorMessage(`Collections directory not found: ${collectionsDir}`);
      return;
    }

    this.outputChannel.clear();
    this.outputChannel.show();

    this.log('📋 Collection Validation Tool\n');
    this.log('Attribution: Inspired by github/awesome-copilot');
    this.log('https://github.com/github/awesome-copilot\n');

    try {
      const files = listCollectionFiles(workspaceRoot);

      if (files.length === 0) {
        this.log('⚠️  No collection files found in ' + collectionsDir, 'warning');
        vscode.window.showWarningMessage('No collection files found');
        return;
      }

      this.log(`Found ${files.length} collection(s)\n`);
      this.report(validateAllCollections(workspaceRoot, files), listOnly);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Collection validation failed in ${collectionsDir}`, error instanceof Error ? error : undefined);
      this.log(`Collection validation failed: ${message}`, 'error');
      vscode.window.showErrorMessage(
        `Collection validation failed: ${message}. Check that ${collectionsDir} and the files it references are readable.`
      );
    }
  }

  /**
   * Validate (or, with `listOnly`, list) the collections of the first
   * workspace folder. Validation itself is synchronous; the promise keeps
   * the command handler contract.
   * @param options - Command options
   * @param options.listOnly - List collections instead of validating them
   * @returns Resolves once the output and notifications are shown
   */
  public execute(options?: { listOnly?: boolean }): Promise<void> {
    this.run(options?.listOnly === true);
    return Promise.resolve();
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }
}
