/**
 * MCP (Model Context Protocol) Configuration Types
 */

/**
 * Base MCP server configuration
 */
export interface McpServerConfigBase {
  disabled?: boolean;
  description?: string;
}

/**
 * Stdio MCP server configuration (local process)
 */
export interface McpStdioServerConfig extends McpServerConfigBase {
  type?: 'stdio'; // Optional, defaults to stdio for backward compatibility
  command: string;
  args?: string[];
  env?: Record<string, string>;
  envFile?: string; // Path to environment file
}

/**
 * Remote MCP server configuration (HTTP/SSE)
 */
export interface McpRemoteServerConfig extends McpServerConfigBase {
  type: 'http' | 'sse';
  url: string; // Supports http://, https://, unix://, pipe://
  headers?: Record<string, string>; // For authentication
}

/**
 * Union type for all MCP server configurations
 */
export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

/**
 * Type guard to check if a server config is stdio-based (local process)
 * Returns true for configs with command property (and no url, or explicit type: 'stdio')
 * @param config
 */
export function isStdioServerConfig(config: McpServerConfig): config is McpStdioServerConfig {
  // If it has url without command, it's remote
  if ('url' in config && !('command' in config)) {
    return false;
  }
  // If it has a url and type is http/sse, it's remote
  if ('url' in config && (config.type === 'http' || config.type === 'sse')) {
    return false;
  }
  // If it has command, it's stdio (type is optional for backward compatibility)
  return 'command' in config;
}

/**
 * Type guard to check if a server config is remote (HTTP/SSE)
 * Returns true for configs with url property and type: 'http' or 'sse'
 * Also returns true if url is present without command (infers remote)
 * @param config
 */
export function isRemoteServerConfig(config: McpServerConfig): config is McpRemoteServerConfig {
  if ('url' in config && (config.type === 'http' || config.type === 'sse')) {
    return true;
  }
  // Infer remote if url is present but no command (common in YAML configs)
  if ('url' in config && !('command' in config)) {
    return true;
  }
  return false;
}

export interface McpTaskDefinition {
  input?: string;
  output?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
}

export interface McpConfiguration {
  servers: Record<string, McpServerConfig>;
  tasks?: Record<string, McpTaskDefinition>;
  inputs?: any[]; // Legacy field, preserved for compatibility
}

/**
 * Server definition type - supports both stdio and remote servers
 * Note: This was previously aliased to McpStdioServerConfig only.
 * Now it properly supports the full McpServerConfig union.
 */
export type McpServerDefinition = McpServerConfig;

/**
 * Manifest of MCP servers - supports both stdio and remote configurations
 */
export type McpServersManifest = Record<string, McpServerConfig>;

export interface McpTrackingMetadata {
  managedServers: Record<string, {
    bundleId: string;
    bundleVersion: string;
    originalName: string;
    originalConfig: McpServerDefinition;
    installedAt: string;
    scope: 'user' | 'workspace';
  }>;
  lastUpdated: string;
  version: string;
}

export interface McpVariableContext {
  bundlePath: string;
  bundleId: string;
  bundleVersion: string;
  env: Record<string, string>;
}

export interface McpInstallResult {
  success: boolean;
  serversInstalled: number;
  installedServers: string[];
  errors?: string[];
  warnings?: string[];
}

export interface McpUninstallResult {
  success: boolean;
  serversRemoved: number;
  removedServers: string[];
  errors?: string[];
}

export interface McpInstallOptions {
  scope: 'user' | 'workspace';
  overwrite?: boolean;
  skipOnConflict?: boolean;
  createBackup?: boolean;
}

/**
 * Options for installing MCP servers to a workspace (repository scope)
 */
export interface McpWorkspaceInstallOptions {
  commitMode: 'commit' | 'local-only';
  overwrite?: boolean;
  skipOnConflict?: boolean;
  createBackup?: boolean;
}
