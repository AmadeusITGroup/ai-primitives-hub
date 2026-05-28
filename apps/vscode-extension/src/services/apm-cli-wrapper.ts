/**
 * ApmCliWrapper
 *
 * Wrapper for APM CLI commands with security-focused input validation.
 * Provides a safe interface for executing APM operations.
 *
 * Security considerations:
 * - All inputs are validated before use in commands
 * - Package references are sanitized to prevent injection
 * - File paths are validated and normalized
 * - Command execution uses safe patterns
 */

import {
  exec,
} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  Logger,
} from '../utils/logger';
import {
  ApmRuntimeManager,
} from './apm-runtime-manager';

const execAsync = promisify(exec);

/**
 * Result of an APM install operation
 */
export interface ApmInstallResult {
  /** Whether the installation succeeded */
  success: boolean;
  /** Path where package was installed */
  installedPath?: string;
  /** Error message if installation failed */
  error?: string;
}

/**
 * Command execution timeout in milliseconds (5 minutes)
 */
const COMMAND_TIMEOUT = 5 * 60 * 1000;

/**
 * Valid package reference pattern
 * Security: Only allow alphanumeric, hyphens, underscores, dots, and forward slashes
 */
const VALID_PACKAGE_REF_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+$/;

/**
 * Dangerous patterns to reject
 */
const DANGEROUS_PATTERNS = [
  /[;&|`$(){}[\]<>]/, // Shell metacharacters
  /\n|\r/, // Newlines
  /^https?:/, // URLs
  /^\//, // Absolute paths (Unix)
  /^[A-Za-z]:/, // Absolute paths (Windows)
  /\.\./ // Path traversal
];

/**
 * ApmCliWrapper - Safe wrapper for APM CLI commands
 */
export class ApmCliWrapper {
  private readonly logger: Logger;
  private readonly runtime: ApmRuntimeManager;

  constructor() {
    this.logger = Logger.getInstance();
    this.runtime = ApmRuntimeManager.getInstance();
  }

  /**
   * Validate a target directory path
   * Security: Prevents path traversal and injection
   * @param targetPath
   */
  private validateTargetPath(targetPath: string): boolean {
    if (!targetPath || targetPath.trim().length === 0) {
      return false;
    }

    // Check for path traversal
    if (targetPath.includes('..')) {
      return false;
    }

    // Normalize and check it's an absolute path
    const normalized = path.normalize(targetPath);
    if (!path.isAbsolute(normalized)) {
      return false;
    }

    return true;
  }

  /**
   * Execute an APM command
   * Security: Uses safe argument passing
   * @param args
   * @param cwd
   * @param token
   */
  private async executeCommand(args: string[], cwd: string, token?: string): Promise<{ stdout: string; stderr: string }> {
    // Validate args don't contain dangerous characters
    for (const arg of args) {
      if (DANGEROUS_PATTERNS.some((p) => p.test(arg))) {
        throw new Error(`Invalid command argument: ${arg}`);
      }
    }

    // Determine command to run (apm, uvx apm, or local uv tool run apm)
    const status = await this.runtime.getStatus();
    let command = 'apm';

    if (status.localUvPath) {
      // Use local uv
      command = `"${status.localUvPath}" tool run apm`;
    } else if (!status.installed && status.uvxAvailable) {
      command = 'uvx apm';
    } else if (!status.installed) {
      // Fallback to trying 'apm' which will likely fail
    }

    const fullCommand = `${command} ${args.join(' ')}`;
    this.logger.debug(`[ApmCli] Executing: ${fullCommand} in ${cwd}`);

    return execAsync(fullCommand, {
      cwd,
      timeout: COMMAND_TIMEOUT,
      env: this.getSafeEnvironment(token)
    });
  }

  /**
   * Get safe environment for command execution
   * @param explicitToken
   */
  private getSafeEnvironment(explicitToken?: string): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Pass GitHub token if available
    // Priority: explicit token > env.GITHUB_TOKEN > env.GH_TOKEN
    const token = explicitToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
      env.GITHUB_TOKEN = token;
    }

    // Remove potentially dangerous variables
    delete env.LD_PRELOAD;
    delete env.DYLD_INSERT_LIBRARIES;

    return env;
  }

  /**
   * Check if APM runtime is available
   */
  public async isRuntimeAvailable(): Promise<boolean> {
    try {
      const status = await this.runtime.getStatus();
      return status.installed || !!status.uvxAvailable;
    } catch {
      return false;
    }
  }

  /**
   * Validate a package reference
   * Security: Prevents command injection through malicious package names
   * @param ref Package reference (e.g., "owner/repo" or "owner/repo/path")
   */
  public validatePackageRef(ref: string): boolean {
    // Empty check
    if (!ref || ref.trim().length === 0) {
      return false;
    }

    // Check for dangerous patterns
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(ref)) {
        return false;
      }
    }

    // Must match valid pattern
    if (!VALID_PACKAGE_REF_PATTERN.test(ref)) {
      return false;
    }

    // Must not end with slash
    if (ref.endsWith('/')) {
      return false;
    }

    // Must have at least one slash but not start with one
    if (!ref.includes('/') || ref.startsWith('/')) {
      return false;
    }

    return true;
  }

  /**
   * Install an APM package
   * @param packageRef Package reference (e.g., "owner/repo")
   * @param targetDir Directory where to install
   * @param token Optional GitHub token for authentication
   */
  public async install(packageRef: string, targetDir: string, token?: string): Promise<ApmInstallResult> {
    // Validate inputs
    if (!this.validatePackageRef(packageRef)) {
      return {
        success: false,
        error: `Invalid package reference: ${packageRef}. Use format: owner/repo`
      };
    }

    if (!this.validateTargetPath(targetDir)) {
      return {
        success: false,
        error: `Invalid target directory path: ${targetDir}`
      };
    }

    // Check runtime availability
    try {
      const available = await this.isRuntimeAvailable();
      if (!available) {
        return {
          success: false,
          error: 'APM CLI is not installed. Install with: pip install apm-cli'
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to check APM runtime: ${(error as Error).message}`
      };
    }

    // Create temporary apm.yml if needed
    const apmYmlPath = path.join(targetDir, 'apm.yml');

    try {
      // Ensure target directory exists
      await fs.promises.mkdir(targetDir, { recursive: true });

      // Create minimal apm.yml
      if (!fs.existsSync(apmYmlPath)) {
        const manifest = `name: temp-install
version: 1.0.0
dependencies:
  apm:
    - ${packageRef}
`;
        await fs.promises.writeFile(apmYmlPath, manifest, 'utf8');
      }

      // Execute APM install
      this.logger.debug(`[ApmCli] Installing: ${packageRef} to ${targetDir}`);

      await this.executeCommand(['install'], targetDir, token);

      const installedPath = path.join(targetDir, 'apm_modules');

      return {
        success: true,
        installedPath
      };
    } catch (error) {
      this.logger.error(`[ApmCli] Install failed: ${packageRef}`, error as Error);
      return {
        success: false,
        error: `Failed to install package: ${(error as Error).message}`
      };
    }
  }
}
