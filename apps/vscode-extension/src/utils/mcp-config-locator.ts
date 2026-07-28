import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  McpLayoutConfig,
  TargetType,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  detectHostApp,
} from './host-app';

/** Token used in default-layouts.json for the user home directory. */
const HOME_TOKEN = '${HOME}';

export class McpConfigLocator {
  private static readonly MCP_FILENAME = 'mcp.json';
  private static readonly TRACKING_FILENAME = 'prompt-registry-mcp-tracking.json';
  private static context: vscode.ExtensionContext | undefined;

  /**
   * Returns the MCP layout config for a given TargetType from default-layouts.json,
   * or `undefined` if the IDE has no mcpConfig entry.
   * This is the single source of truth for IDE-specific MCP path and format metadata.
   * To add or change MCP paths for any IDE, edit default-layouts.json.
   * @param host - TargetType (e.g. 'kiro', 'windsurf', 'vscode').
   */
  public static getMcpLayoutConfig(host: TargetType): McpLayoutConfig | undefined {
    return (defaultLayouts.layouts as Record<string, { mcpConfig?: McpLayoutConfig }>)[host]?.mcpConfig;
  }

  /**
   * Returns the workspace-relative MCP config file path for a given host,
   * or null if the IDE has no official workspace-level MCP config.
   * Derived from the `mcpConfig.workspaceFile` entry in default-layouts.json.
   * @param host - Optional TargetType override (defaults to detectHostApp()).
   */
  public static getWorkspaceMcpRelativePath(host?: TargetType): string | null {
    const h = host ?? detectHostApp();
    const mc = this.getMcpLayoutConfig(h);
    return mc ? (mc.workspaceFile ?? null) : '.vscode/mcp.json';
  }

  /**
   * Returns the workspace MCP config subfolder (for backward compat with McpServerManager).
   * @param host - Optional TargetType override.
   */
  public static getMcpWorkspaceConfigFolder(host?: TargetType): string {
    const rel = this.getWorkspaceMcpRelativePath(host);
    if (!rel) {
      return '.vscode';
    }
    const dir = path.dirname(path.normalize(rel));
    return dir === '.' ? '.' : dir;
  }

  /**
   * Returns the JSON key used for MCP server entries for a given host.
   * Derived from `mcpConfig.serversKey` in default-layouts.json.
   * Default (VS Code): 'servers'. All other known IDEs use 'mcpServers'.
   * @param host - Optional TargetType override (defaults to detectHostApp()).
   */
  public static getMcpServersKey(host?: TargetType): 'servers' | 'mcpServers' {
    const h = host ?? detectHostApp();
    const key = this.getMcpLayoutConfig(h)?.serversKey ?? 'servers';
    return key === 'mcpServers' ? 'mcpServers' : 'servers';
  }

  public static initialize(context: vscode.ExtensionContext) {
    this.context = context;
  }

  private static getVsCodeVariant(): string {
    const productName = vscode.env?.appName || 'Visual Studio Code';

    if (productName.includes('Insiders')) {
      return 'Code - Insiders';
    } else if (productName.includes('Cursor')) {
      return 'Cursor';
    } else if (productName.includes('Windsurf')) {
      return 'Windsurf';
    } else if (productName.toLowerCase().includes('kiro')) {
      return 'Kiro';
    } else {
      return 'Code';
    }
  }

  private static getUserConfigDirectory(): string {
    // If context is initialized, use globalStorageUri to find profile-specific User directory
    if (this.context?.globalStorageUri) {
      // globalStorageUri points to .../User/globalStorage/publisher.name
      // We want .../User which is 2 levels up
      return path.dirname(path.dirname(this.context.globalStorageUri.fsPath));
    }

    // Fallback for tests or when context is not available
    const home = os.homedir();
    const platform = os.platform();
    const variant = this.getVsCodeVariant();

    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return path.join(appData, variant, 'User');
    } else if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', variant, 'User');
    } else {
      const configDir = variant === 'Code' ? '.config/Code' : `.config/${variant}`;
      return path.join(home, configDir, 'User');
    }
  }

  private static getWorkspaceConfigDirectory(host?: TargetType): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }
    const rel = this.getWorkspaceMcpRelativePath(host);
    if (!rel) {
      return undefined; // IDE has no workspace-level MCP support
    }
    return path.dirname(path.join(workspaceFolders[0].uri.fsPath, rel));
  }

  /**
   * User-level MCP config path.
   * Derived from `mcpConfig.userFile` in default-layouts.json (resolves `${HOME}` token).
   * Falls back to the VS Code appData path for VS Code / Insiders (userFile = null).
   * @param host - Optional TargetType override for testing.
   */
  public static getUserMcpConfigPath(host?: TargetType): string {
    const h = host ?? detectHostApp();
    const mc = this.getMcpLayoutConfig(h);
    if (mc?.userFile) {
      // Expand ${HOME} token and normalise to OS path separators
      return path.normalize(mc.userFile.replace(HOME_TOKEN, os.homedir()));
    }
    // No mcpConfig or userFile is null → use VS Code globalStorageUri-derived path
    return path.join(this.getUserConfigDirectory(), this.MCP_FILENAME);
  }

  public static getWorkspaceMcpConfigPath(host?: TargetType): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }
    const rel = this.getWorkspaceMcpRelativePath(host);
    if (!rel) {
      return undefined; // IDE has no workspace-level MCP support
    }
    return path.join(workspaceFolders[0].uri.fsPath, rel);
  }

  public static getWorkspaceTrackingPath(): string | undefined {
    const workspaceDir = this.getWorkspaceConfigDirectory();
    if (!workspaceDir) {
      return undefined;
    }
    return path.join(workspaceDir, this.TRACKING_FILENAME);
  }

  /**
   * User-level tracking metadata path.
   * Derives from the user MCP config path (same directory, different filename).
   * @param host - Optional TargetType override for testing.
   */
  public static getUserTrackingPath(host?: TargetType): string {
    const configPath = this.getUserMcpConfigPath(host);
    return path.join(path.dirname(configPath), this.TRACKING_FILENAME);
  }

  public static getMcpConfigLocation(scope: 'user' | 'workspace'): { configPath: string; trackingPath: string; exists: boolean } | undefined {
    if (scope === 'user') {
      const configPath = this.getUserMcpConfigPath();
      const trackingPath = this.getUserTrackingPath();
      return {
        configPath,
        trackingPath,
        exists: fs.existsSync(configPath)
      };
    } else {
      const configPath = this.getWorkspaceMcpConfigPath();
      const trackingPath = this.getWorkspaceTrackingPath();

      if (!configPath || !trackingPath) {
        return undefined;
      }

      return {
        configPath,
        trackingPath,
        exists: fs.existsSync(configPath)
      };
    }
  }

  public static async ensureConfigDirectory(scope: 'user' | 'workspace'): Promise<void> {
    const location = this.getMcpConfigLocation(scope);
    if (!location) {
      throw new Error(`Cannot determine ${scope}-level configuration directory. No workspace open?`);
    }

    const configDir = path.dirname(location.configPath);
    if (!fs.existsSync(configDir)) {
      await fs.promises.mkdir(configDir, { recursive: true });
    }
  }
}
