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
  randomBytes,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  promisify,
} from 'node:util';
import {
  InstallPipeline,
  InstallPipelineError,
  TargetWriteRejectedError,
} from '@ai-primitives-hub/app';
import type {
  BundleDownloader,
  BundleExtractor,
  BundleResolver,
  BundleSpec,
  ExtractedFiles,
  Installable,
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
  McpServerManager,
} from './mcp-server-manager';
import {
  RepositoryScopeService,
} from './repository-scope-service';
import {
  IScopeService,
  SyncBundleOptions,
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

const RENAME_RETRIES = 3;
const RENAME_BACKOFF_MS = 100;
// Cache staging and old directories younger than this may belong to an
// install still running in another window (globalStorage is shared).
const CACHE_LEFTOVER_STALE_MS = 60 * 60 * 1000;

/**
 * Rename, retried on the transient `EPERM` / `EBUSY` Windows reports while
 * a scanner or indexer holds a file of the directory.
 * @param from - Current path.
 * @param to - New path.
 */
const renameWithRetry = async (from: string, to: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== 'EPERM' && code !== 'EBUSY')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * (attempt + 1)));
    }
  }
};

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
   * Install a bundle from a Buffer.
   *
   * Repository scope: the bundle cache is written to a staging directory,
   * the shared install writes the workspace files and the lockfile entry,
   * then the staging directory replaces the cache and the MCP servers are
   * installed. A failure before the swap removes only the staging
   * directory, so a rejected install has no side effect. User and
   * workspace scope keep their order: cache in place, MCP, sync.
   * @param bundle - Bundle to install.
   * @param bundleBuffer - Archive bytes.
   * @param options - Install options.
   * @param sourceType - Source type of the bundle.
   * @param beforeRepositorySync - Repository scope only: runs after the
   *   staging and before the shared install (an update's preflight and
   *   uninstall of the installed version).
   * @returns The installation record.
   */
  private async installBuffer(
    bundle: Bundle,
    bundleBuffer: Buffer,
    options: InstallOptions,
    sourceType?: string,
    beforeRepositorySync?: (scopeService: IScopeService, syncOptions: SyncBundleOptions) => Promise<void>
  ): Promise<InstalledBundle> {
    this.logger.info(`Installing bundle from buffer: ${bundle.name} v${bundle.version}`);
    const isRepositoryScope = options.scope === 'repository';

    // Check if this is a skills bundle (Anthropic-style skills source)
    const isSkillsBundle = sourceType === 'skills' || sourceType === 'local-skills';
    // For repository scope we must still run through the standard sync/lockfile flow; only
    // user/workspace scopes should install directly into the Copilot skills directory.
    const installSkillsToCopilotDir = isSkillsBundle && options.scope !== 'repository';

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
      name: this.targetType,
      type: this.targetType,
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
    let extractedFiles: ExtractedFiles | undefined;
    const extractor: BundleExtractor = {
      extract: async (bytes: Uint8Array): Promise<ExtractedFiles> => {
        const files = await zipExtractor.extract(bytes);
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
    // Directory the cache writer writes to: the staging directory at repository scope.
    let cacheWriteDir = '';

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
          cacheWriteDir = installDir;

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
          cacheWriteDir = isRepositoryScope ? await this.stageBundleCache(installDir) : installDir;
          await ensureDirectory(cacheWriteDir);
          this.logger.debug(`Installation directory: ${installDir}`);

          for (const [entryPath, bytes] of files) {
            const outPath = resolveContainedPath(cacheWriteDir, entryPath, 'bundle file path');
            await ensureDirectory(path.dirname(outPath));
            await writeFile(outPath, Buffer.from(bytes));
            written.push(outPath);
          }
        }

        this.logger.debug('Files copied to installation directory');
        return { written, skipped: [] };
      },
      remove: async (_target: Target, filePath: string): Promise<void> => {
        if (cacheWriteDir.length > 0) {
          await unlink(resolveContainedPath(cacheWriteDir, filePath, 'bundle file path')).catch(() => undefined);
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

    let cacheCommitted = !isRepositoryScope;
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
        commitMode: isRepositoryScope ? (options.commitMode ?? 'commit') : undefined
      };
      const mcpNaming: McpServerNaming = {
        manifestId: outcome.manifest.id,
        manifestRepository: typeof outcome.manifest.repository === 'string' ? outcome.manifest.repository : undefined,
        sourceRepository: bundle.repository
      };

      if (isRepositoryScope) {
        if (extractedFiles === undefined) {
          throw new Error(`Bundle ${bundle.id} was not extracted`);
        }
        const resolvedSourceType = sourceType ?? 'unknown';
        const scopeService = this.getScopeService(options.scope);
        const syncOptions: SyncBundleOptions = {
          commitMode: options.commitMode,
          install: {
            files: extractedFiles,
            manifest: outcome.manifest,
            origin: { sourceId: bundle.sourceId, sourceType: resolvedSourceType, checksum: outcome.sha256 },
            source: {
              type: resolvedSourceType,
              url: bundle.downloadUrl || bundle.manifestUrl || `${resolvedSourceType}:${bundle.sourceId}`
            }
          }
        };
        if (beforeRepositorySync !== undefined) {
          await beforeRepositorySync(scopeService, syncOptions);
        }
        await scopeService.syncBundle(bundle.id, installDir, syncOptions);
        this.logger.debug('Synced to repository scope');

        await this.commitBundleCache(cacheWriteDir, installDir, bundle.name);
        cacheCommitted = true;

        // Skills bundles skip MCP servers
        if (!isSkillsBundle) {
          await this.installMcpServers(
            bundle.id,
            bundle.version,
            installDir,
            manifest,
            options.scope,
            options.commitMode,
            mcpNaming
          );
          this.logger.debug('MCP servers installation completed');
        }
      } else if (installSkillsToCopilotDir) {
        this.logger.debug('Skills bundle - skipping MCP servers and Copilot sync (already installed to ~/.copilot/skills/)');
      } else {
        // Step 9: Install MCP servers if defined (skip for skills bundles)
        if (!isSkillsBundle) {
          await this.installMcpServers(
            bundle.id,
            bundle.version,
            installDir,
            manifest,
            options.scope,
            options.commitMode,
            mcpNaming
          );
          this.logger.debug('MCP servers installation completed');
        }

        // Step 10: Sync to appropriate scope directory
        const scopeService = this.getScopeService(options.scope);
        await scopeService.syncBundle(bundle.id, installDir, { commitMode: options.commitMode });
        this.logger.debug(`Synced to ${options.scope} scope`);
      }

      this.logger.info(`Bundle installed successfully from buffer: ${bundle.name}`);
      return installed;
    } catch (error) {
      if (!cacheCommitted && cacheWriteDir.length > 0) {
        await fs.promises.rm(cacheWriteDir, { recursive: true, force: true }).catch((rmError: unknown) => {
          this.logger.debug(`Could not remove staging directory ${cacheWriteDir}: ${String(rmError)}`);
        });
      }
      this.logger.error('Bundle installation from buffer failed', error as Error);
      if (error instanceof TargetWriteRejectedError) {
        throw Object.assign(
          new Error(`Cannot install "${bundle.name}" on ${this.targetType} (repository scope): ${error.message}`),
          { code: error.code, unsupported: error.skipped }
        );
      }
      if (error instanceof InstallPipelineError) {
        throw new Error(error.message.replace(/^(resolve|download|extract|validate|write) failed: /, ''));
      }
      throw error;
    }
  }

  /**
   * Repository-scope staging directory for the bundle cache: a fresh
   * `<installDir>.staging-<hex>` sibling. Leftover staging and old
   * directories of earlier interrupted installs are removed first (best
   * effort) once they are older than an hour; a younger one may belong to
   * an install of the same bundle still running in another window.
   * @param installDir - Bundle cache directory.
   * @returns The staging directory path.
   */
  private async stageBundleCache(installDir: string): Promise<string> {
    const parent = path.dirname(installDir);
    const base = path.basename(installDir);
    const leftovers = fs.existsSync(parent)
      ? (await readdir(parent)).filter((name) => name.startsWith(`${base}.staging-`) || name.startsWith(`${base}.old-`))
      : [];
    for (const leftover of leftovers) {
      const leftoverPath = path.join(parent, leftover);
      const stats = await lstat(leftoverPath).catch(() => undefined);
      if (stats === undefined || Date.now() - stats.mtimeMs < CACHE_LEFTOVER_STALE_MS) {
        continue;
      }
      await fs.promises.rm(leftoverPath, { recursive: true, force: true }).catch((error: unknown) => {
        this.logger.debug(`Could not remove leftover cache directory ${leftover}: ${String(error)}`);
      });
    }
    return `${installDir}.staging-${randomBytes(4).toString('hex')}`;
  }

  /**
   * Swap the staged cache in: the current cache moves aside, the staging
   * directory takes its place, the old one is removed. On failure the old
   * cache is restored and the staging directory removed.
   * @param stagingDir - Staging directory.
   * @param installDir - Bundle cache directory.
   * @param bundleName - Bundle name for the error message.
   * @throws {Error} when the cache cannot be swapped.
   */
  private async commitBundleCache(stagingDir: string, installDir: string, bundleName: string): Promise<void> {
    const oldDir = fs.existsSync(installDir) ? `${installDir}.old-${randomBytes(4).toString('hex')}` : undefined;
    try {
      if (oldDir !== undefined) {
        await renameWithRetry(installDir, oldDir);
      }
      try {
        await renameWithRetry(stagingDir, installDir);
      } catch (error) {
        if (oldDir !== undefined) {
          await renameWithRetry(oldDir, installDir).catch((restoreError: unknown) => {
            this.logger.warn(`Could not restore the bundle cache ${installDir}: ${String(restoreError)}`);
          });
        }
        throw error;
      }
    } catch (error) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Installed "${bundleName}" but could not update its cache (${message}); reinstall the bundle`);
    }
    if (oldDir !== undefined) {
      await fs.promises.rm(oldDir, { recursive: true, force: true }).catch((error: unknown) => {
        this.logger.warn(`Could not remove the previous bundle cache ${oldDir}: ${String(error)}`);
      });
    }
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
   */
  public async installFromBuffer(
    bundle: Bundle,
    bundleBuffer: Buffer,
    options: InstallOptions,
    sourceType?: string
  ): Promise<InstalledBundle> {
    return this.installBuffer(bundle, bundleBuffer, options, sourceType);
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
      // At repository scope the shared uninstall also removes the lockfile entry.
      const scopeService = this.getScopeService(installed.scope);
      await scopeService.unsyncBundle(installed.bundleId, { scope: installed.scope });
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
      const resolvedSourceType = sourceType ?? installed.sourceType;

      if (installed.scope === 'repository') {
        // Check the new version against the host before removing the
        // installed one, so a rejected update changes nothing.
        const updated = await this.installBuffer(
          bundle,
          bundleBuffer,
          { scope: installed.scope, version: bundle.version, commitMode: installed.commitMode },
          resolvedSourceType,
          async (scopeService, syncOptions) => {
            await scopeService.preflightBundle?.(bundle.id, syncOptions);
            await this.uninstall(installed);
          }
        );
        this.logger.info('Bundle updated successfully');
        return updated;
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
