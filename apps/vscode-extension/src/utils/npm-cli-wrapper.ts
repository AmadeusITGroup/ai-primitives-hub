/**
 * NpmCliWrapper
 *
 * Wrapper for npm CLI commands with security-focused input validation.
 * Extends CliWrapper base class for common CLI functionality.
 */

import {
  CliInstallResult,
  CliWrapper,
} from './cli-wrapper';

// Re-export for backward compatibility
export type NpmInstallResult = CliInstallResult;

/**
 * NpmCliWrapper - Safe wrapper for npm CLI commands
 */
export class NpmCliWrapper extends CliWrapper {
  private static instance: NpmCliWrapper;

  private constructor() {
    super();
  }

  public static getInstance(): NpmCliWrapper {
    if (!NpmCliWrapper.instance) {
      NpmCliWrapper.instance = new NpmCliWrapper();
    }
    return NpmCliWrapper.instance;
  }

  protected getCommandName(): string {
    return 'npm';
  }

  protected getDisplayName(): string {
    return 'NpmCliWrapper';
  }
}
