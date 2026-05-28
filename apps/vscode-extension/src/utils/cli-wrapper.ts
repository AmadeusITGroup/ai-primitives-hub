/**
 * CliWrapper - Abstract base class for CLI command wrappers
 *
 * Provides common functionality for executing CLI commands with:
 * - Availability checking
 * - Version retrieval
 * - Working directory validation
 * - Progress notifications
 */

import {
  spawn,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  Logger,
} from './logger';

/**
 * Result of a CLI install operation
 */
export interface CliInstallResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Output from the command */
  output?: string;
}

/**
 * Command execution timeout in milliseconds (5 minutes)
 */
const COMMAND_TIMEOUT = 5 * 60 * 1000;

/**
 * Determine if shell mode is needed for commands.
 * On Windows, npm/other tools are .cmd/.ps1 files that require shell: true.
 */
const USE_SHELL = process.platform === 'win32';

/**
 * Abstract base class for CLI wrappers
 */
export abstract class CliWrapper {
  protected logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
  }

  /**
   * Get the CLI command name (e.g., 'npm', 'apm')
   */
  protected abstract getCommandName(): string;

  /**
   * Get the display name for UI messages
   */
  protected abstract getDisplayName(): string;

  /**
   * Validate working directory exists and is a directory
   * @param cwd
   */
  protected validateCwd(cwd: string): void {
    if (!cwd || cwd.trim() === '') {
      throw new Error('Working directory cannot be empty');
    }

    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    const stats = fs.statSync(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${cwd}`);
    }
  }

  /**
   * Format process error into user-friendly message
   * @param err
   * @param cmdName
   */
  protected formatProcessError(err: Error, cmdName: string): string {
    if (err.message.includes('ENOENT')) {
      return `${cmdName} not found. Please install it first.`;
    } else if (err.message.includes('EACCES') || err.message.includes('permission')) {
      return 'Permission denied. Please check directory permissions.';
    } else if (err.message.includes('network') || err.message.includes('ENOTFOUND')) {
      return 'Network error. Please check your internet connection.';
    }
    return `Failed to run ${cmdName} install: ${err.message}`;
  }

  /**
   * Check if the CLI tool is available in the system
   */
  public async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.getCommandName(), ['--version'], { shell: USE_SHELL });

      proc.on('close', (code) => {
        resolve(code === 0);
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Install dependencies with progress notification
   * @param cwd
   */
  public async installWithProgress(cwd: string): Promise<CliInstallResult> {
    const cmdName = this.getCommandName();
    const displayName = this.getDisplayName();

    try {
      this.validateCwd(cwd);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid working directory';
      this.logger.error(`${displayName}.installWithProgress validation failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }

    this.logger.debug(`Starting ${cmdName} install in: ${cwd}`);

    const available = await this.isAvailable();
    if (!available) {
      const error = `${cmdName} not found. Please install it first.`;
      this.logger.error(`${cmdName} not available on system`);
      return { success: false, error };
    }

    return new Promise((resolve) => {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Installing dependencies...',
          cancellable: true
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- async required by caller contract
        async (_progress, token) => {
          const proc = spawn(cmdName, ['install'], {
            cwd,
            shell: USE_SHELL,
            timeout: COMMAND_TIMEOUT
          });

          token.onCancellationRequested(() => {
            proc.kill();
            resolve({ success: false, error: 'Installation cancelled' });
          });

          let errorOutput = '';
          let output = '';

          proc.stdout.on('data', (data) => {
            output += data.toString();
          });

          proc.stderr.on('data', (data) => {
            errorOutput += data.toString();
          });

          proc.on('close', (code) => {
            if (code === 0) {
              this.logger.info(`${cmdName} install completed successfully in: ${cwd}`);
              vscode.window.showInformationMessage('Dependencies installed successfully!');
              resolve({ success: true, output });
            } else {
              const errorMessage = `${cmdName} install failed with code ${code}`;
              const detailedError = errorOutput ? `${errorMessage}. Error: ${errorOutput}` : errorMessage;
              this.logger.error(`${cmdName} install failed: ${detailedError}`);
              vscode.window.showErrorMessage(detailedError);
              resolve({ success: false, error: detailedError });
            }
          });

          proc.on('error', (err) => {
            const errorMessage = this.formatProcessError(err, cmdName);
            this.logger.error(`${cmdName} install process error: ${errorMessage}`);
            vscode.window.showErrorMessage(errorMessage);
            resolve({ success: false, error: errorMessage });
          });
        }
      );
    });
  }
}
