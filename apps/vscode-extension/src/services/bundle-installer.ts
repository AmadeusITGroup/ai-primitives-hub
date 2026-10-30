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
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  findModifiedFiles,
  InstallPipeline,
  InstallPipelineError,
  type RecordInstallResult,
  type RecordSourceInput,
  type SiblingSync,
  writerGroupFor,
} from '@ai-primitives-hub/app';
import type {
  BundleDownloader,
  BundleExtractor,
  BundleResolver,
  BundleSpec,
  ExtractedFiles,
  Installable,
  RecordLocation,
  Target,
  TargetType,
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
import type {
  McpServerNaming,
} from '../types/mcp';
import {
  Bundle,
  DeploymentManifest,
  InstallationScope,
  InstalledBundle,
  InstallOptions,
  RepositoryCommitMode,
} from '../types/registry';
import {
  getSkillName,
} from '../utils/copilot-file-type-utils';
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
  resolveContainedPath,
} from '../utils/path-safety';
import {
  getWorkspaceRoot,
} from '../utils/scope-selection-ui';
import {
  checkPathExists,
} from '../utils/symlink-utils';
import {
  ExtensionRecordAdapter,
} from './extension-record-adapter';
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

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);
const lstat = promisify(fs.lstat);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const symlink = promisify(fs.symlink);

/** A repository install prepared before any file is written (W9 steps 1–2). */
interface PreparedRepositoryInstall {
  /** Workspace folder the writer installs into. */
  workspaceRoot: string;
  /** Record file the entry is recorded in. */
  location: RecordLocation;
  /** Configured source the entry records (NFR4.15). */
  source: RecordSourceInput;
}

/** An in-place repository update (W11): the old entry, read before the write. */
export interface RepositoryUpdateInPlace {
  /** Bundle id of the installed version; the new version may carry another id. */
  previousBundleId: string;
  /** File holding the host entry (`holdingLocation`), when the record has one. */
  location?: RecordLocation;
  /** Root-relative paths of the old entry that were modified or missing before the write. */
  modified: ReadonlySet<string>;
}

/**
 * Bundle Installer
 */
export class BundleInstaller {
  private readonly logger: Logger;
  private readonly copilotSync: UserScopeService;
  private readonly mcpManager: McpServerManager;
  private readonly storage: RegistryStorage;
  private readonly targetType: TargetType;
  private readonly records: ExtensionRecordAdapter;

  /**
   * Create a new BundleInstaller.
   * @param context - VS Code extension context.
   * @param targetType - Host editor target type; detected from the running
   *   editor by default, injectable for tests. Used to resolve host-aware
   *   repository-scope destinations and as the recorded tool.
   * @param records - Shared install record adapter; one over this
   *   installer's stored sources with `targetType` as host tool by default.
   */
  constructor(private readonly context: vscode.ExtensionContext, targetType?: TargetType, records?: ExtensionRecordAdapter) {
    this.logger = Logger.getInstance();
    this.copilotSync = new UserScopeService(context);
    this.mcpManager = new McpServerManager();
    this.storage = new RegistryStorage(context);
    this.targetType = targetType ?? detectHostApp();
    this.records = records ?? new ExtensionRecordAdapter({ sources: { listSources: () => this.storage.getSources() }, hostTool: this.targetType });
  }

  /**
   * Get the appropriate scope service for the given scope
   * @param scope
   */
  private getScopeService(scope: InstallationScope): IScopeService {
    if (scope === 'repository') {
      return this.getRepositoryScopeService();
    }
    return ScopeServiceFactory.create(scope, this.context);
  }

  /**
   * The repository scope service for the open workspace, wired to the shared record.
   * @throws {Error} When no workspace is open.
   */
  private getRepositoryScopeService(): RepositoryScopeService {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error('Repository scope requires an open workspace. Please open a workspace and try again.');
    }
    return new RepositoryScopeService(workspaceRoot, this.storage, this.targetType, this.records);
  }

  /**
   * Show a `RECORD.*` error once and rethrow it; other errors pass through.
   * @param error - Anything thrown.
   * @param written - Files the writer wrote before the error.
   * @param root - Record root, for "Open file".
   */
  private rethrowRecordError(error: unknown, written: readonly string[] = [], root?: string): never {
    this.records.showRecordError(error, written, root);
    throw error;
  }

  /**
   * W9 steps 1–2: check the configured source and load both record files
   * before anything is written (NFR4.15, NFR5.2).
   * @param bundle - Bundle to install.
   * @param commitMode - Commit mode of the install.
   * @param inPlace - The old entry, for an update.
   */
  private async prepareRepositoryInstall(
    bundle: Bundle,
    commitMode: RepositoryCommitMode,
    inPlace?: RepositoryUpdateInPlace
  ): Promise<PreparedRepositoryInstall> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error('Repository scope requires an open workspace. Please open a workspace and try again.');
    }
    const source = await this.records.buildSource(bundle.sourceId);
    try {
      const location = inPlace?.location ?? await this.records.prepareInstall(workspaceRoot, commitMode);
      return { workspaceRoot, location, source };
    } catch (error) {
      this.rethrowRecordError(error);
    }
  }

  /**
   * W9 steps 6–10 / W11: record the host tool's entry with the written files,
   * bring writer-group siblings along (BR11.6), report other siblings as out
   * of date, retire the old `prompt-registry` entry (BR12.1), then delete the
   * superseded files except modified ones (NFR4.13).
   * @param bundle - Installed bundle.
   * @param prepared - Result of {@link prepareRepositoryInstall}.
   * @param written - Absolute paths the writer wrote.
   * @param routeKeys - Kinds the bundle wrote, as `kindRoutes` keys.
   * @param inPlace - The old entry, for an update.
   */
  private async recordRepositoryInstall(
    bundle: Bundle,
    prepared: PreparedRepositoryInstall,
    written: readonly string[],
    routeKeys: readonly string[],
    inPlace?: RepositoryUpdateInPlace
  ): Promise<void> {
    const group = writerGroupFor(this.records.hostTool, routeKeys);
    const root = prepared.location.root;
    const changes: RecordInstallResult[] = [];
    try {
      changes.push(await this.records.service.recordInstall({
        location: prepared.location,
        bundleId: bundle.id,
        version: bundle.version,
        tool: this.records.hostTool,
        source: prepared.source,
        sourceType: prepared.source.type,
        writtenPaths: written,
        workspaceRoot: prepared.workspaceRoot,
        syncSiblings: (tool) => group.includes(tool)
      }));
      if (inPlace !== undefined && inPlace.previousBundleId !== bundle.id && inPlace.location !== undefined) {
        // The new version has another bundle id: the old id's host entry goes.
        changes.push(await this.records.service.recordUninstall({ location: inPlace.location, bundleId: inPlace.previousBundleId, tool: this.records.hostTool }));
      }
    } catch (error) {
      this.rethrowRecordError(error, written, root);
    }
    this.reportOutOfDateSiblings(bundle.id, changes[0].siblings);
    await this.retireOldEntry(prepared.workspaceRoot, bundle.id, root);
    const modified = inPlace?.modified ?? new Set<string>();
    const removal = await this.records.service.deleteSupersededAfterAll(changes.map((change) => ({
      location: change.location,
      deletedFiles: change.deletedFiles.filter((file) => !modified.has(file))
    }))).catch((error: unknown) => this.rethrowRecordError(error, [], root));
    for (const warning of [...changes.flatMap((change) => change.warnings), ...removal.warnings]) {
      this.logger.warn(`[BundleInstaller] ${warning}`);
    }
    this.logger.debug(`Recorded ${bundle.id} for ${this.records.hostTool} in ${prepared.location.path}`);
  }

  /**
   * Retire the old `prompt-registry` entry of a bundle after the record was saved (BR12.1).
   * @param workspaceRoot - Workspace folder.
   * @param bundleId - Bundle id.
   * @param root - Record root, for "Open file".
   */
  private async retireOldEntry(workspaceRoot: string, bundleId: string, root: string): Promise<void> {
    try {
      const retired = await this.records.retireOldEntry(workspaceRoot, bundleId);
      retired?.warnings.forEach((warning) => this.logger.warn(`[BundleInstaller] ${warning}`));
    } catch (error) {
      this.rethrowRecordError(error, [], root);
    }
  }

  /**
   * One information message for sibling entries sharing the bundle's files
   * that this install did not bring to the new version (BR11.4, BR11.6).
   * @param bundleId - Bundle id.
   * @param siblings - Siblings from `recordInstall`.
   */
  private reportOutOfDateSiblings(bundleId: string, siblings: readonly SiblingSync[]): void {
    const stale = siblings.filter((sibling) => !sibling.synced);
    if (stale.length === 0) {
      return;
    }
    const tools = stale.map((sibling) => `${sibling.tool} (${sibling.version})`).join(', ');
    const message = `"${bundleId}" is also installed for ${tools}, which shares its files and is now out of date. `
      + `Update it with the CLI: ai-primitives-hub update ${bundleId} --target <a ${stale[0].tool} target>`;
    this.logger.info(`[BundleInstaller] ${message}`);
    void vscode.window.showInformationMessage(message);
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
    let storageRoot: string;

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
      storageRoot = this.context.globalStorageUri.fsPath;
    } else if (scope === 'user') {
      storageRoot = this.context.globalStorageUri.fsPath;
    } else {
      const workspaceStorage = this.context.storageUri?.fsPath;
      if (!workspaceStorage) {
        throw new Error('Workspace storage not available');
      }
      storageRoot = workspaceStorage;
    }

    return resolveContainedPath(path.join(storageRoot, 'bundles'), bundleId, 'bundle installation path');
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
    commitMode?: RepositoryCommitMode,
    // What the server keys are built from: `ai-primitives-hub:<owner>:<repo>:<manifestId>:<server>`.
    naming: McpServerNaming = {}
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
            createBackup: true,
            ...naming
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
          createBackup: true,
          ...naming
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
   * W11: repository update in place, over the host entry at `holdingLocation`.
   * @param installed - Installed version.
   * @param bundle - New version.
   * @param bundleBuffer - Downloaded bundle bytes.
   * @param sourceType - Source type of the new version.
   */
  private async updateRepositoryInPlace(
    installed: InstalledBundle,
    bundle: Bundle,
    bundleBuffer: Buffer,
    sourceType: string | undefined
  ): Promise<InstalledBundle> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error('Repository scope requires an open workspace. Please open a workspace and try again.');
    }
    let inPlace: RepositoryUpdateInPlace;
    try {
      const located = await this.records.findHostEntry(workspaceRoot, installed.bundleId);
      inPlace = {
        previousBundleId: installed.bundleId,
        location: located?.location,
        modified: new Set(located === undefined ? [] : await findModifiedFiles(this.records.fs, located.location.root, located.entry.files))
      };
    } catch (error) {
      this.rethrowRecordError(error);
    }
    // MCP config entries are merged, not recorded: refresh them as before.
    await this.uninstallMcpServers(installed.bundleId, 'repository');
    const updated = await this.installFromBuffer(
      bundle,
      bundleBuffer,
      { scope: 'repository', version: bundle.version, commitMode: inPlace.location?.commitMode ?? installed.commitMode },
      sourceType,
      inPlace
    );
    this.logger.info('Bundle updated successfully');
    return updated;
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
    return new RepositoryScopeService(workspaceRoot, this.storage, this.targetType, this.records);
  }

  /**
   * Install a bundle from a Buffer (for adapters that create bundles on-the-fly)
   * @param bundle
   * @param bundleBuffer
   * @param options
   * @param sourceType
   * @param inPlace - For a repository update (W11): the old entry, read before the write; no uninstall runs first.
   */
  public async installFromBuffer(
    bundle: Bundle,
    bundleBuffer: Buffer,
    options: InstallOptions,
    sourceType?: string,
    inPlace?: RepositoryUpdateInPlace
  ): Promise<InstalledBundle> {
    this.logger.info(`Installing bundle from buffer: ${bundle.name} v${bundle.version}`);

    // Check if this is a skills bundle (Anthropic-style skills source)
    const isSkillsBundle = sourceType === 'skills' || sourceType === 'local-skills';
    // For repository scope we must still run through the standard sync/lockfile flow; only
    // user/workspace scopes should install directly into the Copilot skills directory.
    const installSkillsToCopilotDir = isSkillsBundle && options.scope !== 'repository';

    // Repository installs check the source and the record before any write (W9 steps 1–2).
    const repository = options.scope === 'repository'
      ? await this.prepareRepositoryInstall(bundle, options.commitMode ?? 'commit', inPlace)
      : undefined;

    // Bridge the extension's already-resolved Bundle + already-downloaded Buffer (the
    // adapter did both before calling this method, per the "unified architecture" note
    // at the top of this file) into InstallPipeline's resolve/download stages: both are
    // no-ops here, there is nothing left to resolve or fetch over the network.
    const spec: BundleSpec = {
      sourceId: bundle.sourceId,
      bundleId: bundle.id,
      bundleVersion: bundle.version
    };
    const target: Target = {
      name: 'vscode',
      type: 'vscode',
      scope: options.scope,
      commitMode: options.commitMode
    };

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
        if (files.has('deployment-manifest.yml')) {
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
        return augmented;
      }
    };

    let installDir = '';

    const writer: TargetWriter = {
      write: async (_target: Target, files: ExtractedFiles): Promise<TargetWriteResult> => {
        const written: string[] = [];

        if (installSkillsToCopilotDir) {
          // Skills bundles install directly to Copilot skills directory for user/workspace scopes.
          // Find the skill directory by locating a SKILL.md entry in the bundle.
          const skillEntry = [...files.keys()].find((p) => path.posix.basename(p).toLowerCase() === 'skill.md');
          if (!skillEntry) {
            throw new Error('Skills directory not found in bundle');
          }

          const skillDir = path.posix.dirname(skillEntry);
          const skillName = getSkillName(skillEntry) ?? path.posix.basename(skillDir);

          const copilotScope = options.scope === 'workspace' ? 'workspace' : 'user';
          const skillsBaseDir = this.copilotSync.getCopilotSkillsDirectory(copilotScope);
          await ensureDirectory(skillsBaseDir);
          installDir = resolveContainedPath(skillsBaseDir, skillName, 'skill installation path');

          this.logger.debug(`[BundleInstaller] Skills bundle detected, installing to: ${installDir}`);

          // Copy skill files directly to ~/.copilot/skills/{skill-name}
          const skillEntryPrefix = `${skillDir}/`;
          const skillEntries = [...files.entries()].filter(([p]) => p.startsWith(skillEntryPrefix));
          if (skillEntries.length === 0) {
            throw new Error(`Skill directory not found in bundle: ${skillDir}`);
          }

          // Check for existing skill using checkPathExists to detect broken symlinks
          const existingEntry = await checkPathExists(installDir);
          if (existingEntry.exists) {
            // For broken symlinks, we can safely remove without prompting
            if (existingEntry.isBroken) {
              await fs.promises.unlink(installDir);
              this.logger.debug(`Removed broken symlink: ${installDir}`);
            } else {
              const shouldOverwrite = await this.promptOverwriteSkill(skillName, installDir, existingEntry.isSymbolicLink);
              if (!shouldOverwrite) {
                throw new Error(`Installation cancelled: skill '${skillName}' already exists`);
              }
              await this.removeDirectory(installDir);
            }
          }

          for (const [entryPath, bytes] of skillEntries) {
            const outPath = resolveContainedPath(
              installDir,
              entryPath.slice(skillEntryPrefix.length),
              'bundle file path'
            );
            await ensureDirectory(path.dirname(outPath));
            await writeFile(outPath, Buffer.from(bytes));
            written.push(outPath);
          }
        } else {
          // Standard bundles: copy all extracted files into the bundle cache directory.
          if (options.scope === 'repository') {
            this.logger.info(`[BundleInstaller] Installing repository scope bundle to global storage: bundles/${bundle.id}`);
          }
          installDir = this.getInstallDirectory(bundle.id, options.scope, bundle.name);
          await ensureDirectory(installDir);
          this.logger.debug(`Installation directory: ${installDir}`);

          for (const [entryPath, bytes] of files) {
            const outPath = resolveContainedPath(installDir, entryPath, 'bundle file path');
            await ensureDirectory(path.dirname(outPath));
            await writeFile(outPath, Buffer.from(bytes));
            written.push(outPath);
          }
        }

        this.logger.debug('Files copied to installation directory');
        return { written, skipped: [] };
      },
      remove: async (_target: Target, filePath: string): Promise<void> => {
        if (installDir.length > 0) {
          await unlink(resolveContainedPath(installDir, filePath, 'bundle file path')).catch(() => undefined);
        }
      }
    };

    const pipeline = new InstallPipeline({
      resolver,
      downloader,
      extractor,
      writerFactory: () => writer,
      skipManifestIdValidation: sourceType === 'artifactory'
    });

    try {
      const outcome = await pipeline.run(spec, target);
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
        commitMode: options.scope === 'repository' ? (options.commitMode ?? 'commit') : undefined
      };

      // Step 9: Install MCP servers if defined (skip for skills bundles)
      if (installSkillsToCopilotDir) {
        this.logger.debug('Skills bundle - skipping MCP servers and Copilot sync (already installed to ~/.copilot/skills/)');
      } else {
        // Skills bundles going through repository scope should still skip MCP servers
        if (!isSkillsBundle) {
          await this.installMcpServers(
            bundle.id,
            bundle.version,
            installDir,
            manifest,
            options.scope,
            options.commitMode,
            {
              manifestId: outcome.manifest.id,
              manifestRepository: typeof outcome.manifest.repository === 'string' ? outcome.manifest.repository : undefined,
              sourceRepository: bundle.repository
            }
          );
          this.logger.debug('MCP servers installation completed');
        }

        // Step 10: Sync to appropriate scope directory (skills for repository scope must run through this)
        // Pass commitMode explicitly to syncBundle to avoid timing issues:
        // The installation record hasn't been saved to RegistryStorage yet at this point,
        // so RepositoryScopeService can't look up commitMode from storage.
        if (repository) {
          // Step 11: record the written files in the shared install record (W9).
          const repoService = this.getRepositoryScopeService();
          const written = await repoService.syncBundle(bundle.id, installDir, { commitMode: options.commitMode });
          await this.recordRepositoryInstall(bundle, repository, written, repoService.routeKeysFor(manifest), inPlace);
        } else {
          await this.getScopeService(options.scope).syncBundle(bundle.id, installDir, { commitMode: options.commitMode });
        }
        this.logger.debug(`Synced to ${options.scope} scope`);
      }

      this.logger.info(`Bundle installed successfully from buffer: ${bundle.name}`);
      return installed;
    } catch (error) {
      this.logger.error('Bundle installation from buffer failed', error as Error);
      if (error instanceof InstallPipelineError) {
        throw new Error(error.message.replace(/^(resolve|download|extract|validate|write) failed: /, ''));
      }
      throw error;
    }
  }

  /**
   * Uninstall a bundle. At repository scope the host tool's record entry is
   * removed and its files deleted, except shared and modified ones (W10); a
   * bundle only the old lockfile holds leaves it the same way (BR12.1).
   * @param installed
   * @throws {RegistryError} A `RECORD.*` error, after it was shown once.
   */
  public async uninstall(installed: InstalledBundle): Promise<void> {
    this.logger.info(`Uninstalling bundle: ${installed.bundleId}`);

    try {
      // Uninstall MCP servers
      await this.uninstallMcpServers(installed.bundleId, installed.scope);
      this.logger.debug('MCP servers uninstalled');

      // Unsync from appropriate scope directory (repository: the record entry and its files)
      const scopeService = this.getScopeService(installed.scope);
      await scopeService.unsyncBundle(installed.bundleId);
      this.logger.debug(`Removed from ${installed.scope} scope`);

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
      this.records.showRecordError(error);
      throw error;
    }
  }

  /**
   * Update a bundle
   *
   * At repository scope the update runs in place (W11): the old host entry's
   * modified files are found before the write, the new version is written and
   * recorded over the existing entry in the file that holds it, and only
   * unmodified superseded files are deleted. No uninstall runs first.
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
      const resolvedSourceType = sourceType ?? installed.sourceType;
      if (installed.scope === 'repository') {
        return await this.updateRepositoryInPlace(installed, bundle, bundleBuffer, resolvedSourceType);
      }

      // Uninstall old version
      await this.uninstall(installed);

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
