/**
 * Bundle Installer Service
 * Handles extracting and installing bundle files
 *
 * Architecture Note:
 * - Remote bundles use the unified architecture: adapter.downloadBundle() -> installFromBuffer()
 * - Each adapter (GitHub, HTTP, Local, etc.) handles its own download logic and authentication
 * - This service focuses on extraction, validation, and installation from Buffer
 * - The install() method is only used for local file:// URLs
 * - The downloadFile() method has been removed as downloads are now handled by adapters
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- top-level import, cannot use await import
import AdmZip = require('adm-zip');
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  RegistryStorage,
} from '../storage/registry-storage';
import {
  LockfileFileEntry,
  LockfileSourceEntry,
} from '../types/lockfile';
import {
  Bundle,
  DeploymentManifest,
  InstallationScope,
  InstalledBundle,
  InstallOptions,
  RepositoryCommitMode,
} from '../types/registry';
import {
  isManifestIdMatch,
} from '../utils/bundle-name-utils';
import {
  determineFileType,
  getRepositoryTargetDirectory,
  getTargetFileName,
  normalizePromptId,
} from '../utils/copilot-file-type-utils';
import {
  calculateFileChecksum,
  ensureDirectory,
} from '../utils/file-integrity-service';
import {
  Logger,
} from '../utils/logger';
import {
  getWorkspaceRoot,
} from '../utils/scope-selection-ui';
import {
  checkPathExists,
} from '../utils/symlink-utils';
import {
  LockfileManager,
} from './lockfile-manager';
import {
  McpServerManager,
} from './mcp-server-manager';
import {
  RepositoryScopeService,
} from './repository-scope-service';
import {
  IScopeService,
} from './scope-service';
import {
  ScopeServiceFactory,
} from './scope-service-factory';
import {
  UserScopeService,
} from './user-scope-service';

const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const lstat = promisify(fs.lstat);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const symlink = promisify(fs.symlink);

/**
 * Bundle Installer
 */
export class BundleInstaller {
  private readonly logger: Logger;
  private readonly copilotSync: UserScopeService;
  private readonly mcpManager: McpServerManager;
  private readonly storage: RegistryStorage;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.logger = Logger.getInstance();
    this.copilotSync = new UserScopeService(context);
    this.mcpManager = new McpServerManager();
    this.storage = new RegistryStorage(context);
  }

  /**
   * Get the appropriate scope service for the given scope
   * @param scope
   */
  private getScopeService(scope: InstallationScope): IScopeService {
    if (scope === 'repository') {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        throw new Error('Repository scope requires an open workspace. Please open a workspace and try again.');
      }
      return ScopeServiceFactory.create(scope, this.context, workspaceRoot, this.storage);
    }
    return ScopeServiceFactory.create(scope, this.context);
  }

  /**
   * Collect file entries with checksums for lockfile
   * @param installDir
   * @param workspaceRoot
   */
  private async collectFileEntries(installDir: string, workspaceRoot: string): Promise<LockfileFileEntry[]> {
    const entries: LockfileFileEntry[] = [];

    const collectFromDir = async (dir: string): Promise<void> => {
      if (!fs.existsSync(dir)) {
        return;
      }

      const files = await readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = await stat(filePath);

        if (stats.isDirectory()) {
          await collectFromDir(filePath);
        } else {
          const relativePath = path.relative(workspaceRoot, filePath);
          const checksum = await calculateFileChecksum(filePath);
          entries.push({ path: relativePath, checksum });
        }
      }
    };

    await collectFromDir(installDir);
    return entries;
  }

  /**
   * Update lockfile when installing a bundle at repository scope
   * @param bundle
   * @param installed
   * @param options
   * @param sourceType
   */
  private async updateLockfileOnInstall(
    bundle: Bundle,
    installed: InstalledBundle,
    options: InstallOptions,
    sourceType?: string
  ): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      this.logger.warn('Cannot update lockfile: no workspace root');
      return;
    }

    try {
      const lockfileManager = LockfileManager.getInstance(workspaceRoot);

      // For repository scope, collect files from .github/ directories (where they are synced)
      // not from the bundle cache directory
      const files = await this.collectRepositoryFileEntries(workspaceRoot, installed.installPath);

      // Create source entry
      const source: LockfileSourceEntry = {
        type: sourceType || installed.sourceType || 'unknown',
        url: bundle.downloadUrl || bundle.manifestUrl || ''
      };

      await lockfileManager.createOrUpdate({
        bundleId: bundle.id,
        version: bundle.version,
        sourceId: bundle.sourceId,
        sourceType: sourceType || installed.sourceType || 'unknown',
        commitMode: options.commitMode ?? 'commit',
        files,
        source
      });

      this.logger.debug(`Updated lockfile for bundle ${bundle.id}`);
    } catch (error) {
      this.logger.error('Failed to update lockfile on install', error as Error);
      // Don't fail the installation if lockfile update fails
    }
  }

  /**
   * Collect file entries from .github/ directories for repository scope lockfile
   * This collects the actual synced files, not the bundle cache files
   * @param workspaceRoot
   * @param bundlePath
   */
  private async collectRepositoryFileEntries(workspaceRoot: string, bundlePath: string): Promise<LockfileFileEntry[]> {
    const entries: LockfileFileEntry[] = [];

    // Read the deployment manifest to know which files were installed
    const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');
    if (!fs.existsSync(manifestPath)) {
      this.logger.warn('No deployment manifest found, falling back to bundle cache files');
      return this.collectFileEntries(bundlePath, workspaceRoot);
    }

    try {
      const manifestContent = await readFile(manifestPath, 'utf8');
      const manifest = yaml.load(manifestContent) as DeploymentManifest;

      if (!manifest.prompts || manifest.prompts.length === 0) {
        return entries;
      }

      // Collect files from .github/ directories based on manifest
      for (const promptDef of manifest.prompts) {
        const promptId = normalizePromptId(promptDef.id);
        const fileType = determineFileType(promptDef.file, promptDef.tags);
        const targetDir = getRepositoryTargetDirectory(fileType);

        if (fileType === 'skill') {
          // For skills, collect all files in the skill directory
          const skillDir = path.join(workspaceRoot, targetDir, promptId);
          if (fs.existsSync(skillDir)) {
            await this.collectFromDirectory(skillDir, workspaceRoot, entries);
          }
        } else {
          // For other file types, collect the single file
          const targetFileName = getTargetFileName(promptId, fileType);
          const targetPath = path.join(workspaceRoot, targetDir, targetFileName);

          if (fs.existsSync(targetPath)) {
            const relativePath = path.relative(workspaceRoot, targetPath);
            const checksum = await calculateFileChecksum(targetPath);
            entries.push({ path: relativePath, checksum });
          }
        }
      }

      return entries;
    } catch (error) {
      this.logger.warn('Failed to parse manifest, falling back to bundle cache files', error);
      return this.collectFileEntries(bundlePath, workspaceRoot);
    }
  }

  /**
   * Recursively collect files from a directory
   * @param dir
   * @param workspaceRoot
   * @param entries
   */
  private async collectFromDirectory(dir: string, workspaceRoot: string, entries: LockfileFileEntry[]): Promise<void> {
    if (!fs.existsSync(dir)) {
      return;
    }

    const files = await readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = await stat(filePath);

      if (stats.isDirectory()) {
        await this.collectFromDirectory(filePath, workspaceRoot, entries);
      } else {
        const relativePath = path.relative(workspaceRoot, filePath);
        const checksum = await calculateFileChecksum(filePath);
        entries.push({ path: relativePath, checksum });
      }
    }
  }

  /**
   * Update lockfile when uninstalling a bundle at repository scope
   * @param bundleId
   */
  private async updateLockfileOnUninstall(bundleId: string): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      this.logger.warn('Cannot update lockfile: no workspace root');
      return;
    }

    try {
      const lockfileManager = LockfileManager.getInstance(workspaceRoot);
      await lockfileManager.remove(bundleId);
      this.logger.debug(`Removed bundle ${bundleId} from lockfile`);
    } catch (error) {
      this.logger.error('Failed to update lockfile on uninstall', error as Error);
      // Don't fail the uninstallation if lockfile update fails
    }
  }

  // ===== Helper Methods =====

  /**
   * Create temporary directory
   */
  private async createTempDir(): Promise<string> {
    const tempBase = path.join(this.context.globalStorageUri.fsPath, 'temp');
    await ensureDirectory(tempBase);

    const tempDir = path.join(tempBase, `bundle-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    return tempDir;
  }

  /**
   * Extract bundle archive
   * @param bundleFile
   * @param extractDir
   */
  private async extractBundle(bundleFile: string, extractDir: string): Promise<void> {
    await ensureDirectory(extractDir);

    try {
      // Use adm-zip for extraction
      const zip = new AdmZip(bundleFile);
      zip.extractAllTo(extractDir, true);
    } catch (error) {
      throw new Error(`Failed to extract bundle: ${(error as Error).message}`);
    }
  }

  /**
   * Validate bundle structure
   * @param extractDir
   * @param bundle
   */
  private async validateBundle(extractDir: string, bundle: Bundle): Promise<DeploymentManifest> {
    // Check if deployment-manifest.yml exists
    const manifestPath = path.join(extractDir, 'deployment-manifest.yml');

    if (!fs.existsSync(manifestPath)) {
      // For local bundles (like awesome-copilot), deployment-manifest.yml is optional
      // Create a minimal manifest from the bundle info
      this.logger.info(`No deployment-manifest.yml found for ${bundle.id}, creating minimal manifest`);
      return {
        common: {
          directories: [],
          files: [],
          include_patterns: ['**/*'],
          exclude_patterns: []
        },
        bundle_settings: {
          include_common_in_environment_bundles: true,
          create_common_bundle: true,
          compression: 'none',
          naming: {
            environment_bundle: bundle.id
          }
        },
        metadata: {
          manifest_version: '1.0',
          description: bundle.description || bundle.name || bundle.id,
          author: 'awesome-copilot',
          last_updated: new Date().toISOString()
        }
      };
    }

    this.logger.debug(`Validating manifest: ${manifestPath}`);

    // Validate manifest content (parse YAML)
    const manifestContent = await readFile(manifestPath, 'utf8');
    const manifest = yaml.load(manifestContent) as any;

    // Basic validation
    if (!manifest.id || !manifest.version || !manifest.name) {
      throw new Error('Invalid deployment manifest - missing required fields');
    }

    // Verify ID matches
    // For GitHub bundles, the manifest may contain just the collection ID (e.g., "test2")
    // while bundle.id is the full computed ID (e.g., "owner-repo-test2-v1.0.0" or "owner-repo-test2-1.0.0")
    // Accept both exact match and suffix match for backward compatibility
    // Handle both with and without 'v' prefix in version
    if (!isManifestIdMatch(manifest.id, manifest.version, bundle.id)) {
      throw new Error(`Bundle ID mismatch: expected ${bundle.id}, got ${manifest.id}`);
    }

    // Verify version matches (allow "latest" to match any)
    if (bundle.version !== 'latest' && manifest.version !== bundle.version) {
      throw new Error(`Bundle version mismatch: expected ${bundle.version}, got ${manifest.version}`);
    }

    this.logger.debug('Bundle manifest validation passed');

    return manifest as DeploymentManifest;
  }

  /**
   * Get installation directory for bundle
   * Repository scope bundles are installed in the workspace's bundle storage
   * @param bundleId
   * @param scope
   * @param _bundleName
   */
  private getInstallDirectory(bundleId: string, scope: InstallationScope, _bundleName?: string): string {
    // Repository scope: install in extension global storage (NOT in the workspace)
    // The bundle cache/storage should remain in extension storage.
    // Only the actual content files (prompts, agents, etc.) are synced to .github/ directories
    // by RepositoryScopeService.syncBundle()
    if (scope === 'repository') {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('Repository scope requires an open workspace. Please open a workspace and try again.');
      }

      // Use global storage for bundle cache, same as user scope
      // This prevents polluting the repository with internal extension files
      this.logger.info(`[BundleInstaller] Installing repository scope bundle to global storage: bundles/${bundleId}`);
      return path.join(this.context.globalStorageUri.fsPath, 'bundles', bundleId);
    }

    // Standard bundle installation
    if (scope === 'user') {
      // User scope: global storage
      return path.join(this.context.globalStorageUri.fsPath, 'bundles', bundleId);
    } else {
      // Workspace scope: workspace storage
      const workspaceStorage = this.context.storageUri?.fsPath;
      if (!workspaceStorage) {
        throw new Error('Workspace storage not available');
      }
      return path.join(workspaceStorage, 'bundles', bundleId);
    }
  }

  /**
   * Copy bundle files to installation directory
   * @param sourceDir
   * @param targetDir
   */
  private async copyBundleFiles(sourceDir: string, targetDir: string): Promise<void> {
    const files = await readdir(sourceDir);

    for (const file of files) {
      const sourcePath = path.join(sourceDir, file);
      const targetPath = path.join(targetDir, file);

      const stats = await stat(sourcePath);

      if (stats.isDirectory()) {
        await ensureDirectory(targetPath);
        await this.copyBundleFiles(sourcePath, targetPath);
      } else {
        const content = await readFile(sourcePath);
        await writeFile(targetPath, content);
      }
    }
  }

  /**
   * Check if a path is the .github directory or a subdirectory of it.
   * Used to prevent accidental removal of the .github folder which may contain
   * unrelated files like workflows, CODEOWNERS, etc.
   * @param dirPath - The directory path to check
   * @returns true if the path is .github or ends with /.github
   */
  private isGitHubDirectory(dirPath: string): boolean {
    const normalizedPath = path.normalize(dirPath);
    const baseName = path.basename(normalizedPath);

    // Check if the directory itself is named .github
    // This handles both "/path/to/.github" and ".github"
    return baseName === '.github';
  }

  /**
   * Remove directory recursively
   * Handles symbolic links safely by removing only the link, not the target
   * @param dir
   */
  private async removeDirectory(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      return;
    }

    const files = await readdir(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = await lstat(filePath); // Use lstat to detect symbolic links

      if (stats.isSymbolicLink()) {
        // For symbolic links, remove only the link, not the target
        await unlink(filePath);
        this.logger.debug(`Removed symbolic link: ${filePath}`);
      } else if (stats.isDirectory()) {
        await this.removeDirectory(filePath);
      } else {
        await unlink(filePath);
      }
    }

    await rmdir(dir);
  }

  /**
   * Copy directory recursively
   * @param sourceDir
   * @param targetDir
   */
  private async copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
    await ensureDirectory(targetDir);

    const entries = await readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath);
      } else if (entry.isFile()) {
        const content = await readFile(sourcePath);
        await writeFile(targetPath, content);
      }
    }
  }

  /**
   * Clean up temporary directory
   * @param tempDir
   */
  private async cleanupTempDir(tempDir: string): Promise<void> {
    try {
      await this.removeDirectory(tempDir);
    } catch (error) {
      this.logger.warn('Failed to cleanup temp directory', error);
      // Don't fail the installation if cleanup fails
    }
  }

  /**
   * Install MCP servers from manifest
   * @param bundleId
   * @param bundleVersion
   * @param installPath
   * @param manifest
   * @param scope
   * @param commitMode
   */
  private async installMcpServers(
    bundleId: string,
    bundleVersion: string,
    installPath: string,
    manifest: DeploymentManifest,
    scope: InstallationScope,
    commitMode?: RepositoryCommitMode
  ): Promise<void> {
    if (!manifest.mcpServers || Object.keys(manifest.mcpServers).length === 0) {
      this.logger.debug(`No MCP servers to install for bundle ${bundleId}`);
      return;
    }

    this.logger.info(`Installing MCP servers for bundle ${bundleId}`);

    try {
      // Handle repository scope with workspace-specific installation
      if (scope === 'repository') {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
          this.logger.warn(`Cannot install MCP servers for repository scope: no workspace root`);
          return;
        }

        const workspaceInstallationResult = await this.mcpManager.installServersToWorkspace(
          bundleId,
          bundleVersion,
          workspaceRoot,
          manifest.mcpServers,
          {
            commitMode: commitMode ?? 'commit',
            overwrite: false,
            skipOnConflict: false,
            createBackup: true
          },
          manifest.mcpInputs
        );

        if (workspaceInstallationResult.success) {
          this.logger.info(`Successfully installed ${workspaceInstallationResult.serversInstalled} MCP servers to workspace`);
        } else {
          this.logger.warn(`MCP server installation had issues: ${workspaceInstallationResult.errors?.join(', ')}`);
        }

        if (workspaceInstallationResult.warnings && workspaceInstallationResult.warnings.length > 0) {
          this.logger.warn(`MCP installation warnings: ${workspaceInstallationResult.warnings.join(', ')}`);
        }
        return;
      }

      // Handle user/workspace scope with existing logic
      const result = await this.mcpManager.installServers(
        bundleId,
        bundleVersion,
        installPath,
        manifest.mcpServers,
        {
          scope,
          overwrite: false,
          skipOnConflict: false,
          createBackup: true
        },
        manifest.mcpInputs
      );

      if (result.success) {
        this.logger.info(`Successfully installed ${result.serversInstalled} MCP servers`);
      } else {
        this.logger.warn(`MCP server installation had issues: ${result.errors?.join(', ')}`);
      }

      if (result.warnings && result.warnings.length > 0) {
        this.logger.warn(`MCP installation warnings: ${result.warnings.join(', ')}`);
      }
    } catch (error) {
      this.logger.error(`Failed to install MCP servers for bundle ${bundleId}`, error as Error);
      // Don't fail the entire bundle installation if MCP installation fails
    }
  }

  /**
   * Uninstall MCP servers for a bundle
   * @param bundleId
   * @param scope
   */
  private async uninstallMcpServers(bundleId: string, scope: InstallationScope): Promise<void> {
    this.logger.info(`Uninstalling MCP servers for bundle ${bundleId}`);

    try {
      // Handle repository scope with workspace-specific uninstallation
      if (scope === 'repository') {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
          this.logger.warn(`Cannot uninstall MCP servers for repository scope: no workspace root`);
          return;
        }

        const workspaceUninstallationResult = await this.mcpManager.uninstallServersFromWorkspace(bundleId, workspaceRoot);

        if (!workspaceUninstallationResult.success) {
          this.logger.warn(`MCP server uninstallation had issues: ${workspaceUninstallationResult.errors?.join(', ')}`);
        } else if (workspaceUninstallationResult.serversRemoved > 0) {
          this.logger.info(`Successfully uninstalled ${workspaceUninstallationResult.serversRemoved} MCP servers from workspace`);
        } else {
          this.logger.debug(`No MCP servers found for bundle ${bundleId} in workspace`);
        }
        return;
      }

      // Handle user/workspace scope with existing logic
      const result = await this.mcpManager.uninstallServers(bundleId, scope);

      if (!result.success) {
        this.logger.warn(`MCP server uninstallation had issues: ${result.errors?.join(', ')}`);
      } else if (result.serversRemoved > 0) {
        this.logger.info(`Successfully uninstalled ${result.serversRemoved} MCP servers`);
      } else {
        this.logger.debug(`No MCP servers found for bundle ${bundleId}`);
      }
    } catch (error) {
      this.logger.error(`Failed to uninstall MCP servers for bundle ${bundleId}`, error as Error);
      // Don't fail the entire bundle uninstallation if MCP uninstallation fails
    }
  }

  /**
   * Prompt user to confirm overwriting an existing skill
   * @param skillName Name of the skill
   * @param existingPath Path to the existing skill
   * @param existingIsSymlink Whether the existing skill is a symlink
   * @returns True if user confirms overwrite, false otherwise
   */
  private async promptOverwriteSkill(skillName: string, existingPath: string, existingIsSymlink: boolean): Promise<boolean> {
    const symlinkInfo = existingIsSymlink ? ' (symlink)' : '';
    const message = `A skill named '${skillName}' already exists${symlinkInfo}. Do you want to overwrite it?`;

    const result = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      'Overwrite',
      'Cancel'
    );

    return result === 'Overwrite';
  }

  /**
   * Create a RepositoryScopeService for the current workspace
   * Used by BundleScopeCommands for scope migration
   * @returns RepositoryScopeService or undefined if no workspace is open
   */
  public createRepositoryScopeService(): RepositoryScopeService | undefined {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return undefined;
    }
    return new RepositoryScopeService(workspaceRoot, this.storage);
  }

  /**
   * Install a bundle from a Buffer (for adapters that create bundles on-the-fly)
   * @param bundle
   * @param bundleBuffer
   * @param options
   * @param sourceType
   */
  public async installFromBuffer(
    bundle: Bundle,
    bundleBuffer: Buffer,
    options: InstallOptions,
    sourceType?: string
  ): Promise<InstalledBundle> {
    this.logger.info(`Installing bundle from buffer: ${bundle.name} v${bundle.version}`);

    try {
      // Step 1: Create temp directory
      const tempDir = await this.createTempDir();
      this.logger.debug(`Created temp directory: ${tempDir}`);

      // Step 2: Write buffer to temp file
      const bundleFile = path.join(tempDir, `${bundle.id}.zip`);
      await writeFile(bundleFile, bundleBuffer);
      this.logger.debug(`Wrote bundle buffer to: ${bundleFile} (${bundleBuffer.length} bytes)`);

      // Step 3: Extract bundle
      const extractDir = path.join(tempDir, 'extracted');
      await this.extractBundle(bundleFile, extractDir);
      this.logger.debug(`Extracted bundle to: ${extractDir}`);

      // Step 4: Validate bundle structure
      const manifest = await this.validateBundle(extractDir, bundle);
      this.logger.debug('Bundle validation passed');

      // Check if this is a skills bundle (Anthropic-style skills source)
      const isSkillsBundle = sourceType === 'skills' || sourceType === 'local-skills';
      // For repository scope we must still run through the standard sync/lockfile flow; only
      // user/workspace scopes should install directly into the Copilot skills directory.
      const installSkillsToCopilotDir = isSkillsBundle && options.scope !== 'repository';

      let installDir: string;

      if (installSkillsToCopilotDir) {
        // Skills bundles install directly to Copilot skills directory for user/workspace scopes.
        // Derive the skill's source directory from the manifest file path so skills packaged
        // under a non-standard directory (e.g. .github/skills/) are resolved correctly.
        const skillEntry = (manifest.prompts || []).find((p) => p.type === 'skill');
        const skillFile = skillEntry?.file;
        if (!skillFile) {
          throw new Error('No skill entry found in bundle manifest');
        }
        const skillDir = path.dirname(skillFile);
        const skillName = path.basename(skillDir);
        const copilotScope = options.scope === 'workspace' ? 'workspace' : 'user';
        installDir = this.copilotSync.getCopilotSkillsDirectory(copilotScope);
        await ensureDirectory(installDir);
        installDir = path.join(installDir, skillName);

        this.logger.debug(`[BundleInstaller] Skills bundle detected, installing to: ${installDir}`);

        // Copy skill files directly to ~/.copilot/skills/{skill-name}
        const skillSourceDir = path.join(extractDir, skillDir);
        if (fs.existsSync(skillSourceDir)) {
          // Check for existing skill using checkPathExists to detect broken symlinks
          const existingEntry = await checkPathExists(installDir);
          if (existingEntry.exists) {
            // For broken symlinks, we can safely remove without prompting
            if (existingEntry.isBroken) {
              await fs.promises.unlink(installDir);
              this.logger.debug(`Removed broken symlink: ${installDir}`);
            } else {
              const existingIsSymlink = existingEntry.isSymbolicLink;
              const shouldOverwrite = await this.promptOverwriteSkill(skillName, installDir, existingIsSymlink);
              if (!shouldOverwrite) {
                await this.cleanupTempDir(tempDir);
                throw new Error(`Installation cancelled: skill '${skillName}' already exists`);
              }
              await this.removeDirectory(installDir);
            }
          }
          await this.copyDirectory(skillSourceDir, installDir);
        } else {
          throw new Error(`Skill directory not found in bundle: ${skillDir}`);
        }
      } else {
        // Step 5: Get installation directory (standard bundles)
        installDir = this.getInstallDirectory(bundle.id, options.scope, bundle.name);
        await ensureDirectory(installDir);
        this.logger.debug(`Installation directory: ${installDir}`);

        // Step 6: Copy files to installation directory
        await this.copyBundleFiles(extractDir, installDir);
      }
      this.logger.debug('Files copied to installation directory');

      // Step 7: Clean up temp directory
      await this.cleanupTempDir(tempDir);
      this.logger.debug('Temp directory cleaned up');

      // Step 8: Create installation record
      const installed: InstalledBundle = {
        bundleId: bundle.id,
        version: bundle.version,
        installedAt: new Date().toISOString(),
        scope: options.scope,
        profileId: options.profileId,
        installPath: installDir,
        manifest: manifest,
        sourceId: bundle.sourceId,
        sourceType: sourceType,
        commitMode: options.scope === 'repository' ? (options.commitMode ?? 'commit') : undefined
      };

      // Step 9: Install MCP servers if defined (skip for skills bundles)
      if (installSkillsToCopilotDir) {
        this.logger.debug('Skills bundle - skipping MCP servers and Copilot sync (already installed to ~/.copilot/skills/)');
      } else {
        // Skills bundles going through repository scope should still skip MCP servers
        if (!isSkillsBundle) {
          await this.installMcpServers(bundle.id, bundle.version, installDir, manifest, options.scope, options.commitMode);
          this.logger.debug('MCP servers installation completed');
        }

        // Step 10: Sync to appropriate scope directory (skills for repository scope must run through this)
        const scopeService = this.getScopeService(options.scope);
        // Pass commitMode explicitly to syncBundle to avoid timing issues:
        // The installation record hasn't been saved to RegistryStorage yet at this point,
        // so RepositoryScopeService can't look up commitMode from storage.
        await scopeService.syncBundle(bundle.id, installDir, { commitMode: options.commitMode });
        this.logger.debug(`Synced to ${options.scope} scope`);

        // Step 11: Update lockfile for repository scope
        if (options.scope === 'repository') {
          await this.updateLockfileOnInstall(bundle, installed, options, sourceType);
        }
      }

      this.logger.info(`Bundle installed successfully from buffer: ${bundle.name}`);
      return installed;
    } catch (error) {
      this.logger.error('Bundle installation from buffer failed', error as Error);
      throw error;
    }
  }

  /**
   * Uninstall a bundle
   * @param installed
   */
  public async uninstall(installed: InstalledBundle): Promise<void> {
    this.logger.info(`Uninstalling bundle: ${installed.bundleId}`);

    try {
      // Uninstall MCP servers
      await this.uninstallMcpServers(installed.bundleId, installed.scope);
      this.logger.debug('MCP servers uninstalled');

      // Unsync from appropriate scope directory
      const scopeService = this.getScopeService(installed.scope);
      await scopeService.unsyncBundle(installed.bundleId);
      this.logger.debug(`Removed from ${installed.scope} scope`);

      // Remove from lockfile for repository scope
      if (installed.scope === 'repository') {
        await this.updateLockfileOnUninstall(installed.bundleId);
      }

      // Remove installation directory (bundle cache)
      // For repository scope, the installPath may point to .github which is NOT the bundle cache.
      // The actual bundle cache is in extension global storage under bundles/{bundleId}.
      // We should only remove the bundle cache directory, not the .github directory.
      if (installed.installPath && fs.existsSync(installed.installPath)) {
        if (installed.scope === 'repository' && this.isGitHubDirectory(installed.installPath)) {
          // Skip removal of .github directory - unsyncBundle already handled removing synced files
          // and we don't want to remove unrelated files (workflows, CODEOWNERS, etc.)
          this.logger.debug(`Skipping removal of .github directory: ${installed.installPath}`);

          // Remove the actual bundle cache from global storage instead
          const bundleCachePath = this.getInstallDirectory(installed.bundleId, 'repository');
          if (bundleCachePath && fs.existsSync(bundleCachePath) && bundleCachePath !== installed.installPath) {
            await this.removeDirectory(bundleCachePath);
            this.logger.debug(`Removed bundle cache directory: ${bundleCachePath}`);
          }
        } else {
          await this.removeDirectory(installed.installPath);
          this.logger.debug(`Removed directory: ${installed.installPath}`);
        }
      }

      this.logger.info('Bundle uninstalled successfully');
    } catch (error) {
      this.logger.error('Bundle uninstallation failed', error as Error);
      throw error;
    }
  }

  /**
   * Update a bundle
   * Note: This method expects a Buffer for remote bundles via the unified architecture
   * @param installed
   * @param bundle
   * @param bundleBuffer
   * @param sourceType
   * @deprecated - RegistryManager should handle updates directly using downloadBundle() + installFromBuffer()
   */
  public async update(
    installed: InstalledBundle,
    bundle: Bundle,
    bundleBuffer: Buffer,
    sourceType?: string
  ): Promise<InstalledBundle> {
    this.logger.info(`Updating bundle: ${installed.bundleId} to v${bundle.version}`);

    try {
      // Uninstall old version
      await this.uninstall(installed);

      const resolvedSourceType = sourceType ?? installed.sourceType;

      // Install new version using the unified architecture
      const newInstalled = await this.installFromBuffer(
        bundle,
        bundleBuffer,
        {
          scope: installed.scope,
          version: bundle.version,
          commitMode: installed.commitMode
        },
        resolvedSourceType
      );

      this.logger.info('Bundle updated successfully');
      return newInstalled;
    } catch (error) {
      this.logger.error('Bundle update failed', error as Error);
      throw error;
    }
  }

  /**
   * Install a local skill using a symlink instead of copying
   * This is used for local-skills sources to maintain a live link to the source directory
   * @param bundle
   * @param skillName Name of the skill
   * @param sourcePath Path to the source skill directory
   * @param options Installation options
   * @returns The installed bundle record
   */
  public async installLocalSkillAsSymlink(
    bundle: Bundle,
    skillName: string,
    sourcePath: string,
    options: InstallOptions
  ): Promise<InstalledBundle> {
    this.logger.info(`Installing local skill as symlink: ${skillName}`);

    try {
      // Get the skills directory
      const skillsDir = this.copilotSync.getCopilotSkillsDirectory('user');
      await ensureDirectory(skillsDir);

      const installDir = path.join(skillsDir, skillName);

      // Check for existing skill using checkPathExists to detect broken symlinks
      // fs.existsSync() returns false for broken symlinks, which would cause EEXIST errors
      const existingEntry = await checkPathExists(installDir);
      if (existingEntry.exists) {
        const existingIsSymlink = existingEntry.isSymbolicLink;

        // For broken symlinks, we can safely remove without prompting
        if (existingEntry.isBroken) {
          await unlink(installDir);
          this.logger.debug(`Removed broken symlink: ${installDir}`);
        } else {
          const shouldOverwrite = await this.promptOverwriteSkill(skillName, installDir, existingIsSymlink);
          if (!shouldOverwrite) {
            throw new Error(`Installation cancelled: skill '${skillName}' already exists`);
          }

          // Remove existing (symlink or directory)
          if (existingIsSymlink) {
            await unlink(installDir);
            this.logger.debug(`Removed existing symlink: ${installDir}`);
          } else {
            await this.removeDirectory(installDir);
            this.logger.debug(`Removed existing directory: ${installDir}`);
          }
        }
      }

      // Create symlink to the source directory
      try {
        await symlink(sourcePath, installDir, 'dir');
        this.logger.info(`Created symlink: ${installDir} -> ${sourcePath}`);
      } catch (symlinkError) {
        // Symlink failed (maybe Windows or permissions), fall back to copy
        this.logger.warn(`Symlink creation failed, falling back to copy: ${symlinkError}`);
        await this.copyDirectory(sourcePath, installDir);
        this.logger.info(`Copied directory: ${sourcePath} -> ${installDir}`);
      }

      // Create a minimal manifest for the installation record
      const manifest: DeploymentManifest = {
        common: {
          directories: [`skills/${skillName}`],
          files: [],
          include_patterns: ['**/*'],
          exclude_patterns: []
        },
        bundle_settings: {
          include_common_in_environment_bundles: true,
          create_common_bundle: true,
          compression: 'none',
          naming: {
            environment_bundle: bundle.id
          }
        },
        metadata: {
          manifest_version: '1.0',
          description: bundle.description || bundle.name || bundle.id,
          author: 'local-skills',
          last_updated: new Date().toISOString()
        }
      };

      // Create installation record
      const installed: InstalledBundle = {
        bundleId: bundle.id,
        version: bundle.version,
        installedAt: new Date().toISOString(),
        scope: options.scope,
        profileId: options.profileId,
        installPath: installDir,
        manifest: manifest,
        sourceId: bundle.sourceId,
        sourceType: 'local-skills'
      };

      this.logger.info(`Local skill installed successfully as symlink: ${skillName}`);
      return installed;
    } catch (error) {
      this.logger.error(`Failed to install local skill as symlink: ${skillName}`, error as Error);
      throw error;
    }
  }

  /**
   * Uninstall a skill that was installed as a symlink
   * Only removes the symlink, not the original source directory
   * @param installed The installed bundle record
   */
  public async uninstallSkillSymlink(installed: InstalledBundle): Promise<void> {
    this.logger.info(`Uninstalling skill symlink: ${installed.bundleId}`);

    try {
      if (!installed.installPath) {
        this.logger.debug(`Skill path not specified: ${installed.bundleId}`);
        return;
      }

      // Use checkPathExists to detect broken symlinks
      // fs.existsSync() returns false for broken symlinks, leaving orphaned broken symlinks
      const existingEntry = await checkPathExists(installed.installPath);

      if (!existingEntry.exists) {
        this.logger.debug(`Skill path does not exist: ${installed.installPath}`);
        return;
      }

      if (existingEntry.isSymbolicLink) {
        // Remove the symlink (works for both valid and broken symlinks)
        await unlink(installed.installPath);
        if (existingEntry.isBroken) {
          this.logger.info(`Removed broken symlink: ${installed.installPath}`);
        } else {
          this.logger.info(`Removed symlink: ${installed.installPath}`);
        }
      } else {
        // It's a regular directory (fallback from failed symlink), remove it
        await this.removeDirectory(installed.installPath);
        this.logger.info(`Removed directory: ${installed.installPath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to uninstall skill symlink: ${installed.bundleId}`, error as Error);
      throw error;
    }
  }
}
