import type {
  McpConfigScope,
} from '@ai-primitives-hub/app';
import {
  autoDeriveMissingInputs,
  mergeInputDeclarations,
} from '@ai-primitives-hub/app';
import {
  collectInputReferences,
} from '@ai-primitives-hub/core';
import * as fs from 'fs-extra';
import {
  isRemoteServerConfig,
  McpConfiguration,
  McpInstallOptions,
  McpRemoteServerConfig,
  McpServerConfig,
  McpServerDefinition,
  McpStdioServerConfig,
  McpTrackingMetadata,
  McpVariableContext,
  VSCodeMcpInputDefinition,
} from '../types/mcp';
import {
  Logger,
} from '../utils/logger';
import {
  parseMcpConfig,
  serializeMcpConfig,
} from '../utils/mcp-config-format';
import {
  McpConfigLocator,
} from '../utils/mcp-config-locator';

/**
 * Information about a duplicate server that was disabled
 */
export interface DuplicateInfo {
  serverName: string;
  duplicateOf: string;
  bundleId: string;
  originalBundleId: string;
}

export class McpConfigService {
  private static readonly BACKUP_SUFFIX = '.backup';
  private static readonly SCHEMA_VERSION = '1.0.0';
  private readonly logger: Logger;

  constructor() {
    this.logger = Logger.getInstance();
  }

  /**
   * Process a stdio (local process) server definition with variable substitution
   * @param definition
   * @param context
   */
  private processStdioServerDefinition(
    definition: McpStdioServerConfig,
    context: McpVariableContext
  ): McpStdioServerConfig {
    return {
      type: definition.type,
      command: this.substituteVariables(definition.command, context)!,
      args: definition.args?.map((arg) => this.substituteVariables(arg, context)!),
      env: definition.env
        ? Object.fromEntries(
          Object.entries(definition.env).map(([k, v]) => [
            k,
            this.substituteVariables(v, context)!
          ])
        )
        : undefined,
      envFile: this.substituteVariables(definition.envFile, context),
      disabled: definition.disabled,
      description: definition.description
    };
  }

  /**
   * Process a remote (HTTP/SSE) server definition with variable substitution
   * @param definition
   * @param context
   */
  private processRemoteServerDefinition(
    definition: McpRemoteServerConfig,
    context: McpVariableContext
  ): McpRemoteServerConfig {
    return {
      type: definition.type,
      url: this.substituteVariables(definition.url, context)!,
      headers: definition.headers
        ? Object.fromEntries(
          Object.entries(definition.headers).map(([k, v]) => [
            k,
            this.substituteVariables(v, context)!
          ])
        )
        : undefined,
      disabled: definition.disabled,
      description: definition.description
    };
  }

  private async createBackup(configPath: string): Promise<void> {
    const backupPath = configPath + McpConfigService.BACKUP_SUFFIX;
    try {
      await fs.copyFile(configPath, backupPath);
      this.logger.debug(`Created backup at ${backupPath}`);
    } catch (error) {
      this.logger.warn(`Failed to create backup: ${(error as Error).message}`);
    }
  }

  /**
   * Map this service's scope vocabulary onto the layout config's scopes.
   * The layout file uses `repository` for what this service calls `workspace`.
   * @param scope - Service-level scope.
   */
  private static toLayoutScope(scope: 'user' | 'workspace'): McpConfigScope {
    return scope === 'workspace' ? 'repository' : 'user';
  }

  public async readMcpConfig(scope: 'user' | 'workspace'): Promise<McpConfiguration> {
    const location = McpConfigLocator.getMcpConfigLocation(McpConfigService.toLayoutScope(scope));
    if (!location) {
      throw new Error(`Cannot determine ${scope}-level configuration path`);
    }

    if (!location.exists) {
      return { servers: {} };
    }

    try {
      const content = await fs.readFile(location.configPath, 'utf8');
      // Shared parse + normalize: tolerates JSONC (comments, trailing commas),
      // maps the IDE's server key onto the internal 'servers' key and drops the
      // non-canonical one. See utils/mcp-config-format.
      const { config, warnings } = parseMcpConfig(content, location.serversKey);
      if (warnings.length > 0) {
        this.logger.warn(`JSONC parse warnings in ${location.configPath}: ${warnings.join(', ')}`);
      }
      return config;
    } catch (error) {
      this.logger.error(`Failed to read mcp.json from ${location.configPath}`, error as Error);
      throw new Error(`Failed to read MCP configuration: ${(error as Error).message}`);
    }
  }

  public async writeMcpConfig(config: McpConfiguration, scope: 'user' | 'workspace', createBackup = true): Promise<void> {
    const layoutScope = McpConfigService.toLayoutScope(scope);
    const location = McpConfigLocator.getMcpConfigLocation(layoutScope);
    if (!location) {
      throw new Error(`Cannot determine ${scope}-level configuration path`);
    }

    await McpConfigLocator.ensureConfigDirectory(layoutScope);

    if (createBackup && location.exists) {
      await this.createBackup(location.configPath);
    }

    try {
      // Serialize using the IDE-specific top-level key ('servers' for VS Code, 'mcpServers' for Kiro etc.)
      // The mapping itself comes from default-layouts.json via McpConfigLocator,
      // so adding an IDE needs no change here.
      const serialized = serializeMcpConfig(config, location.serversKey);
      const content = JSON.stringify(serialized, null, 2);
      await fs.writeFile(location.configPath, content, 'utf8');
      this.logger.info(`MCP configuration written to ${location.configPath}`);
    } catch (error) {
      this.logger.error(`Failed to write mcp.json to ${location.configPath}`, error as Error);
      throw new Error(`Failed to write MCP configuration: ${(error as Error).message}`);
    }
  }

  public async readTrackingMetadata(scope: 'user' | 'workspace'): Promise<McpTrackingMetadata> {
    const location = McpConfigLocator.getMcpConfigLocation(McpConfigService.toLayoutScope(scope));
    if (!location) {
      throw new Error(`Cannot determine ${scope}-level configuration path`);
    }

    if (!await fs.pathExists(location.trackingPath)) {
      return {
        managedServers: {},
        lastUpdated: new Date().toISOString(),
        version: McpConfigService.SCHEMA_VERSION
      };
    }

    try {
      const content = await fs.readFile(location.trackingPath, 'utf8');
      return JSON.parse(content) as McpTrackingMetadata;
    } catch (error) {
      this.logger.error(`Failed to read tracking metadata from ${location.trackingPath}`, error as Error);
      throw new Error(`Failed to read tracking metadata: ${(error as Error).message}`);
    }
  }

  public async writeTrackingMetadata(metadata: McpTrackingMetadata, scope: 'user' | 'workspace'): Promise<void> {
    const layoutScope = McpConfigService.toLayoutScope(scope);
    const location = McpConfigLocator.getMcpConfigLocation(layoutScope);
    if (!location) {
      throw new Error(`Cannot determine ${scope}-level configuration path`);
    }

    await McpConfigLocator.ensureConfigDirectory(layoutScope);

    metadata.lastUpdated = new Date().toISOString();

    try {
      const content = JSON.stringify(metadata, null, 2);
      await fs.writeFile(location.trackingPath, content, 'utf8');
      this.logger.debug(`Tracking metadata written to ${location.trackingPath}`);
    } catch (error) {
      this.logger.error(`Failed to write tracking metadata to ${location.trackingPath}`, error as Error);
      throw new Error(`Failed to write tracking metadata: ${(error as Error).message}`);
    }
  }

  public generatePrefixedServerName(bundleId: string, serverName: string): string {
    return `prompt-registry:${bundleId}:${serverName}`;
  }

  public substituteVariables(value: string | undefined, context: McpVariableContext): string | undefined {
    if (!value) {
      return value;
    }

    let result = value;
    result = result.replace(/\$\{bundlePath\}/g, context.bundlePath);
    result = result.replace(/\$\{bundleId\}/g, context.bundleId);
    result = result.replace(/\$\{bundleVersion\}/g, context.bundleVersion);

    const envRegex = /\$\{env:([^}]+)\}/g;
    result = result.replace(envRegex, (_, envVar) => {
      return context.env[envVar] || process.env[envVar] || '';
    });

    return result;
  }

  public processServerDefinition(
    serverName: string,
    definition: McpServerDefinition,
    bundleId: string,
    bundleVersion: string,
    bundlePath: string
  ): McpServerConfig {
    const context: McpVariableContext = {
      bundlePath,
      bundleId,
      bundleVersion,
      env: process.env as Record<string, string>
    };

    // Use type guards to properly handle stdio vs remote servers
    return isRemoteServerConfig(definition) ? this.processRemoteServerDefinition(definition, context) : this.processStdioServerDefinition(definition, context);
  }

  /**
   * Compute a unique identity string for a server configuration.
   * Used for duplicate detection - servers with the same identity are considered duplicates.
   *
   * For stdio servers: identity is based on command + args
   * For remote servers: identity is based on URL
   * @param config
   */
  public computeServerIdentity(config: McpServerConfig): string {
    if (isRemoteServerConfig(config)) {
      return `remote:${config.url}`;
    } else {
      const stdioConfig = config;
      const argsStr = stdioConfig.args?.join('|') || '';
      return `stdio:${stdioConfig.command}:${argsStr}`;
    }
  }

  /**
   * Detect and disable duplicate MCP servers across all managed bundles.
   *
   * Two servers are considered duplicates if they have the same identity:
   * - Stdio servers: same command + args
   * - Remote servers: same URL
   *
   * The first enabled server encountered is kept enabled, subsequent duplicates are disabled.
   * @param scope
   */
  public async detectAndDisableDuplicates(
    scope: 'user' | 'workspace'
  ): Promise<{ duplicatesDisabled: DuplicateInfo[]; config: McpConfiguration }> {
    const config = await this.readMcpConfig(scope);
    const tracking = await this.readTrackingMetadata(scope);

    const serverIdentities = new Map<string, { serverName: string; bundleId: string }>();
    const duplicatesDisabled: DuplicateInfo[] = [];

    for (const [serverName, serverConfig] of Object.entries(config.servers)) {
      const identity = this.computeServerIdentity(serverConfig);
      const existing = serverIdentities.get(identity);

      if (existing && !serverConfig.disabled) {
        // This is a duplicate - disable it
        config.servers[serverName] = {
          ...serverConfig,
          disabled: true,
          description: `Duplicate of ${existing.serverName} (from bundle ${existing.bundleId})`
        };

        const metadata = tracking.managedServers[serverName];
        duplicatesDisabled.push({
          serverName,
          duplicateOf: existing.serverName,
          bundleId: metadata?.bundleId || 'unknown',
          originalBundleId: existing.bundleId
        });
      } else if (!serverConfig.disabled) {
        // First enabled server with this identity - record it
        const metadata = tracking.managedServers[serverName];
        serverIdentities.set(identity, {
          serverName,
          bundleId: metadata?.bundleId || 'unknown'
        });
      }
    }

    return { duplicatesDisabled, config };
  }

  /**
   * Merge new input definitions into existing ones, deduplicating by id.
   * Delegates to the pure domain helper in `@ai-primitives-hub/core`.
   * @param existing - Current inputs array from mcp.json
   * @param incoming - New inputs to add
   */
  public mergeInputs(
    existing: VSCodeMcpInputDefinition[] | undefined,
    incoming: VSCodeMcpInputDefinition[] | undefined
  ): VSCodeMcpInputDefinition[] | undefined {
    return mergeInputDeclarations(existing, incoming);
  }

  /**
   * Merge new servers and their input declarations into an existing MCP configuration.
   * @param existingConfig - Current config read from the host's mcp.json.
   * @param newServers - Servers to add, already prefixed with their bundle id.
   * @param options - Install options (conflict handling).
   * @param newInputs - Input declarations shipped by the bundle manifest.
   * @param supportsInputs - Whether the target host resolves `${input:id}`. When
   * false, missing declarations are not auto-derived because the host will never
   * prompt for them and the entry would only mislead the user.
   */
  public async mergeServers(
    existingConfig: McpConfiguration,
    newServers: Record<string, McpServerConfig>,
    options: McpInstallOptions,
    newInputs?: VSCodeMcpInputDefinition[],
    supportsInputs = true
  ): Promise<{ config: McpConfiguration; conflicts: string[]; warnings: string[] }> {
    // Spread `existingConfig` first: hosts such as Claude Code keep unrelated state
    // (projects, account/OAuth data, preferences) as sibling top-level keys in the
    // same file. Rebuilding the object from only servers/tasks/inputs would drop all
    // of it before serialization ever runs, so the preservation guarantee has to start
    // here, not in serializeMcpConfig.
    const result: McpConfiguration = {
      ...existingConfig,
      servers: { ...existingConfig.servers },
      tasks: existingConfig.tasks ? { ...existingConfig.tasks } : undefined,
      // Hosts without input support must not receive bundle declarations: they
      // would never prompt, so preserve only input state already in the file.
      inputs: supportsInputs
        ? this.mergeInputs(existingConfig.inputs, newInputs)
        : existingConfig.inputs
    };
    const conflicts: string[] = [];
    const warnings: string[] = [];

    for (const [serverName, serverConfig] of Object.entries(newServers)) {
      if (result.servers[serverName]) {
        if (options.overwrite) {
          warnings.push(`Overwriting existing server: ${serverName}`);
          result.servers[serverName] = serverConfig;
        } else if (options.skipOnConflict) {
          warnings.push(`Skipping conflicting server: ${serverName}`);
          continue;
        } else {
          conflicts.push(serverName);
        }
      } else {
        result.servers[serverName] = serverConfig;
      }
    }

    // Auto-derive missing input declarations from ${input:id} references in the
    // newly-installed servers. Delegates to the pure core helper.
    // Skipped on hosts that do not resolve inputs.
    if (supportsInputs) {
      const { inputs: derivedInputs, warnings: derivedWarnings } =
        this.autoDeriveMissingInputs(newServers, result.inputs);
      result.inputs = derivedInputs;
      warnings.push(...derivedWarnings);
    }

    return { config: result, conflicts, warnings };
  }

  /**
   * Auto-derive missing `${input:id}` declarations for newly-installed servers.
   * Delegates to the pure domain helper in `@ai-primitives-hub/core`.
   * @param servers - Servers to scan for `${input:id}` references.
   * @param existingInputs - Inputs already declared (merged manifest + existing file).
   */
  public autoDeriveMissingInputs(
    servers: Record<string, McpServerConfig>,
    existingInputs: VSCodeMcpInputDefinition[] | undefined
  ): { inputs: VSCodeMcpInputDefinition[] | undefined; warnings: string[] } {
    return autoDeriveMissingInputs(servers, existingInputs);
  }

  /**
   * Collect all `${input:id}` references across the given server configurations.
   * Delegates to the pure domain helper in `@ai-primitives-hub/core`.
   * @param servers - Server configurations to scan.
   * @returns The set of referenced input ids.
   */
  public collectInputReferences(servers: Record<string, McpServerConfig>): Set<string> {
    return collectInputReferences(servers);
  }

  /**
   * Remove inputs that are no longer referenced by any remaining server.
   * Inputs referenced by at least one server are kept, even across bundles.
   * @param config
   */
  public removeOrphanedInputs(config: McpConfiguration): McpConfiguration {
    if (!config.inputs || config.inputs.length === 0) {
      return config;
    }
    const referenced = collectInputReferences(config.servers);
    const filteredInputs = config.inputs.filter((input) => referenced.has(input.id));
    return {
      ...config,
      inputs: filteredInputs.length > 0 ? filteredInputs : undefined
    };
  }

  public async removeServersForBundle(bundleId: string, scope: 'user' | 'workspace'): Promise<string[]> {
    const config = await this.readMcpConfig(scope);
    const tracking = await this.readTrackingMetadata(scope);
    const removedServers: string[] = [];

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
      const cleanedConfig = this.removeOrphanedInputs(config);
      await this.writeMcpConfig(cleanedConfig, scope, true);
      await this.writeTrackingMetadata(tracking, scope);
      this.logger.info(`Removed ${removedServers.length} MCP servers for bundle ${bundleId}`);
    }

    return removedServers;
  }
}
