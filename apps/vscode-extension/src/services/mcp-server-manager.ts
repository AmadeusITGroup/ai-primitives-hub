import * as path from 'node:path';
import * as fs from 'fs-extra';
import {
  McpConfiguration,
  McpInstallOptions,
  McpInstallResult,
  McpServerConfig,
  McpServersManifest,
  McpTrackingMetadata,
  McpUninstallResult,
  McpWorkspaceInstallOptions,
  VSCodeMcpInputDefinition,
} from '../types/mcp';
import {
  detectHostApp,
} from '../utils/host-app';
import {
  Logger,
} from '../utils/logger';
import {
  parseMcpConfig,
  serializeMcpConfig,
} from '../utils/mcp-config-format';
import type {
  McpConfigLocation,
} from '../utils/mcp-config-locator';
import {
  McpConfigLocator,
} from '../utils/mcp-config-locator';
import {
  McpConfigService,
} from './mcp-config-service';

export class McpServerManager {
  // ===== Repository Scope Methods =====

  /**
   * Section header for AI Primitives Hub entries in .git/info/exclude
   */
  private static readonly GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';
  private readonly logger: Logger;
  private readonly configService: McpConfigService;

  constructor() {
    this.logger = Logger.getInstance();
    this.configService = new McpConfigService();
  }

  /**
   * Describe servers that reference `${input:id}` when the host cannot resolve inputs.
   *
   * `inputs` and `${input:...}` are a VS Code Copilot feature. Other hosts receive the
   * placeholder as a literal value, so the server needs manual configuration after
   * installation. The caller surfaces this message as a warning while still writing
   * the server configuration.
   *
   * Returns `null` when no warning is needed, or a message describing what to do.
   * @param servers - Servers about to be installed.
   * @param supportsInputs - Whether the resolved host/scope resolves inputs.
   */
  private describeUnsupportedInputs(
    servers: Record<string, McpServerConfig>,
    supportsInputs: boolean
  ): string | null {
    if (supportsInputs) {
      return null;
    }
    const referenced = this.configService.collectInputReferences(servers);
    if (referenced.size === 0) {
      return null;
    }
    const ids = [...referenced].toSorted().join(', ');
    return `require the input value(s) ${ids}. `
      + 'Set the value(s) directly in the MCP configuration file after installing.';
  }

  /**
   * Re-enable duplicate servers after the original active server is removed.
   * This ensures at least one server remains active when duplicates exist.
   * @param scope
   * @param removedServerNames
   */
  private async reEnableDuplicatesAfterRemoval(
    scope: 'user' | 'workspace',
    removedServerNames: string[]
  ): Promise<void> {
    try {
      const config = await this.configService.readMcpConfig(scope);
      let needsUpdate = false;

      // Find disabled servers that were duplicates of the removed servers
      for (const serverConfig of Object.values(config.servers)) {
        if (serverConfig.disabled && serverConfig.description?.includes('Duplicate of')) {
          const match = serverConfig.description.match(/Duplicate of ([^\s(]+)/);
          if (match && removedServerNames.includes(match[1])) {
            serverConfig.disabled = false;
            delete serverConfig.description;
            needsUpdate = true;
          }
        }
      }

      if (needsUpdate) {
        // Re-run duplicate detection to ensure only one is active per identity
        const { duplicatesDisabled, config: deduplicatedConfig } = await this.configService.detectAndDisableDuplicates(scope);
        await this.configService.writeMcpConfig(deduplicatedConfig, scope, false);

        if (duplicatesDisabled.length > 0) {
          this.logger.info(`Re-enabled and re-evaluated duplicates: ${duplicatesDisabled.length} still disabled`);
        } else {
          this.logger.info(`Re-enabled duplicate servers after removal`);
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to re-enable duplicates after removal: ${(error as Error).message}`);
    }
  }

  /**
   * Git-exclude pattern for the workspace MCP config file, relative to the
   * workspace root.
   *
   * Derived from the resolved config path rather than reassembling a folder plus a
   * hardcoded `mcp.json`, so hosts whose file is named differently (Claude Code's
   * root-level `.mcp.json`) are excluded correctly.
   *
   * Separators are forced to `/`: git exclude patterns require forward slashes and
   * treat `\` as an escape, so a Windows path would silently fail to match and the
   * config would be committed despite local-only mode.
   * @param workspaceRoot - Absolute workspace root.
   */
  private getWorkspaceMcpExcludePattern(workspaceRoot: string): string {
    const configPath = this.getWorkspaceMcpLocation(workspaceRoot).configPath;
    return path.relative(workspaceRoot, configPath).split(path.sep).join('/');
  }

  /**
   * Resolve the repository-scope MCP config location for a workspace.
   * Throws when the host IDE has no workspace-level MCP file, rather than
   * silently falling back to the user config.
   * @param workspaceRoot - Absolute workspace root.
   */
  private getWorkspaceMcpLocation(workspaceRoot: string): McpConfigLocation {
    const location = McpConfigLocator.getMcpConfigLocation('repository', detectHostApp(), workspaceRoot);
    if (!location) {
      throw new Error(
        'This IDE has no workspace-level MCP configuration file. Install to user scope instead.'
      );
    }
    return location;
  }

  /**
   * Get the path to the workspace MCP config file.
   * The filename comes from default-layouts.json, so hosts whose file is not
   * called `mcp.json` (e.g. Claude Code's root-level `.mcp.json`) resolve correctly.
   * @param workspaceRoot
   */
  private getWorkspaceMcpConfigPath(workspaceRoot: string): string {
    return this.getWorkspaceMcpLocation(workspaceRoot).configPath;
  }

  /**
   * Get the path to tracking metadata in a workspace
   * @param workspaceRoot
   */
  private getWorkspaceTrackingPath(workspaceRoot: string): string {
    return this.getWorkspaceMcpLocation(workspaceRoot).trackingPath;
  }

  /**
   * Get the path to .git/info/exclude
   * @param workspaceRoot
   */
  private getGitExcludePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.git', 'info', 'exclude');
  }

  /**
   * Check if .git directory exists in workspace
   * @param workspaceRoot
   */
  private hasGitDirectory(workspaceRoot: string): boolean {
    return fs.existsSync(path.join(workspaceRoot, '.git'));
  }

  /**
   * Read MCP configuration from workspace mcp.json (handles both VS Code 'servers' and Kiro 'mcpServers' formats)
   * @param workspaceRoot
   */
  private async readWorkspaceMcpConfig(workspaceRoot: string): Promise<McpConfiguration> {
    // Resolve once: the location carries both the path and the server key.
    const location = this.getWorkspaceMcpLocation(workspaceRoot);
    const configPath = location.configPath;

    if (!await fs.pathExists(configPath)) {
      return { servers: {} };
    }

    try {
      const content = await fs.readFile(configPath, 'utf8');
      // Shared parse + normalize (see utils/mcp-config-format). Uses the JSONC
      // parser: workspace mcp.json files may legitimately contain comments and
      // trailing commas, which plain JSON.parse rejects.
      const { config, warnings } = parseMcpConfig(content, location.serversKey);
      if (warnings.length > 0) {
        this.logger.warn(`JSONC parse warnings in ${configPath}: ${warnings.join(', ')}`);
      }
      return config;
    } catch (error) {
      this.logger.error(`Failed to read workspace mcp.json from ${configPath}`, error as Error);
      throw new Error(`Failed to read workspace MCP configuration: ${(error as Error).message}`);
    }
  }

  /**
   * Write MCP configuration to workspace .vscode/mcp.json
   * @param workspaceRoot
   * @param config
   * @param createBackup
   */
  private async writeWorkspaceMcpConfig(workspaceRoot: string, config: McpConfiguration, createBackup = true): Promise<void> {
    // Resolve once: the location carries both the path and the server key.
    const location = this.getWorkspaceMcpLocation(workspaceRoot);
    const configPath = location.configPath;
    const configDir = path.dirname(configPath);

    // Ensure .vscode directory exists
    await fs.ensureDir(configDir);

    // Create backup if requested and file exists
    if (createBackup && await fs.pathExists(configPath)) {
      const backupPath = configPath + '.backup';
      try {
        await fs.copyFile(configPath, backupPath);
        this.logger.debug(`Created backup at ${backupPath}`);
      } catch (error) {
        this.logger.warn(`Failed to create backup: ${(error as Error).message}`);
      }
    }

    try {
      // Serialize using the IDE-specific top-level key ('servers' for VS Code, 'mcpServers' for Kiro etc.)
      // The key comes from default-layouts.json via McpConfigLocator.
      const serialized = serializeMcpConfig(config, location.serversKey);
      const content = JSON.stringify(serialized, null, 2);
      await fs.writeFile(configPath, content, 'utf8');
      this.logger.info(`Workspace MCP configuration written to ${configPath}`);
    } catch (error) {
      this.logger.error(`Failed to write workspace mcp.json to ${configPath}`, error as Error);
      throw new Error(`Failed to write workspace MCP configuration: ${(error as Error).message}`);
    }
  }

  /**
   * Read tracking metadata from workspace
   * @param workspaceRoot
   */
  private async readWorkspaceTrackingMetadata(workspaceRoot: string): Promise<McpTrackingMetadata> {
    const trackingPath = this.getWorkspaceTrackingPath(workspaceRoot);

    if (!await fs.pathExists(trackingPath)) {
      return {
        managedServers: {},
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };
    }

    try {
      const content = await fs.readFile(trackingPath, 'utf8');
      return JSON.parse(content) as McpTrackingMetadata;
    } catch (error) {
      this.logger.error(`Failed to read workspace tracking metadata from ${trackingPath}`, error as Error);
      throw new Error(`Failed to read workspace tracking metadata: ${(error as Error).message}`);
    }
  }

  /**
   * Write tracking metadata to workspace
   * @param workspaceRoot
   * @param metadata
   */
  private async writeWorkspaceTrackingMetadata(workspaceRoot: string, metadata: McpTrackingMetadata): Promise<void> {
    const trackingPath = this.getWorkspaceTrackingPath(workspaceRoot);
    const trackingDir = path.dirname(trackingPath);

    await fs.ensureDir(trackingDir);

    metadata.lastUpdated = new Date().toISOString();

    try {
      const content = JSON.stringify(metadata, null, 2);
      await fs.writeFile(trackingPath, content, 'utf8');
      this.logger.debug(`Workspace tracking metadata written to ${trackingPath}`);
    } catch (error) {
      this.logger.error(`Failed to write workspace tracking metadata to ${trackingPath}`, error as Error);
      throw new Error(`Failed to write workspace tracking metadata: ${(error as Error).message}`);
    }
  }

  /**
   * Add path to .git/info/exclude under the AI Primitives Hub section
   * @param workspaceRoot
   * @param pathToExclude
   */
  private async addToGitExclude(workspaceRoot: string, pathToExclude: string): Promise<void> {
    if (!this.hasGitDirectory(workspaceRoot)) {
      this.logger.warn('[McpServerManager] No .git directory found, skipping git exclude');
      return;
    }

    try {
      const excludePath = this.getGitExcludePath(workspaceRoot);

      // Ensure .git/info directory exists
      await fs.ensureDir(path.dirname(excludePath));

      // Read existing content
      let content = '';
      if (await fs.pathExists(excludePath)) {
        content = await fs.readFile(excludePath, 'utf8');
      }

      // Check if path is already excluded
      if (content.includes(pathToExclude)) {
        this.logger.debug(`[McpServerManager] Path already in git exclude: ${pathToExclude}`);
        return;
      }

      // Find or create our section
      const sectionHeader = McpServerManager.GIT_EXCLUDE_SECTION_HEADER;
      const sectionIndex = content.indexOf(sectionHeader);

      if (sectionIndex === -1) {
        // Add new section at the end
        const newContent = content.trimEnd()
          + (content.length > 0 ? '\n\n' : '')
          + sectionHeader + '\n'
          + pathToExclude + '\n';
        await fs.writeFile(excludePath, newContent, 'utf8');
      } else {
        // Add to existing section
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

        // Parse existing entries and add new one
        const existingEntries = new Set(
          sectionContent.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
        );
        existingEntries.add(pathToExclude);

        // Rebuild content
        const newSectionContent = Array.from(existingEntries).join('\n');
        const newContent = beforeSection.trimEnd()
          + (beforeSection.length > 0 ? '\n\n' : '')
          + sectionHeader + '\n'
          + newSectionContent + '\n'
          + afterSection;

        await fs.writeFile(excludePath, newContent.trim() + '\n', 'utf8');
      }

      this.logger.debug(`[McpServerManager] Added ${pathToExclude} to git exclude`);
    } catch (error) {
      this.logger.warn(`[McpServerManager] Failed to update git exclude: ${error}`);
      // Don't throw - git exclude is optional
    }
  }

  /**
   * Remove path from .git/info/exclude
   * @param workspaceRoot
   * @param pathToRemove
   */
  private async removeFromGitExclude(workspaceRoot: string, pathToRemove: string): Promise<void> {
    if (!this.hasGitDirectory(workspaceRoot)) {
      return;
    }

    try {
      const excludePath = this.getGitExcludePath(workspaceRoot);
      if (!await fs.pathExists(excludePath)) {
        return;
      }

      const content = await fs.readFile(excludePath, 'utf8');

      // Find our section
      const sectionHeader = McpServerManager.GIT_EXCLUDE_SECTION_HEADER;
      const sectionIndex = content.indexOf(sectionHeader);
      if (sectionIndex === -1) {
        return;
      }

      const beforeSection = content.substring(0, sectionIndex);
      const afterHeaderIndex = sectionIndex + sectionHeader.length;
      const remainingContent = content.substring(afterHeaderIndex);

      // Find the end of our section
      const nextSectionMatch = remainingContent.match(/\n#[^\n]+/);
      let sectionContent: string;
      let afterSection = '';

      if (nextSectionMatch && nextSectionMatch.index !== undefined) {
        sectionContent = remainingContent.substring(0, nextSectionMatch.index);
        afterSection = remainingContent.substring(nextSectionMatch.index);
      } else {
        sectionContent = remainingContent;
      }

      // Parse and filter entries
      const remainingEntries = sectionContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== pathToRemove);

      // Rebuild content
      const newContent: string = remainingEntries.length === 0
        ? beforeSection.trimEnd() + afterSection
        : beforeSection.trimEnd()
          + (beforeSection.length > 0 ? '\n\n' : '')
          + sectionHeader + '\n'
          + remainingEntries.join('\n') + '\n'
          + afterSection;

      await fs.writeFile(excludePath, newContent.trim() + '\n', 'utf8');
      this.logger.debug(`[McpServerManager] Removed ${pathToRemove} from git exclude`);
    } catch (error) {
      this.logger.warn(`[McpServerManager] Failed to update git exclude: ${error}`);
    }
  }

  public async installServers(
    bundleId: string,
    bundleVersion: string,
    bundlePath: string,
    serversManifest: McpServersManifest,
    options: McpInstallOptions,
    inputsManifest?: VSCodeMcpInputDefinition[]
  ): Promise<McpInstallResult> {
    const result: McpInstallResult = {
      success: false,
      serversInstalled: 0,
      installedServers: [],
      errors: [],
      warnings: []
    };

    try {
      if (Object.keys(serversManifest).length === 0) {
        this.logger.debug(`No MCP servers to install for bundle ${bundleId}`);
        result.success = true;
        return result;
      }

      this.logger.info(`Installing ${Object.keys(serversManifest).length} MCP servers for bundle ${bundleId}`);

      const existingConfig = await this.configService.readMcpConfig(options.scope);
      const tracking = await this.configService.readTrackingMetadata(options.scope);

      const serversToInstall: Record<string, any> = {};

      for (const [serverName, definition] of Object.entries(serversManifest)) {
        const prefixedName = this.configService.generatePrefixedServerName(bundleId, serverName);

        const serverConfig = this.configService.processServerDefinition(
          serverName,
          definition,
          bundleId,
          bundleVersion,
          bundlePath
        );

        serversToInstall[prefixedName] = serverConfig;

        tracking.managedServers[prefixedName] = {
          bundleId,
          bundleVersion,
          originalName: serverName,
          originalConfig: definition,
          installedAt: new Date().toISOString(),
          scope: options.scope
        };
      }

      const location = McpConfigLocator.getMcpConfigLocation(
        options.scope === 'workspace' ? 'repository' : 'user'
      );
      // See the note in installServersToWorkspace: hosts that cannot resolve
      // `${input:id}` still get the server written, with a warning instead of a hard
      // failure, so the user can supply the value manually.
      const supportsInputs = location?.supportsInputs ?? false;
      const unsupportedInputs = this.describeUnsupportedInputs(serversToInstall, supportsInputs);
      if (unsupportedInputs) {
        result.warnings?.push(unsupportedInputs);
      }

      const mergeResult = await this.configService.mergeServers(
        existingConfig,
        serversToInstall,
        options,
        inputsManifest,
        supportsInputs
      );

      result.warnings?.push(...mergeResult.warnings);

      if (mergeResult.conflicts.length > 0 && !options.skipOnConflict && !options.overwrite) {
        result.errors?.push(`Conflicts detected: ${mergeResult.conflicts.join(', ')}`);
        result.success = false;
        return result;
      }

      await this.configService.writeMcpConfig(mergeResult.config, options.scope, options.createBackup !== false);
      await this.configService.writeTrackingMetadata(tracking, options.scope);

      // Detect and disable duplicate servers across all bundles
      const { duplicatesDisabled, config: deduplicatedConfig } = await this.configService.detectAndDisableDuplicates(options.scope);
      if (duplicatesDisabled.length > 0) {
        await this.configService.writeMcpConfig(deduplicatedConfig, options.scope, false);
        const duplicateNames = duplicatesDisabled.map((d) => d.serverName).join(', ');
        result.warnings?.push(`Disabled ${duplicatesDisabled.length} duplicate server(s): ${duplicateNames}`);
        this.logger.info(`Disabled ${duplicatesDisabled.length} duplicate MCP servers: ${duplicateNames}`);
      }

      result.serversInstalled = Object.keys(serversToInstall).length - mergeResult.conflicts.length;
      result.installedServers = Object.keys(serversToInstall).filter(
        (name) => !mergeResult.conflicts.includes(name)
      );
      result.success = true;

      this.logger.info(`Successfully installed ${result.serversInstalled} MCP servers for bundle ${bundleId}`);
    } catch (error) {
      this.logger.error(`Failed to install MCP servers for bundle ${bundleId}`, error as Error);
      result.errors?.push((error as Error).message);
      result.success = false;
    }

    return result;
  }

  public async uninstallServers(
    bundleId: string,
    scope: 'user' | 'workspace'
  ): Promise<McpUninstallResult> {
    const result: McpUninstallResult = {
      success: false,
      serversRemoved: 0,
      removedServers: [],
      errors: []
    };

    try {
      this.logger.info(`Uninstalling MCP servers for bundle ${bundleId}`);

      const removedServers = await this.configService.removeServersForBundle(bundleId, scope);

      result.serversRemoved = removedServers.length;
      result.removedServers = removedServers;
      result.success = true;

      if (removedServers.length === 0) {
        this.logger.debug(`No MCP servers found for bundle ${bundleId}`);
      } else {
        this.logger.info(`Successfully uninstalled ${removedServers.length} MCP servers for bundle ${bundleId}`);

        // Re-enable duplicates that were disabled due to the removed servers
        await this.reEnableDuplicatesAfterRemoval(scope, removedServers);
      }
    } catch (error) {
      this.logger.error(`Failed to uninstall MCP servers for bundle ${bundleId}`, error as Error);
      result.errors?.push((error as Error).message);
      result.success = false;
    }

    return result;
  }

  /**
   * Install MCP servers to a workspace (repository scope)
   * @param bundleId - Bundle identifier
   * @param bundleVersion - Bundle version
   * @param workspaceRoot - Path to workspace root
   * @param serversManifest - MCP servers to install
   * @param options - Installation options including commitMode
   * @param inputsManifest
   */
  public async installServersToWorkspace(
    bundleId: string,
    bundleVersion: string,
    workspaceRoot: string,
    serversManifest: McpServersManifest,
    options: McpWorkspaceInstallOptions,
    inputsManifest?: VSCodeMcpInputDefinition[]
  ): Promise<McpInstallResult> {
    const result: McpInstallResult = {
      success: false,
      serversInstalled: 0,
      installedServers: [],
      errors: [],
      warnings: []
    };

    try {
      if (Object.keys(serversManifest).length === 0) {
        this.logger.debug(`No MCP servers to install for bundle ${bundleId}`);
        result.success = true;
        return result;
      }

      this.logger.info(`Installing ${Object.keys(serversManifest).length} MCP servers for bundle ${bundleId} to workspace`);

      const existingConfig = await this.readWorkspaceMcpConfig(workspaceRoot);
      const tracking = await this.readWorkspaceTrackingMetadata(workspaceRoot);

      const serversToInstall: Record<string, any> = {};
      const conflicts: string[] = [];

      for (const [serverName, definition] of Object.entries(serversManifest)) {
        const prefixedName = this.configService.generatePrefixedServerName(bundleId, serverName);

        // Check for conflicts
        if (existingConfig.servers[prefixedName]) {
          if (options.overwrite) {
            result.warnings?.push(`Overwriting existing server: ${prefixedName}`);
          } else if (options.skipOnConflict) {
            result.warnings?.push(`Skipping conflicting server: ${prefixedName}`);
            continue;
          } else {
            conflicts.push(prefixedName);
            continue;
          }
        }

        const serverConfig = this.configService.processServerDefinition(
          serverName,
          definition,
          bundleId,
          bundleVersion,
          workspaceRoot
        );

        serversToInstall[prefixedName] = serverConfig;

        tracking.managedServers[prefixedName] = {
          bundleId,
          bundleVersion,
          originalName: serverName,
          originalConfig: definition,
          installedAt: new Date().toISOString(),
          scope: 'workspace'
        };
      }

      // Check for unresolved conflicts
      if (conflicts.length > 0 && !options.skipOnConflict && !options.overwrite) {
        result.errors?.push(`Conflicts detected: ${conflicts.join(', ')}`);
        result.success = false;
        return result;
      }

      // Hosts that cannot resolve `${input:id}` (e.g. Kiro) still get the server
      // written, because a present-but-unconfigured server is more useful than no
      // server at all — the user can fill the value in directly. We surface a warning
      // so they know the manual step is required.
      const supportsInputs = this.getWorkspaceMcpLocation(workspaceRoot).supportsInputs;
      const unsupportedInputs = this.describeUnsupportedInputs(serversToInstall, supportsInputs);
      if (unsupportedInputs) {
        result.warnings?.push(unsupportedInputs);
      }

      // Merge servers into existing config
      // Spread `existingConfig` first so unrelated top-level state in the host's file
      // survives the merge. See the equivalent note in McpConfigService.mergeServers.
      // Do not add bundle input declarations on hosts that cannot resolve them.
      // Preserve any existing declarations as part of the host config round-trip.
      const mergedInputs = supportsInputs
        ? this.configService.mergeInputs(existingConfig.inputs, inputsManifest)
        : existingConfig.inputs;

      // Auto-derive missing input declarations from ${input:id} references in the
      // newly-installed servers, using the shared helper in McpConfigService.
      // Skipped when the host does not resolve inputs: the declaration would be dead
      // weight in the file and can mislead the user into thinking a prompt will appear.
      let finalInputs = mergedInputs;
      if (supportsInputs) {
        const { inputs: derivedInputs, warnings: derivedWarnings } =
          this.configService.autoDeriveMissingInputs(serversToInstall, mergedInputs);
        finalInputs = derivedInputs;
        for (const w of derivedWarnings) {
          this.logger.warn(w);
        }
        result.warnings?.push(...derivedWarnings);
      }

      const mergedConfig: McpConfiguration = {
        ...existingConfig,
        servers: { ...existingConfig.servers, ...serversToInstall },
        tasks: existingConfig.tasks,
        inputs: finalInputs
      };

      // Write config and tracking
      await this.writeWorkspaceMcpConfig(workspaceRoot, mergedConfig, options.createBackup !== false);
      await this.writeWorkspaceTrackingMetadata(workspaceRoot, tracking);

      // Handle git exclude for local-only mode
      if (options.commitMode === 'local-only') {
        await this.addToGitExclude(workspaceRoot, this.getWorkspaceMcpExcludePattern(workspaceRoot));
      }

      result.serversInstalled = Object.keys(serversToInstall).length;
      result.installedServers = Object.keys(serversToInstall);
      result.success = true;

      this.logger.info(`Successfully installed ${result.serversInstalled} MCP servers for bundle ${bundleId} to workspace`);
    } catch (error) {
      this.logger.error(`Failed to install MCP servers for bundle ${bundleId} to workspace`, error as Error);
      result.errors?.push((error as Error).message);
      result.success = false;
    }

    return result;
  }

  /**
   * Uninstall MCP servers from a workspace (repository scope)
   * @param bundleId - Bundle identifier
   * @param workspaceRoot - Path to workspace root
   */
  public async uninstallServersFromWorkspace(
    bundleId: string,
    workspaceRoot: string
  ): Promise<McpUninstallResult> {
    const result: McpUninstallResult = {
      success: false,
      serversRemoved: 0,
      removedServers: [],
      errors: []
    };

    try {
      this.logger.info(`Uninstalling MCP servers for bundle ${bundleId} from workspace`);

      const config = await this.readWorkspaceMcpConfig(workspaceRoot);
      const tracking = await this.readWorkspaceTrackingMetadata(workspaceRoot);
      const removedServers: string[] = [];

      // Find and remove servers for this bundle
      for (const [serverName, metadata] of Object.entries(tracking.managedServers)) {
        if (metadata.bundleId === bundleId) {
          if (config.servers[serverName]) {
            delete config.servers[serverName];
            removedServers.push(serverName);
          }
          delete tracking.managedServers[serverName];
        }
      }

      if (removedServers.length > 0) {
        const cleanedConfig = this.configService.removeOrphanedInputs(config);
        await this.writeWorkspaceMcpConfig(workspaceRoot, cleanedConfig, true);
        await this.writeWorkspaceTrackingMetadata(workspaceRoot, tracking);
        this.logger.info(`Removed ${removedServers.length} MCP servers for bundle ${bundleId} from workspace`);
      } else {
        this.logger.debug(`No MCP servers found for bundle ${bundleId} in workspace`);
      }

      // Check if we should clean up git exclude
      // Only remove from git exclude if no more managed servers exist
      const hasRemainingManagedServers = Object.keys(tracking.managedServers).length > 0;
      if (!hasRemainingManagedServers) {
        await this.removeFromGitExclude(workspaceRoot, this.getWorkspaceMcpExcludePattern(workspaceRoot));
      }

      result.serversRemoved = removedServers.length;
      result.removedServers = removedServers;
      result.success = true;
    } catch (error) {
      this.logger.error(`Failed to uninstall MCP servers for bundle ${bundleId} from workspace`, error as Error);
      result.errors?.push((error as Error).message);
      result.success = false;
    }

    return result;
  }
}
