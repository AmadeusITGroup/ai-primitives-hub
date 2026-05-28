import * as fs from 'fs-extra';
import * as jsonc from 'jsonc-parser';
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
} from '../types/mcp';
import {
  Logger,
} from '../utils/logger';
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

  public async readMcpConfig(scope: 'user' | 'workspace'): Promise<McpConfiguration> {
    const location = McpConfigLocator.getMcpConfigLocation(scope);
    if (!location) {
      throw new Error(`Cannot determine ${scope}-level configuration path`);
    }

    if (!location.exists) {
      return { servers: {} };
    }

    try {
      const content = await fs.readFile(location.configPath, 'utf8');
      // Use JSONC parser to handle trailing commas and comments (VS Code mcp.json format)
      const errors: jsonc.ParseError[] = [];
      const config = jsonc.parse(content, errors) as McpConfiguration;
      if (errors.length > 0) {
        const errorMessages = errors.map((e) => `${jsonc.printParseErrorCode(e.error)} at offset ${e.offset}`).join(', ');
        this.logger.warn(`JSONC parse warnings in ${location.configPath}: ${errorMessages}`);
      }
      return config || { servers: {} };
    } catch (error) {
      this.logger.error(`Failed to read mcp.json from ${location.configPath}`, error as Error);
      throw new Error(`Failed to read MCP configuration: ${(error as Error).message}`);
    }
  }

  public async writeMcpConfig(config: McpConfiguration, scope: 'user' | 'workspace', createBackup = true): Promise<void> {
    const location = McpConfigLocator.getMcpConfigLocation(scope);
    if (!location) {
      throw new Error(`Cannot determine ${scope}-level configuration path`);
    }

    await McpConfigLocator.ensureConfigDirectory(scope);

    if (createBackup && location.exists) {
      await this.createBackup(location.configPath);
    }

    try {
      const content = JSON.stringify(config, null, 2);
      await fs.writeFile(location.configPath, content, 'utf8');
      this.logger.info(`MCP configuration written to ${location.configPath}`);
    } catch (error) {
      this.logger.error(`Failed to write mcp.json to ${location.configPath}`, error as Error);
      throw new Error(`Failed to write MCP configuration: ${(error as Error).message}`);
    }
  }

  public async readTrackingMetadata(scope: 'user' | 'workspace'): Promise<McpTrackingMetadata> {
    const location = McpConfigLocator.getMcpConfigLocation(scope);
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
    const location = McpConfigLocator.getMcpConfigLocation(scope);
    if (!location) {
      throw new Error(`Cannot determine ${scope}-level configuration path`);
    }

    await McpConfigLocator.ensureConfigDirectory(scope);

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

  public async mergeServers(
    existingConfig: McpConfiguration,
    newServers: Record<string, McpServerConfig>,
    options: McpInstallOptions
  ): Promise<{ config: McpConfiguration; conflicts: string[]; warnings: string[] }> {
    const result: McpConfiguration = {
      servers: { ...existingConfig.servers },
      tasks: existingConfig.tasks ? { ...existingConfig.tasks } : undefined,
      inputs: existingConfig.inputs ? [...existingConfig.inputs] : undefined
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

    return { config: result, conflicts, warnings };
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
      await this.writeMcpConfig(config, scope, true);
      await this.writeTrackingMetadata(tracking, scope);
      this.logger.info(`Removed ${removedServers.length} MCP servers for bundle ${bundleId}`);
    }

    return removedServers;
  }
}
