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

import {
  createHash,
  randomUUID,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  InstallPipeline,
  InstallPipelineError,
  lockfileFilesFromInstalledRecords,
} from '@ai-primitives-hub/app';
import type {
  BundleDownloader,
  BundleExtractor,
  BundleResolver,
  BundleSpec,
  ExtractedFiles,
  Installable,
  InstalledFileRecord,
  Target,
  TargetType,
  TargetWritePlan,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
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
  ensureDirectory,
} from '../utils/file-integrity-service';
import {
  detectHostApp,
} from '../utils/host-app';
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

interface TargetSnapshot {
  destinationPath: string;
  bytes?: Buffer;
  symlinkTarget?: string;
}

interface RepositoryMetadataSnapshot {
  path: string;
  bytes?: Buffer;
}

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);
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
  private readonly targetType: TargetType;

  /**
   * Create a new BundleInstaller.
   * @param context - VS Code extension context.
   * @param targetType - Host editor target type; detected from the running
   *   editor by default, injectable for tests. Used to resolve host-aware
   *   repository-scope destinations when collecting lockfile entries.
   */
  constructor(private readonly context: vscode.ExtensionContext, targetType?: TargetType) {
    this.logger = Logger.getInstance();
    this.copilotSync = new UserScopeService(context);
    this.mcpManager = new McpServerManager();
    this.storage = new RegistryStorage(context);
    this.targetType = targetType ?? detectHostApp();
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
      return ScopeServiceFactory.create(scope, this.context, workspaceRoot, this.storage, this.targetType);
    }
    return ScopeServiceFactory.create(scope, this.context);
  }

  private async snapshotInstalledTargets(files: readonly InstalledFileRecord[]): Promise<TargetSnapshot[]> {
    const snapshots: TargetSnapshot[] = [];
    const visited = new Set<string>();
    for (const file of files) {
      if (visited.has(file.destinationPath)) {
        continue;
      }
      visited.add(file.destinationPath);
      try {
        const stat = await fs.promises.lstat(file.destinationPath);
        snapshots.push(stat.isSymbolicLink()
          ? { destinationPath: file.destinationPath, symlinkTarget: await fs.promises.readlink(file.destinationPath) }
          : { destinationPath: file.destinationPath, bytes: await fs.promises.readFile(file.destinationPath) });
      } catch {
        // Missing prior destinations need no restoration.
      }
    }
    return snapshots;
  }

  private async restoreInstalledTargets(snapshots: readonly TargetSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      await fs.promises.rm(snapshot.destinationPath, { recursive: true, force: true });
      await ensureDirectory(path.dirname(snapshot.destinationPath));
      if (snapshot.symlinkTarget !== undefined) {
        await fs.promises.symlink(snapshot.symlinkTarget, snapshot.destinationPath);
      } else if (snapshot.bytes !== undefined) {
        await fs.promises.writeFile(snapshot.destinationPath, snapshot.bytes);
      }
    }
  }

  /**
   * Update lockfile when installing a bundle at repository scope
   * @param bundle
   * @param installed
   * @param options
   * @param sourceType
   * @param installedFiles
   */
  private async updateLockfileOnInstall(
    bundle: Bundle,
    installed: InstalledBundle,
    options: InstallOptions,
    sourceType?: string,
    installedFiles: readonly InstalledFileRecord[] = []
  ): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      this.logger.warn('Cannot update lockfile: no workspace root');
      return;
    }

    const lockfileManager = LockfileManager.getInstance(workspaceRoot);

    const files: LockfileFileEntry[] = lockfileFilesFromInstalledRecords(installedFiles);

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
  }

  /**
   * Update lockfile when uninstalling a bundle at repository scope
   * @param bundleId
   * @param retainedFiles
   */
  private async updateLockfileOnUninstall(
    bundleId: string,
    retainedFiles: readonly InstalledFileRecord[] = []
  ): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      this.logger.warn('Cannot update lockfile: no workspace root');
      return;
    }

    try {
      const lockfileManager = LockfileManager.getInstance(workspaceRoot);
      await lockfileManager.remove(bundleId, retainedFiles);
      this.logger.debug(`Removed bundle ${bundleId} from lockfile`);
    } catch (error) {
      this.logger.error('Failed to update lockfile on uninstall', error as Error);
      // Don't fail the uninstallation if lockfile update fails
    }
  }

  // ===== Helper Methods =====

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
   * Install MCP servers from manifest
   * @param bundleId
   * @param bundleVersion
   * @param installPath
   * @param manifest
   * @param scope
   * @param commitMode
   */
  /**
   * Surface an MCP installation failure to the user.
   *
   * Bundle installation deliberately continues when MCP setup fails, but the failure
   * must still be visible: the errors include cases the user has to act on, such as a
   * bundle whose servers need input values the host cannot prompt for, or a host with
   * no workspace-level MCP file. Logging alone left those silent, so the bundle
   * appeared to install cleanly while its MCP servers were missing.
   * @param bundleId - Bundle being installed.
   * @param errors - Errors reported by the MCP manager.
   */
  private notifyMcpInstallFailure(bundleId: string, errors: string[] | undefined): void {
    const detail = errors && errors.length > 0 ? errors.join(' ') : 'Unknown error.';
    this.logger.warn(`MCP server installation had issues: ${detail}`);
    void vscode.window.showWarningMessage(
      `MCP servers for "${bundleId}" were not installed. ${detail}`
    );
  }

  /**
   * Surface MCP warnings for an otherwise successful install.
   *
   * Only user-actionable warnings (e.g. "host cannot prompt for inputs") are shown
   * as notifications. Bundle-author concerns (auto-derived declarations) are logged
   * but not surfaced to the end user.
   * @param bundleId - Bundle being installed.
   * @param warnings - Warnings reported by the MCP manager.
   */
  private notifyMcpInstallWarnings(bundleId: string, warnings: string[] | undefined): void {
    if (!warnings || warnings.length === 0) {
      return;
    }

    const userActionable: string[] = [];
    const nonActionable: string[] = [];
    for (const w of warnings) {
      (w.includes('auto-derived') ? nonActionable : userActionable).push(w);
    }

    if (nonActionable.length > 0) {
      this.logger.warn(`MCP installation: ${nonActionable.join(' ')}`);
    }

    if (userActionable.length > 0) {
      const detail = userActionable.join(' ');
      this.logger.warn(`MCP installation warnings: ${detail}`);
      void vscode.window.showWarningMessage(`MCP servers for "${bundleId}" ${detail}`);
    }
  }

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
          this.notifyMcpInstallFailure(bundleId, workspaceInstallationResult.errors);
        }

        this.notifyMcpInstallWarnings(bundleId, workspaceInstallationResult.warnings);
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
        this.notifyMcpInstallFailure(bundleId, result.errors);
      }

      this.notifyMcpInstallWarnings(bundleId, result.warnings);
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
    return new RepositoryScopeService(workspaceRoot, this.storage, this.targetType);
  }

  /**
   * Install a bundle from a Buffer (for adapters that create bundles on-the-fly)
   * @param bundle
   * @param bundleBuffer
   * @param options
   * @param sourceType
   * @param previousFiles Exact installed records being replaced during update.
   */
  public async installFromBuffer(
    bundle: Bundle,
    bundleBuffer: Buffer,
    options: InstallOptions,
    sourceType?: string,
    previousFiles?: readonly InstalledFileRecord[]
  ): Promise<InstalledBundle> {
    this.logger.info(`Installing bundle from buffer: ${bundle.name} v${bundle.version}`);

    // Check if this is a skills bundle (Anthropic-style skills source)
    const isSkillsBundle = sourceType === 'skills' || sourceType === 'local-skills';

    // Bridge the extension's already-resolved Bundle + already-downloaded Buffer (the
    // adapter did both before calling this method, per the "unified architecture" note
    // at the top of this file) into InstallPipeline's resolve/download stages: both are
    // no-ops here, there is nothing left to resolve or fetch over the network.
    const spec: BundleSpec = {
      sourceId: bundle.sourceId,
      bundleId: bundle.id,
      bundleVersion: bundle.version
    };
    const scopeService = this.getScopeService(options.scope);
    const baseTarget: Target = {
      name: this.targetType,
      type: this.targetType,
      scope: options.scope,
      commitMode: options.commitMode,
      ...(options.scope === 'repository' ? { rootPath: getWorkspaceRoot() ?? undefined } : {})
    };
    const target = scopeService.resolveTarget?.(baseTarget) ?? baseTarget;

    const resolver: BundleResolver = {
      resolve: (): Promise<Installable> => Promise.resolve({
        ref: {
          sourceId: bundle.sourceId ?? 'unknown',
          sourceType: sourceType ?? 'unknown',
          bundleId: bundle.id,
          bundleVersion: bundle.version,
          installed: false
        },
        downloadUrl: '',
        inlineBytes: bundleBuffer
      })
    };

    const downloader: BundleDownloader = {
      download: (installable: Installable) => {
        const bytes = installable.inlineBytes ?? new Uint8Array();
        return Promise.resolve({
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex')
        });
      }
    };

    const zipExtractor = new ZipBundleExtractor();
    const extractor: BundleExtractor = {
      extract: async (bytes: Uint8Array): Promise<ExtractedFiles> => {
        const files = await zipExtractor.extract(bytes);
        this.logger.info(`[BundleInstaller] Extracted files: ${[...files.keys()].join(', ')}`);
        if (files.has('deployment-manifest.yml')) {
          extractedFiles = files;
          return files;
        }

        // For local bundles (like awesome-copilot), deployment-manifest.yml is optional.
        // Synthesize a minimal manifest from the bundle info so the pipeline's validate
        // stage (core's validateManifest) still has an id/version/name to check.
        this.logger.info(`No deployment-manifest.yml found for ${bundle.id}, creating minimal manifest`);
        const fallbackManifest = {
          id: bundle.id,
          version: bundle.version,
          name: bundle.name || bundle.id,
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
        const augmented = new Map(files);
        augmented.set('deployment-manifest.yml', new TextEncoder().encode(yaml.dump(fallbackManifest)));
        extractedFiles = augmented;
        return augmented;
      }
    };

    let installDir = '';
    let extractedFiles: ExtractedFiles = new Map();
    let writtenFiles: readonly InstalledFileRecord[] = [];
    const writer: TargetWriter = {
      write: async (plan: TargetWritePlan): Promise<TargetWriteResult> => {
        installDir = this.getInstallDirectory(bundle.id, options.scope, bundle.name);
        await ensureDirectory(installDir);
        this.logger.debug(`Installation directory: ${installDir}`);

        for (const [entryPath, bytes] of extractedFiles) {
          const outPath = path.join(installDir, entryPath);
          await ensureDirectory(path.dirname(outPath));
          await writeFile(outPath, Buffer.from(bytes));
        }

        this.logger.debug('Files copied to installation directory');
        return scopeService.syncBundle(bundle.id, installDir, {
          commitMode: options.commitMode,
          targetPlan: plan,
          installedFiles: previousFiles
        });
      },
      remove: async (files: readonly InstalledFileRecord[]): Promise<void> => {
        for (const file of files) {
          await unlink(file.destinationPath).catch(() => undefined);
        }
      }
    };

    const pipeline = new InstallPipeline({
      resolver,
      downloader,
      extractor,
      writerFactory: () => writer,
      onEvent: (event) => {
        if (event.kind === 'warning') {
          this.logger.warn(`[${event.code}] Deprecated identity-only manifest inferred primitive kinds for: ${event.paths.join(', ')}`);
        }
      }
    });

    try {
      const outcome = await pipeline.run(spec, target);
      writtenFiles = outcome.write.installed;
      const manifest = outcome.manifest as unknown as DeploymentManifest;

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
        sourceType: sourceType,
        commitMode: options.scope === 'repository' ? (options.commitMode ?? 'commit') : undefined,
        installedFiles: outcome.write.installed
      };

      // Step 9: Install MCP servers if defined (skip for skills bundles)
      if (isSkillsBundle) {
        this.logger.debug('Skills bundle - skipping MCP server installation');
      } else {
        await this.installMcpServers(bundle.id, bundle.version, installDir, manifest, options.scope, options.commitMode);
        this.logger.debug('MCP servers installation completed');
      }

      this.logger.debug(`Synced to ${options.scope} scope`);

      // Step 10: Update lockfile for repository scope
      if (options.scope === 'repository') {
        await this.updateLockfileOnInstall(bundle, installed, options, sourceType, outcome.write.installed);
      }

      this.logger.info(`Bundle installed successfully from buffer: ${bundle.name}`);
      return installed;
    } catch (error) {
      if (writtenFiles.length > 0) {
        await scopeService.unsyncBundle(bundle.id, { installedFiles: writtenFiles }).catch((rollbackError: unknown) => {
          this.logger.error('Failed to roll back scope files after installation failure', rollbackError as Error);
        });
      }
      if (installDir.length > 0) {
        await fs.promises.rm(installDir, { recursive: true, force: true }).catch(() => undefined);
      }
      this.logger.error('Bundle installation from buffer failed', error as Error);
      if (error instanceof InstallPipelineError) {
        throw new Error(error.message.replace(/^(resolve|download|extract|validate|write) failed: /, ''));
      }
      throw error;
    }
  }

  /**
   * Uninstall a bundle
   * @param installed
   */
  public async uninstall(installed: InstalledBundle): Promise<readonly InstalledFileRecord[]> {
    this.logger.info(`Uninstalling bundle: ${installed.bundleId}`);

    try {
      // Uninstall MCP servers
      await this.uninstallMcpServers(installed.bundleId, installed.scope);
      this.logger.debug('MCP servers uninstalled');

      // Unsync from appropriate scope directory
      const scopeService = this.getScopeService(installed.scope);
      const unsyncResult = await scopeService.unsyncBundle(installed.bundleId, {
        installedFiles: installed.installedFiles
      });
      this.logger.debug(`Removed from ${installed.scope} scope`);

      // Remove from lockfile for repository scope
      if (installed.scope === 'repository') {
        await this.updateLockfileOnUninstall(installed.bundleId, unsyncResult?.retained);
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
      return unsyncResult?.retained ?? [];
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

    const cachePath = this.getInstallDirectory(installed.bundleId, installed.scope, bundle.name);
    const backupPath = `${cachePath}.update-backup-${randomUUID()}`;
    const targetSnapshots = await this.snapshotInstalledTargets(installed.installedFiles ?? []);
    const repositoryMetadataSnapshots: RepositoryMetadataSnapshot[] = [];
    if (installed.scope === 'repository') {
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot) {
        const manager = LockfileManager.getInstance(workspaceRoot);
        const lockfilePath = installed.commitMode === 'local-only'
          ? manager.getLocalLockfilePath()
          : manager.getLockfilePath();
        repositoryMetadataSnapshots.push({
          path: lockfilePath,
          ...(fs.existsSync(lockfilePath) ? { bytes: await fs.promises.readFile(lockfilePath) } : {})
        });
        if (installed.commitMode === 'local-only') {
          const excludePath = path.join(workspaceRoot, '.git', 'info', 'exclude');
          repositoryMetadataSnapshots.push({
            path: excludePath,
            ...(fs.existsSync(excludePath) ? { bytes: await fs.promises.readFile(excludePath) } : {})
          });
        }
      }
    }
    let cacheStaged = false;
    let replacementFiles: readonly InstalledFileRecord[] = [];
    try {
      if (fs.existsSync(cachePath)) {
        await fs.promises.rename(cachePath, backupPath);
        cacheStaged = true;
      }

      const resolvedSourceType = sourceType ?? installed.sourceType;
      const newInstalled = await this.installFromBuffer(
        bundle,
        bundleBuffer,
        {
          scope: installed.scope,
          version: bundle.version,
          commitMode: installed.commitMode
        },
        resolvedSourceType,
        installed.installedFiles
      );
      replacementFiles = newInstalled.installedFiles ?? [];
      const newDestinations = new Set((newInstalled.installedFiles ?? []).map((file) => file.destinationPath));
      const obsolete = (installed.installedFiles ?? []).filter((file) => !newDestinations.has(file.destinationPath));
      if (obsolete.length > 0) {
        const unsyncResult = await this.getScopeService(installed.scope).unsyncBundle(installed.bundleId, {
          installedFiles: obsolete
        });
        newInstalled.installedFiles = [
          ...(newInstalled.installedFiles ?? []),
          ...unsyncResult.retained
        ];
        if (installed.scope === 'repository') {
          await this.updateLockfileOnInstall(bundle, newInstalled, {
            scope: installed.scope,
            version: bundle.version,
            commitMode: installed.commitMode
          }, resolvedSourceType, newInstalled.installedFiles);
        }
      }
      if (cacheStaged) {
        await fs.promises.rm(backupPath, { recursive: true, force: true });
      }

      this.logger.info('Bundle updated successfully');
      return newInstalled;
    } catch (error) {
      if (replacementFiles.length > 0) {
        await this.getScopeService(installed.scope).unsyncBundle(installed.bundleId, {
          installedFiles: replacementFiles
        }).catch(() => undefined);
      }
      await this.restoreInstalledTargets(targetSnapshots);
      for (const snapshot of repositoryMetadataSnapshots) {
        try {
          if (snapshot.bytes === undefined) {
            await fs.promises.rm(snapshot.path, { force: true });
          } else {
            await ensureDirectory(path.dirname(snapshot.path));
            await fs.promises.writeFile(snapshot.path, snapshot.bytes);
          }
        } catch (restoreError) {
          this.logger.error('Failed to restore repository metadata after update failure', restoreError as Error);
        }
      }
      if (cacheStaged) {
        await fs.promises.rm(cachePath, { recursive: true, force: true });
        await fs.promises.rename(backupPath, cachePath);
      }
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
