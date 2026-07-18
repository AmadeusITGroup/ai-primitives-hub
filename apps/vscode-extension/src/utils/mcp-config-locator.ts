import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export class McpConfigLocator {
  private static readonly MCP_FILENAME = 'mcp.json';
  private static readonly TRACKING_FILENAME = 'prompt-registry-mcp-tracking.json';
  private static context: vscode.ExtensionContext | undefined;

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

  private static getWorkspaceConfigDirectory(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }
    return path.join(workspaceFolders[0].uri.fsPath, '.vscode');
  }

  public static getUserMcpConfigPath(): string {
    const userDir = this.getUserConfigDirectory();
    return path.join(userDir, this.MCP_FILENAME);
  }

  public static getWorkspaceMcpConfigPath(): string | undefined {
    const workspaceDir = this.getWorkspaceConfigDirectory();
    if (!workspaceDir) {
      return undefined;
    }
    return path.join(workspaceDir, this.MCP_FILENAME);
  }

  public static getUserTrackingPath(): string {
    const userDir = this.getUserConfigDirectory();
    return path.join(userDir, this.TRACKING_FILENAME);
  }

  public static getWorkspaceTrackingPath(): string | undefined {
    const workspaceDir = this.getWorkspaceConfigDirectory();
    if (!workspaceDir) {
      return undefined;
    }
    return path.join(workspaceDir, this.TRACKING_FILENAME);
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
