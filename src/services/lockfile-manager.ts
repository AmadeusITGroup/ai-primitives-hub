/**
 * LockfileManager Service
 *
 * Manages the prompt-registry.lock.json file for repository-level bundle installations.
 * Provides atomic write operations, schema validation, and modification detection.
 *
 * Requirements covered:
 * - 4.1-4.10: Lockfile creation and management
 * - 5.1-5.7: Lockfile detection and auto-sync
 * - 12.1-12.6: Source and hub tracking
 * - 14.1-14.3: Checksum modification detection
 * - 15.1-15.6: Enhanced lockfile structure and atomic writes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  Lockfile,
  LockfileBundleEntry,
  LockfileFileEntry,
  LockfileHubEntry,
  LockfileProfileEntry,
  LockfileSourceEntry,
  LockfileValidationResult,
  ModifiedFileInfo,
} from '../types/lockfile';
import {
  DeploymentManifest,
  InstalledBundle,
  RepositoryCommitMode,
} from '../types/registry';
import {
  calculateFileChecksum,
} from '../utils/file-integrity-service';
import {
  Logger,
} from '../utils/logger';
import {
  SchemaValidator,
} from './schema-validator';

const LOCKFILE_NAME = 'prompt-registry.lock.json';
const LOCAL_LOCKFILE_NAME = 'prompt-registry.local.lock.json';
const LOCKFILE_SCHEMA_VERSION = '2.0.0';
const LOCKFILE_SCHEMA_URL = 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json';
const EXTENSION_ID = 'AmadeusITGroup.prompt-registry';

/**
 * Options for creating or updating a bundle in the lockfile
 */
export interface CreateOrUpdateOptions {
  bundleId: string;
  version: string;
  sourceId: string;
  sourceType: string;
  commitMode: RepositoryCommitMode;
  files: LockfileFileEntry[];
  source: LockfileSourceEntry;
  hub?: { id: string; entry: LockfileHubEntry };
  profile?: { id: string; entry: LockfileProfileEntry };
  checksum?: string;
}

/**
 * LockfileManager service
 *
 * Manages the prompt-registry.lock.json file at the repository root.
 * Uses a workspace-aware instance pattern to support multi-root workspaces.
 *
 * Note: This class uses a per-workspace instance pattern instead of a global singleton
 * to properly handle workspace switches and multi-root workspaces.
 */
export class LockfileManager {
  private static readonly instances: Map<string, LockfileManager> = new Map();

  /**
   * Get or create a LockfileManager instance for a repository path.
   * Supports multi-root workspaces by maintaining separate instances per repository.
   * @param repositoryPath - Path to the repository root (required)
   * @returns LockfileManager instance for the repository
   * @throws {Error} if repositoryPath is not provided
   */
  public static getInstance(repositoryPath?: string): LockfileManager {
    if (!repositoryPath) {
      throw new Error('Repository path required for LockfileManager.getInstance()');
    }

    // Normalize path for consistent key lookup
    const normalizedPath = path.normalize(repositoryPath);

    if (!LockfileManager.instances.has(normalizedPath)) {
      LockfileManager.instances.set(normalizedPath, new LockfileManager(normalizedPath));
    }
    return LockfileManager.instances.get(normalizedPath)!;
  }

  /**
   * Reset a specific instance (for testing purposes)
   * @param repositoryPath - Path to the repository to reset
   */
  public static resetInstance(repositoryPath?: string): void {
    if (repositoryPath) {
      const normalizedPath = path.normalize(repositoryPath);
      const instance = LockfileManager.instances.get(normalizedPath);
      if (instance) {
        instance.dispose();
        LockfileManager.instances.delete(normalizedPath);
      }
    } else {
      // Reset all instances
      for (const instance of LockfileManager.instances.values()) {
        instance.dispose();
      }
      LockfileManager.instances.clear();
    }
  }

  private readonly repositoryPath: string;
  private readonly lockfilePath: string;
  private readonly logger: Logger;
  private readonly schemaValidator: SchemaValidator;
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private writeLock: Promise<void> = Promise.resolve();

  // Event emitter for lockfile updates
  private readonly _onLockfileUpdated = new vscode.EventEmitter<Lockfile | null>();
  public readonly onLockfileUpdated = this._onLockfileUpdated.event;

  /**
   * Create a new LockfileManager for a specific repository
   * Use getInstance() to get or create instances.
   * @param repositoryPath
   */
  constructor(repositoryPath: string) {
    this.repositoryPath = repositoryPath;
    this.lockfilePath = path.join(repositoryPath, LOCKFILE_NAME);
    this.logger = Logger.getInstance();
    this.schemaValidator = new SchemaValidator();
    this.setupFileWatcher();
  }

  /**
   * Set up file watcher for external lockfile changes
   */
  private setupFileWatcher(): void {
    try {
      const pattern = new vscode.RelativePattern(this.repositoryPath, LOCKFILE_NAME);
      this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

      this.fileWatcher.onDidChange(() => {
        this.logger.debug('Lockfile changed externally');
        void this.emitLockfileUpdated();
      });

      this.fileWatcher.onDidCreate(() => {
        this.logger.debug('Lockfile created externally');
        void this.emitLockfileUpdated();
      });

      this.fileWatcher.onDidDelete(() => {
        this.logger.debug('Lockfile deleted externally');
        this._onLockfileUpdated.fire(null);
      });
    } catch (error) {
      this.logger.warn('Failed to set up lockfile watcher:', error instanceof Error ? error : undefined);
    }
  }

  private async emitLockfileUpdated(): Promise<void> {
    const lockfile = await this.read();
    this._onLockfileUpdated.fire(lockfile);
  }

  /**
   * Get the path to the appropriate lockfile based on commit mode.
   * Routes to the main lockfile for 'commit' mode and local lockfile for 'local-only' mode.
   * @param commitMode - The commit mode to determine which lockfile to use
   * @returns Path to the appropriate lockfile
   *
   * Requirements covered:
   * - 1.1: Route local-only bundles to prompt-registry.local.lock.json
   * - 1.2: Route commit bundles to prompt-registry.lock.json
   */
  private getLockfilePathForMode(commitMode: RepositoryCommitMode): string {
    const filename = commitMode === 'local-only'
      ? LOCAL_LOCKFILE_NAME
      : LOCKFILE_NAME;
    return path.join(this.repositoryPath, filename);
  }

  /**
   * Read a specific lockfile based on commit mode.
   * Routes to the main lockfile for 'commit' mode and local lockfile for 'local-only' mode.
   * @param commitMode - The commit mode to determine which lockfile to read
   * @returns The lockfile object or null if it doesn't exist
   *
   * Requirements covered:
   * - 3.1: Read from both Main_Lockfile and Local_Lockfile
   */
  private async readLockfileByMode(commitMode: RepositoryCommitMode): Promise<Lockfile | null> {
    const lockfilePath = this.getLockfilePathForMode(commitMode);
    try {
      if (!fs.existsSync(lockfilePath)) {
        return null;
      }
      const content = await fs.promises.readFile(lockfilePath, 'utf8');
      return JSON.parse(content) as Lockfile;
    } catch (error) {
      this.logger.error(`Failed to read ${commitMode} lockfile:`, error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Get the path to a schema file.
   * Resolves from extension installation directory, with fallback to process.cwd() for development.
   * @param schemaFileName - Name of the schema file (e.g., 'lockfile.schema.json')
   * @returns Full path to the schema file
   */
  private getSchemaPath(schemaFileName: string): string {
    // Try to get extension path first (works when extension is installed)
    try {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      if (extension) {
        const extensionPath = extension.extensionPath;
        const schemaPath = path.join(extensionPath, 'schemas', schemaFileName);
        if (fs.existsSync(schemaPath)) {
          this.logger.debug(`Using schema from extension path: ${schemaPath}`);
          return schemaPath;
        }
      }
    } catch {
      this.logger.debug('Could not get extension path, falling back to cwd');
    }

    // Fallback to process.cwd() for development mode
    const fallbackPath = path.join(process.cwd(), 'schemas', schemaFileName);
    this.logger.debug(`Using schema from fallback path: ${fallbackPath}`);
    return fallbackPath;
  }

  /**
   * Remove a bundle from a specific lockfile by commit mode.
   * Handles cleanup of orphaned sources and deletion of empty lockfiles.
   * @param bundleId - ID of the bundle to remove
   * @param lockfile - The lockfile object containing the bundle
   * @param commitMode - The commit mode indicating which lockfile to update
   */
  private async removeFromLockfileByMode(
    bundleId: string,
    lockfile: Lockfile,
    commitMode: RepositoryCommitMode
  ): Promise<void> {
    const lockfilePath = this.getLockfilePathForMode(commitMode);
    const isLocalLockfile = commitMode === 'local-only';

    // Get the source ID before removing the bundle
    const sourceId = lockfile.bundles[bundleId].sourceId;

    // Remove the bundle
    delete lockfile.bundles[bundleId];

    // Clean up orphaned sources (sources not referenced by any bundle)
    this.cleanupOrphanedSources(lockfile, sourceId);

    // If no bundles left, delete the lockfile
    if (Object.keys(lockfile.bundles).length === 0) {
      await this.deleteLockfileAtPath(lockfilePath);

      // If local lockfile was deleted, remove from git exclude
      // Requirement 5.4: Remove local lockfile from git exclude when deleted
      if (isLocalLockfile) {
        await this.removeLocalLockfileFromGitExclude();
      }

      this._onLockfileUpdated.fire(null);
      return;
    }

    // Update timestamp and write
    lockfile.generatedAt = new Date().toISOString();
    await this.writeAtomicToPath(lockfile, lockfilePath);
    this._onLockfileUpdated.fire(lockfile);
  }

  /**
   * Delete a lockfile at a specific path.
   * @param lockfilePath - Path to the lockfile to delete
   */
  private async deleteLockfileAtPath(lockfilePath: string): Promise<void> {
    try {
      if (fs.existsSync(lockfilePath)) {
        await fs.promises.unlink(lockfilePath);
        this.logger.debug(`Lockfile deleted: ${lockfilePath}`);
      }
    } catch (error) {
      // Log error but don't throw - continue operation
      this.logger.error(`Failed to delete lockfile at ${lockfilePath}:`, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Remove the local lockfile entry from git exclude.
   * Called when the local lockfile is deleted (last local-only bundle removed).
   *
   * Requirements covered:
   * - 5.4: Remove prompt-registry.local.lock.json from .git/info/exclude when deleted
   * - 2.2: Remove local lockfile from git exclude when deleted
   */
  private async removeLocalLockfileFromGitExclude(): Promise<void> {
    try {
      const gitDir = path.join(this.repositoryPath, '.git');
      if (!fs.existsSync(gitDir)) {
        this.logger.debug('No .git directory found, skipping git exclude removal for local lockfile');
        return;
      }

      const excludePath = path.join(gitDir, 'info', 'exclude');
      if (!fs.existsSync(excludePath)) {
        this.logger.debug('.git/info/exclude does not exist, nothing to remove');
        return;
      }

      const content = await fs.promises.readFile(excludePath, 'utf8');

      // Find the AI Primitives Hub section
      const sectionHeader = '# Prompt Registry (local)';
      const sectionIndex = content.indexOf(sectionHeader);

      if (sectionIndex === -1) {
        this.logger.debug('AI Primitives Hub section not found in git exclude');
        return;
      }

      const beforeSection = content.substring(0, sectionIndex);
      const afterHeaderIndex = sectionIndex + sectionHeader.length;
      const remainingContent = content.substring(afterHeaderIndex);

      // Find the end of our section (next section header or end of file)
      const nextSectionMatch = remainingContent.match(/\n#[^\n]+/);
      let sectionContent: string;
      let afterSection = '';

      if (nextSectionMatch && nextSectionMatch.index !== undefined) {
        sectionContent = remainingContent.substring(0, nextSectionMatch.index);
        afterSection = remainingContent.substring(nextSectionMatch.index);
      } else {
        sectionContent = remainingContent;
      }

      // Parse and filter entries - remove the local lockfile entry
      const remainingEntries = sectionContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== LOCAL_LOCKFILE_NAME);

      // Rebuild content
      const newContent: string = remainingEntries.length === 0
        ? beforeSection.trimEnd() + afterSection
        : beforeSection.trimEnd()
          + (beforeSection.length > 0 ? '\n\n' : '')
          + sectionHeader + '\n'
          + remainingEntries.join('\n') + '\n'
          + afterSection;

      await fs.promises.writeFile(excludePath, newContent.trim() + '\n', 'utf8');
      this.logger.debug('Removed local lockfile from git exclude');
    } catch (error) {
      // Log but don't throw - git exclude is optional
      this.logger.warn('Failed to remove local lockfile from git exclude:', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Clean up sources that are no longer referenced by any bundle
   * @param lockfile
   * @param removedSourceId
   */
  private cleanupOrphanedSources(lockfile: Lockfile, removedSourceId: string): void {
    // Check if any other bundle references this source
    const isSourceReferenced = Object.values(lockfile.bundles)
      .some((bundle) => bundle.sourceId === removedSourceId);

    if (!isSourceReferenced) {
      delete lockfile.sources[removedSourceId];
    }
  }

  /**
   * Create an empty lockfile structure with required fields
   */
  private createEmptyLockfile(): Lockfile {
    // Get extension version from package.json
    let extensionVersion = '0.0.0';
    try {
      const extension = vscode.extensions.getExtension('prompt-registry');
      if (extension) {
        extensionVersion = extension.packageJSON.version || '0.0.0';
      }
    } catch {
      // Use default version if extension info not available
    }

    return {
      $schema: LOCKFILE_SCHEMA_URL,
      version: LOCKFILE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      generatedBy: `prompt-registry@${extensionVersion}`,
      bundles: {},
      sources: {}
    };
  }

  /**
   * Write lockfile atomically using temp file + rename pattern
   * This prevents corruption during concurrent operations or crashes
   * Uses a mutex to serialize concurrent writes
   * @param lockfile - Lockfile to write
   */
  private async writeAtomic(lockfile: Lockfile): Promise<void> {
    await this.writeAtomicToPath(lockfile, this.lockfilePath);
  }

  /**
   * Write lockfile atomically to a specific path using temp file + rename pattern
   * This prevents corruption during concurrent operations or crashes
   * Uses a mutex to serialize concurrent writes
   * @param lockfile - Lockfile to write
   * @param targetPath - Path to write the lockfile to
   */
  private async writeAtomicToPath(lockfile: Lockfile, targetPath: string): Promise<void> {
    // Serialize writes using a mutex pattern
    const previousLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      // Wait for any previous write to complete
      await previousLock;

      const tempPath = targetPath + '.tmp';

      try {
        // Write to temp file with 2-space indentation
        const content = JSON.stringify(lockfile, null, 2);
        await fs.promises.writeFile(tempPath, content, 'utf8');

        // Atomic rename
        await fs.promises.rename(tempPath, targetPath);

        this.logger.debug(`Lockfile written successfully to ${targetPath}`);
      } catch (error) {
        // Clean up temp file if it exists
        try {
          if (fs.existsSync(tempPath)) {
            await fs.promises.unlink(tempPath);
          }
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    } finally {
      releaseLock!();
    }
  }

  /**
   * Ensure the local lockfile is added to git exclude.
   * Called when the local lockfile is first created.
   *
   * Requirements covered:
   * - 2.1: Add prompt-registry.local.lock.json to .git/info/exclude on creation
   */
  private async ensureLocalLockfileExcluded(): Promise<void> {
    try {
      const gitDir = path.join(this.repositoryPath, '.git');
      if (!fs.existsSync(gitDir)) {
        this.logger.debug('No .git directory found, skipping git exclude for local lockfile');
        return;
      }

      const excludePath = path.join(gitDir, 'info', 'exclude');
      const excludeDir = path.dirname(excludePath);

      // Ensure .git/info directory exists
      if (!fs.existsSync(excludeDir)) {
        await fs.promises.mkdir(excludeDir, { recursive: true });
      }

      // Read existing content
      let content = '';
      if (fs.existsSync(excludePath)) {
        content = await fs.promises.readFile(excludePath, 'utf8');
      }

      // Check if local lockfile is already excluded
      if (content.includes(LOCAL_LOCKFILE_NAME)) {
        this.logger.debug('Local lockfile already in git exclude');
        return;
      }

      // Add local lockfile to git exclude under AI Primitives Hub section
      const sectionHeader = '# Prompt Registry (local)';
      const sectionIndex = content.indexOf(sectionHeader);

      let newContent: string;
      if (sectionIndex === -1) {
        // Create new section
        const trimmedContent = content.trimEnd();
        newContent = trimmedContent
          + (trimmedContent.length > 0 ? '\n\n' : '')
          + sectionHeader + '\n'
          + LOCAL_LOCKFILE_NAME + '\n';
      } else {
        // Add to existing section
        const afterHeaderIndex = sectionIndex + sectionHeader.length;
        const beforeSection = content.substring(0, afterHeaderIndex);
        const afterSection = content.substring(afterHeaderIndex);
        newContent = beforeSection + '\n' + LOCAL_LOCKFILE_NAME + afterSection;
      }

      await fs.promises.writeFile(excludePath, newContent, 'utf8');
      this.logger.debug('Added local lockfile to git exclude');
    } catch (error) {
      // Log but don't throw - git exclude is optional
      this.logger.warn('Failed to add local lockfile to git exclude:', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Delete the main lockfile.
   * Delegates to deleteLockfileAtPath for the main lockfile path.
   *
   * Requirements covered:
   * - 3.5: If deletion fails, log an error and continue without throwing
   */
  private async deleteLockfile(): Promise<void> {
    await this.deleteLockfileAtPath(this.lockfilePath);
  }

  /**
   * Check if any files in a bundle entry are missing from the filesystem.
   * Uses async file access for consistency with async patterns.
   * Handles I/O errors gracefully by logging a warning and assuming files exist.
   * @param entry - The lockfile bundle entry to check
   * @returns true if any file is missing, false otherwise
   *
   * Requirements covered:
   * - 3.1: Verify that bundle files exist in .github/ directories
   * - 3.2: Mark bundle with filesMissing flag if files are missing
   */
  private async checkFilesMissing(entry: LockfileBundleEntry): Promise<boolean> {
    if (!entry.files || entry.files.length === 0) {
      return false;
    }

    for (const file of entry.files) {
      const filePath = path.join(this.repositoryPath, file.path);

      try {
        await fs.promises.access(filePath, fs.constants.F_OK);
      } catch (error) {
        // Check if it's a "file not found" error vs other I/O errors
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return true;
        }
        // Handle other I/O errors gracefully - log warning and assume files exist
        this.logger.warn(
          `Failed to check file existence for ${file.path}:`,
          error instanceof Error ? error : undefined
        );
        // Per requirements: assume files exist on I/O error
      }
    }

    return false;
  }

  /**
   * Get the path to the lockfile
   */
  public getLockfilePath(): string {
    return this.lockfilePath;
  }

  /**
   * Get the path to the local lockfile (for local-only bundles)
   */
  public getLocalLockfilePath(): string {
    return path.join(this.repositoryPath, LOCAL_LOCKFILE_NAME);
  }

  /**
   * Read the lockfile from disk
   * @returns The lockfile object or null if it doesn't exist
   */
  public async read(): Promise<Lockfile | null> {
    try {
      if (!fs.existsSync(this.lockfilePath)) {
        return null;
      }
      const content = await fs.promises.readFile(this.lockfilePath, 'utf8');
      return JSON.parse(content) as Lockfile;
    } catch (error) {
      this.logger.error('Failed to read lockfile:', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Validate the lockfile against the JSON schema
   * @returns Validation result with errors and warnings
   */
  public async validate(): Promise<LockfileValidationResult> {
    const lockfile = await this.read();

    if (!lockfile) {
      return {
        valid: false,
        errors: ['Lockfile does not exist'],
        warnings: [],
        schemaVersion: undefined
      };
    }

    try {
      // Get schema path from extension installation directory
      // Falls back to process.cwd() for development mode
      const schemaPath = this.getSchemaPath('lockfile.schema.json');
      const result = await this.schemaValidator.validate(lockfile, schemaPath);

      return {
        valid: result.valid,
        errors: result.errors,
        warnings: result.warnings,
        schemaVersion: lockfile.version
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
        warnings: [],
        schemaVersion: lockfile.version
      };
    }
  }

  /**
   * Create or update a bundle entry in the lockfile
   * Uses atomic write (temp file + rename) to prevent corruption
   *
   * Routes to the correct lockfile based on commitMode:
   * - 'commit' mode: writes to prompt-registry.lock.json
   * - 'local-only' mode: writes to prompt-registry.local.lock.json
   *
   * Bundle entries are written WITHOUT the commitMode field since it's implicit
   * based on which lockfile contains the entry.
   * @param options - Bundle creation/update options
   * @throws {Error} if required fields are missing or invalid
   *
   * Requirements covered:
   * - 1.1: Write local-only bundles to prompt-registry.local.lock.json
   * - 1.2: Write commit bundles to prompt-registry.lock.json
   * - 1.4: Do not include commitMode field in local lockfile entries
   * - 1.5: Do not include commitMode field in main lockfile entries
   * - 2.1: Add local lockfile to git exclude on first creation
   */
  public async createOrUpdate(options: CreateOrUpdateOptions): Promise<void> {
    // Validate required fields
    if (!options.bundleId || typeof options.bundleId !== 'string' || options.bundleId.trim() === '') {
      throw new Error('bundleId is required and must be a non-empty string');
    }
    if (!options.version || typeof options.version !== 'string' || options.version.trim() === '') {
      throw new Error('version is required and must be a non-empty string');
    }
    if (!options.sourceId || typeof options.sourceId !== 'string' || options.sourceId.trim() === '') {
      throw new Error('sourceId is required and must be a non-empty string');
    }
    if (!options.sourceType || typeof options.sourceType !== 'string') {
      throw new Error('sourceType is required and must be a string');
    }
    if (!Array.isArray(options.files)) {
      throw new Error('files must be an array');
    }
    if (!options.source || typeof options.source !== 'object') {
      throw new Error('source is required and must be an object');
    }
    if (!options.source.type || !options.source.url) {
      throw new Error('source must have type and url properties');
    }
    if (!options.commitMode || !['commit', 'local-only'].includes(options.commitMode)) {
      throw new Error('commitMode must be either "commit" or "local-only"');
    }

    const {
      bundleId,
      version,
      sourceId,
      sourceType,
      commitMode,
      files,
      source,
      hub,
      profile,
      checksum
    } = options;

    // Determine target lockfile path based on commitMode
    const targetLockfilePath = this.getLockfilePathForMode(commitMode);
    const isLocalLockfile = commitMode === 'local-only';
    const localLockfileExistedBefore = isLocalLockfile && fs.existsSync(targetLockfilePath);

    // Read existing lockfile for the target mode or create new one
    let lockfile = await this.readLockfileByMode(commitMode);

    if (!lockfile) {
      lockfile = this.createEmptyLockfile();
    }

    // Update bundle entry WITHOUT commitMode field (implicit based on file location)
    // Requirements 1.4, 1.5: commitMode is not included in bundle entries
    const bundleEntry: LockfileBundleEntry = {
      version,
      sourceId,
      sourceType,
      installedAt: new Date().toISOString(),
      files,
      ...(checksum && { checksum })
    };
    lockfile.bundles[bundleId] = bundleEntry;

    // Update source entry
    lockfile.sources[sourceId] = source;

    // Update hub entry if provided
    if (hub) {
      if (!lockfile.hubs) {
        lockfile.hubs = {};
      }
      lockfile.hubs[hub.id] = hub.entry;
    }

    // Update profile entry if provided
    if (profile) {
      if (!lockfile.profiles) {
        lockfile.profiles = {};
      }
      lockfile.profiles[profile.id] = profile.entry;
    }

    // Update timestamp
    lockfile.generatedAt = new Date().toISOString();

    // Write atomically to the target lockfile
    await this.writeAtomicToPath(lockfile, targetLockfilePath);

    // If this is the first local-only bundle (local lockfile was just created),
    // add it to git exclude
    // Requirement 2.1: Add local lockfile to git exclude on creation
    if (isLocalLockfile && !localLockfileExistedBefore) {
      await this.ensureLocalLockfileExcluded();
    }

    this._onLockfileUpdated.fire(lockfile);
  }

  /**
   * Remove a bundle from the appropriate lockfile.
   * Searches both main and local lockfiles to find and remove the bundle.
   * Deletes the lockfile if it becomes empty.
   * Removes local lockfile from git exclude when local lockfile is deleted.
   * @param bundleId - ID of the bundle to remove
   *
   * Requirements covered:
   * - 5.1: Remove local-only bundles from Local_Lockfile
   * - 5.2: Remove committed bundles from Main_Lockfile
   * - 5.3: Delete Local_Lockfile when last local-only bundle is removed
   * - 5.4: Remove local lockfile from git exclude when deleted
   * - 5.5: Delete Main_Lockfile when last committed bundle is removed
   */
  public async remove(bundleId: string): Promise<void> {
    // First, try to find the bundle in the main lockfile
    const mainLockfile = await this.readLockfileByMode('commit');
    if (mainLockfile && mainLockfile.bundles[bundleId]) {
      await this.removeFromLockfileByMode(bundleId, mainLockfile, 'commit');
      return;
    }

    // If not in main lockfile, try the local lockfile
    const localLockfile = await this.readLockfileByMode('local-only');
    if (localLockfile && localLockfile.bundles[bundleId]) {
      await this.removeFromLockfileByMode(bundleId, localLockfile, 'local-only');
      return;
    }

    // Bundle not found in either lockfile
    this.logger.debug(`Bundle ${bundleId} not found in any lockfile`);
  }

  /**
   * Detect files that have been modified since installation
   * Compares current file checksums against stored checksums
   * @param bundleId - ID of the bundle to check
   * @returns Array of modified file information
   */
  public async detectModifiedFiles(bundleId: string): Promise<ModifiedFileInfo[]> {
    const lockfile = await this.read();

    if (!lockfile || !lockfile.bundles[bundleId]) {
      return [];
    }

    const bundleEntry = lockfile.bundles[bundleId];
    const modifiedFiles: ModifiedFileInfo[] = [];

    for (const fileEntry of bundleEntry.files) {
      const filePath = path.join(this.repositoryPath, fileEntry.path);

      try {
        if (!fs.existsSync(filePath)) {
          // File is missing
          modifiedFiles.push({
            path: fileEntry.path,
            originalChecksum: fileEntry.checksum,
            currentChecksum: '',
            modificationType: 'missing'
          });
          continue;
        }

        // Calculate current checksum using the utility directly
        const currentChecksum = await calculateFileChecksum(filePath);

        if (currentChecksum !== fileEntry.checksum) {
          modifiedFiles.push({
            path: fileEntry.path,
            originalChecksum: fileEntry.checksum,
            currentChecksum,
            modificationType: 'modified'
          });
        }
      } catch (error) {
        this.logger.warn(`Failed to check file ${fileEntry.path}:`, error instanceof Error ? error : undefined);
        modifiedFiles.push({
          path: fileEntry.path,
          originalChecksum: fileEntry.checksum,
          currentChecksum: '',
          modificationType: 'missing'
        });
      }
    }

    return modifiedFiles;
  }

  /**
   * Update the commit mode for a bundle by moving it between lockfiles.
   * Moves the bundle entry from the source lockfile to the target lockfile,
   * preserving all metadata (version, sourceId, files, etc.).
   * @param bundleId - ID of the bundle to update
   * @param newMode - The new commit mode ('commit' or 'local-only')
   * @throws {Error} if bundle is not found in the source lockfile
   *
   * Requirements covered:
   * - 4.1: Move bundle from Main_Lockfile to Local_Lockfile when switching to local-only
   * - 4.2: Move bundle from Local_Lockfile to Main_Lockfile when switching to commit
   * - 4.3: Preserve all bundle metadata during move
   * - 4.4: Add local lockfile to git exclude when moving to local-only
   * - 4.5: Remove local lockfile from git exclude when local lockfile becomes empty
   * - 4.6: Return error if bundle not found in source lockfile
   */
  public async updateCommitMode(bundleId: string, newMode: RepositoryCommitMode): Promise<void> {
    // Determine source lockfile (opposite of newMode)
    const currentMode: RepositoryCommitMode = newMode === 'commit' ? 'local-only' : 'commit';

    // Read source lockfile
    const sourceLockfile = await this.readLockfileByMode(currentMode);

    if (!sourceLockfile) {
      throw new Error(`Bundle ${bundleId} not found in ${currentMode} lockfile`);
    }

    if (!sourceLockfile.bundles[bundleId]) {
      throw new Error(`Bundle ${bundleId} not found in ${currentMode} lockfile`);
    }

    // Get bundle entry and source entry from source lockfile
    const bundleEntry = sourceLockfile.bundles[bundleId];
    const sourceEntry = sourceLockfile.sources[bundleEntry.sourceId];

    // Remove from source lockfile first (atomic removal)
    await this.removeFromLockfileByMode(bundleId, sourceLockfile, currentMode);

    // Add to target lockfile
    // Read or create target lockfile
    let targetLockfile = await this.readLockfileByMode(newMode);
    const targetLockfilePath = this.getLockfilePathForMode(newMode);
    const isTargetLocalLockfile = newMode === 'local-only';
    const targetLockfileExistedBefore = fs.existsSync(targetLockfilePath);

    if (!targetLockfile) {
      targetLockfile = this.createEmptyLockfile();
    }

    // Add bundle entry to target lockfile (without commitMode field - implicit based on file)
    // Create a clean copy without commitMode to ensure it's not included
    const cleanBundleEntry: LockfileBundleEntry = {
      version: bundleEntry.version,
      sourceId: bundleEntry.sourceId,
      sourceType: bundleEntry.sourceType,
      installedAt: bundleEntry.installedAt,
      files: bundleEntry.files,
      ...(bundleEntry.checksum && { checksum: bundleEntry.checksum })
    };
    targetLockfile.bundles[bundleId] = cleanBundleEntry;

    // Copy source entry to target lockfile if not already present
    if (sourceEntry && !targetLockfile.sources[bundleEntry.sourceId]) {
      targetLockfile.sources[bundleEntry.sourceId] = sourceEntry;
    }

    // Update timestamp
    targetLockfile.generatedAt = new Date().toISOString();

    // Write target lockfile atomically
    await this.writeAtomicToPath(targetLockfile, targetLockfilePath);

    // Handle git exclude for local lockfile
    // Requirement 4.4: Add to git exclude when moving to local-only
    if (isTargetLocalLockfile && !targetLockfileExistedBefore) {
      await this.ensureLocalLockfileExcluded();
    }

    // Emit event with the target lockfile
    this._onLockfileUpdated.fire(targetLockfile);
  }

  /**
   * Get all installed bundles from both lockfiles as InstalledBundle objects.
   * This is the primary method for querying repository-scoped bundles.
   *
   * Reads from both main lockfile (commit mode) and local lockfile (local-only mode),
   * annotates bundles with the appropriate commit mode based on source lockfile,
   * and detects conflicts when the same bundle ID exists in both lockfiles.
   * @returns Array of InstalledBundle objects, empty array if no lockfiles exist
   *
   * Requirements covered:
   * - 1.3: Convert LockfileBundleEntry to InstalledBundle format
   * - 1.4: Return empty array if lockfile doesn't exist
   * - 3.1: Read from both Main_Lockfile and Local_Lockfile
   * - 3.2: Set commitMode: 'local-only' on bundles from Local_Lockfile
   * - 3.3: Set commitMode: 'commit' on bundles from Main_Lockfile
   * - 3.4: Display error when bundle ID exists in both lockfiles
   */
  public async getInstalledBundles(): Promise<InstalledBundle[]> {
    const bundles: InstalledBundle[] = [];
    const seenIds = new Set<string>();

    // Read main lockfile (commit mode)
    const mainLockfile = await this.readLockfileByMode('commit');
    if (mainLockfile) {
      for (const [bundleId, entry] of Object.entries(mainLockfile.bundles)) {
        seenIds.add(bundleId);
        const filesMissing = await this.checkFilesMissing(entry);
        // Create bundle with commitMode: 'commit' (from main lockfile)
        // TODO: installPath should point to the bundle cache in global storage, not .github
        // The .github directory is where files are synced, not where the bundle is installed.
        // This is a workaround - BundleInstaller.uninstall() handles this case specially.
        const installedBundle = createInstalledBundleFromLockfile(bundleId, entry, {
          installPath: path.join(this.repositoryPath, '.github'),
          filesMissing,
          commitModeOverride: 'commit'
        });
        bundles.push(installedBundle);
      }
    }

    // Read local lockfile (local-only mode)
    const localLockfile = await this.readLockfileByMode('local-only');
    if (localLockfile) {
      for (const [bundleId, entry] of Object.entries(localLockfile.bundles)) {
        if (seenIds.has(bundleId)) {
          // Conflict: bundle exists in both lockfiles
          this.logger.error(`Bundle ${bundleId} exists in both lockfiles - manual resolution required`);
          vscode.window.showErrorMessage(
            `Bundle "${bundleId}" exists in both lockfiles. Please manually remove it from one lockfile.`
          );
          continue;
        }
        const filesMissing = await this.checkFilesMissing(entry);
        // Create bundle with commitMode: 'local-only' (from local lockfile)
        const installedBundle = createInstalledBundleFromLockfile(bundleId, entry, {
          installPath: path.join(this.repositoryPath, '.github'),
          filesMissing,
          commitModeOverride: 'local-only'
        });
        bundles.push(installedBundle);
      }
    }

    return bundles;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = null;
    }
    this._onLockfileUpdated.dispose();
  }
}

/**
 * Options for creating an InstalledBundle from a lockfile entry
 */
export interface CreateInstalledBundleOptions {
  /** Install path (defaults to empty string if not provided) */
  installPath?: string;
  /** Deployment manifest (defaults to minimal manifest if not provided) */
  manifest?: DeploymentManifest;
  /** Whether files are missing from the filesystem */
  filesMissing?: boolean;
  /** Override the commit mode from the lockfile entry (used when commit mode is implicit based on file location) */
  commitModeOverride?: RepositoryCommitMode;
}

/**
 * Create an InstalledBundle object from a lockfile bundle entry.
 *
 * This is the single source of truth for converting lockfile entries to InstalledBundle format.
 * Used by both LockfileManager and bundleScopeUtils for consistent conversion.
 * @param bundleId - The bundle ID
 * @param bundleEntry - The lockfile bundle entry
 * @param options - Optional configuration for the conversion
 * @returns InstalledBundle object
 */
export function createInstalledBundleFromLockfile(
    bundleId: string,
    bundleEntry: LockfileBundleEntry,
    options?: CreateInstalledBundleOptions
): InstalledBundle {
  const manifest = options?.manifest ?? createMinimalManifest(bundleId, bundleEntry.files);

  // Use commitModeOverride if provided, otherwise fall back to entry's commitMode
  // This supports the dual-lockfile pattern where commit mode is implicit based on file location
  const commitMode = options?.commitModeOverride ?? bundleEntry.commitMode;

  return {
    bundleId,
    version: bundleEntry.version,
    installedAt: bundleEntry.installedAt,
    scope: 'repository',
    installPath: options?.installPath ?? '',
    manifest,
    sourceId: bundleEntry.sourceId,
    sourceType: bundleEntry.sourceType,
    commitMode,
    filesMissing: options?.filesMissing
  };
}

/**
 * Create a minimal deployment manifest for repository-scoped bundles.
 *
 * The actual manifest content is not stored in the lockfile, so we create
 * a minimal manifest with the file paths from the lockfile entry.
 * @param bundleId - The bundle ID
 * @param files - Array of file entries from the lockfile
 * @returns Minimal DeploymentManifest object
 */
function createMinimalManifest(
    bundleId: string,
    files: { path: string; checksum: string }[] = []
): DeploymentManifest {
  return {
    common: {
      directories: [],
      files: files.map((f) => f.path),
      include_patterns: [],
      exclude_patterns: []
    },
    bundle_settings: {
      include_common_in_environment_bundles: false,
      create_common_bundle: false,
      compression: 'none',
      naming: {
        environment_bundle: bundleId
      }
    },
    metadata: {
      manifest_version: '1.0.0',
      description: `Repository bundle: ${bundleId}`
    }
  };
}
