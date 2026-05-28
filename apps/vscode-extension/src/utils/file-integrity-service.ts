/**
 * File Integrity Service
 *
 * Provides shared utilities for file integrity operations including
 * checksum calculation and directory management.
 *
 * This service consolidates file integrity operations that were previously
 * duplicated across LockfileManager and BundleInstaller.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/**
 * Calculate SHA256 checksum for a file
 * @param filePath - Path to the file
 * @returns SHA256 checksum as hex string
 */
export async function calculateFileChecksum(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Ensure a directory exists, creating it if necessary
 * @param dir - Directory path to ensure exists
 */
export async function ensureDirectory(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

/**
 * Check if a directory exists
 * @param dir - Directory path to check
 * @returns true if directory exists
 */
export async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(dir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a file exists
 * @param filePath - File path to check
 * @returns true if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}
