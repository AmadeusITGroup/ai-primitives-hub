import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  McpConfigScope,
} from '@ai-primitives-hub/app';
import {
  resolveMcpLayoutConfig,
} from '@ai-primitives-hub/app';
import type {
  McpConfigFormat,
  McpLayoutConfig,
  McpServersKey,
  TargetLayoutsConfig,
  TargetType,
} from '@ai-primitives-hub/core';
import {
  resolveMcpConfigPath,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  detectHostApp,
} from './host-app';

/** Built-in layout layers used for MCP config resolution. Treated as a single-layer array. */
// TypeScript widens JSON string values to `string`, making serversKey: string incompatible
// with McpServersKey. The assertion is safe: JSON values are validated at authoring time.
const BUILT_IN_LAYERS: TargetLayoutsConfig[] = [defaultLayouts as unknown as TargetLayoutsConfig];

/**
 * Location and format of a resolved MCP config file.
 */
export interface McpConfigLocation {
  /** Absolute path to the MCP config file. */
  configPath: string;
  /** Absolute path to the sibling tracking metadata file. */
  trackingPath: string;
  /** Whether the config file currently exists. */
  exists: boolean;
  /** JSON root key holding the server map for this IDE and scope. */
  serversKey: McpServersKey;
  /** On-disk syntax, which determines whether comments must be preserved on write. */
  format: McpConfigFormat;
}

export class McpConfigLocator {
  private static readonly TRACKING_FILENAME = 'prompt-registry-mcp-tracking.json';
  private static context: vscode.ExtensionContext | undefined;

  /**
   * MCP config description for a target type at a given scope, straight from
   * default-layouts.json. `undefined` means the IDE has no MCP config file at
   * that scope (e.g. Windsurf has no workspace-level MCP).
   *
   * This is the single source of truth for IDE-specific MCP path and format
   * metadata: to add or change an IDE, edit default-layouts.json.
   * @param host - TargetType (e.g. 'kiro', 'windsurf', 'vscode').
   * @param scope - Which scope's MCP file to describe.
   */
  public static getMcpLayoutConfig(host: TargetType, scope: McpConfigScope): McpLayoutConfig | undefined {
    return resolveMcpLayoutConfig(host, scope, BUILT_IN_LAYERS);
  }

  /**
   * JSON root key used for MCP server entries for a given host and scope.
   * Defaults to `'servers'` (VS Code) when the IDE declares no MCP file, so
   * callers that only need the key never have to null-check.
   * @param host - TargetType.
   * @param scope - Which scope's MCP file to read the key from.
   */
  public static getMcpServersKey(host: TargetType, scope: McpConfigScope): McpServersKey {
    return this.getMcpLayoutConfig(host, scope)?.serversKey ?? 'servers';
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

  /**
   * Value for the `${vscodeUserDir}` token: the VS Code user data `User` directory.
   *
   * Prefers `context.globalStorageUri`, which is authoritative — it reflects
   * portable installs, `--user-data-dir` overrides and remote/WSL sessions, none
   * of which a static template could express. Falls back to the per-platform
   * convention when no extension context is available (unit tests, CLI use).
   *
   * KNOWN LIMITATION — this always resolves to the **default profile**.
   * `globalStorageUri` is not profile-scoped, so a non-default profile's
   * `<userDataDir>/User/profiles/<id>/mcp.json` is never targeted: a user-scope
   * install made while a non-default profile is active writes a file that
   * profile does not read. Repository scope is unaffected.
   *
   * Not fixable with the current API — both requests for a way to resolve the
   * active profile were closed as not planned:
   * - https://github.com/microsoft/vscode/issues/160466 (profile-aware globalStorageUri)
   * - https://github.com/microsoft/vscode/issues/211890 (Profiles API)
   *
   * Confining this to a single token keeps the fix a one-function change if
   * VS Code ever ships an API. See docs/contributor-guide/architecture/mcp-integration.md.
   */
  private static getVsCodeUserDir(): string {
    if (this.context?.globalStorageUri) {
      // globalStorageUri points to .../User/globalStorage/publisher.name — go up two levels.
      return path.dirname(path.dirname(this.context.globalStorageUri.fsPath));
    }

    const home = os.homedir();
    const platform = os.platform();
    const variant = this.getVsCodeVariant();

    if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return path.join(appData, variant, 'User');
    } else if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', variant, 'User');
    } else {
      return path.join(home, '.config', variant, 'User');
    }
  }

  /**
   * Absolute workspace root, or `undefined` when no folder is open.
   * Multi-root workspaces resolve to the first folder, matching how the
   * primitive layout resolver treats `${workspaceRoot}`.
   */
  private static getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
  }

  /**
   * Resolve the MCP config file path for a host and scope.
   * Returns `undefined` when the IDE has no MCP file at that scope, or when
   * repository scope is requested with no workspace open.
   * @param scope - Which scope's MCP file to resolve.
   * @param host - Optional TargetType override (defaults to detectHostApp()).
   * @param workspaceRootOverride - Workspace root to resolve `${workspaceRoot}` against,
   *   for callers that operate on a specific workspace rather than the active one.
   */
  public static getMcpConfigPath(
    scope: McpConfigScope,
    host?: TargetType,
    workspaceRootOverride?: string
  ): string | undefined {
    const mcpLayout = this.getMcpLayoutConfig(host ?? detectHostApp(), scope);
    if (!mcpLayout) {
      return undefined;
    }
    const workspaceRoot = workspaceRootOverride ?? this.getWorkspaceRoot();
    if (scope === 'repository' && workspaceRoot === undefined) {
      return undefined;
    }
    // Only the tokens a template may legitimately use are supplied; anything else
    // throws UnresolvedPathTokenError rather than reaching the filesystem.
    return path.normalize(resolveMcpConfigPath(mcpLayout, {
      HOME: os.homedir(),
      USERPROFILE: os.homedir(),
      workspaceRoot,
      vscodeUserDir: this.getVsCodeUserDir()
    }));
  }

  /**
   * Full location, format and existence of the MCP config file for a scope.
   * `undefined` when the IDE has no MCP file at that scope.
   * @param scope - Which scope's MCP file to locate.
   * @param host - Optional TargetType override.
   * @param workspaceRootOverride - Workspace root to resolve `${workspaceRoot}` against.
   */
  public static getMcpConfigLocation(
    scope: McpConfigScope,
    host?: TargetType,
    workspaceRootOverride?: string
  ): McpConfigLocation | undefined {
    const targetHost = host ?? detectHostApp();
    const mcpLayout = this.getMcpLayoutConfig(targetHost, scope);
    const configPath = this.getMcpConfigPath(scope, targetHost, workspaceRootOverride);
    if (!mcpLayout || configPath === undefined) {
      return undefined;
    }
    return {
      configPath,
      trackingPath: path.join(path.dirname(configPath), this.TRACKING_FILENAME),
      exists: fs.existsSync(configPath),
      serversKey: mcpLayout.serversKey,
      format: mcpLayout.format
    };
  }

  /**
   * Directory of the MCP config file relative to the workspace root, e.g.
   * `.kiro/settings` or `.vscode`, or `.` when the file sits at the root
   * (Claude Code's `.mcp.json`). `undefined` when the IDE has no
   * repository-scope MCP file.
   * @param host - Optional TargetType override.
   */
  public static getMcpWorkspaceConfigFolder(host?: TargetType): string | undefined {
    const targetHost = host ?? detectHostApp();
    const mcpLayout = this.getMcpLayoutConfig(targetHost, 'repository');
    if (!mcpLayout) {
      return undefined;
    }
    // Derived from the template rather than the resolved path so this works with
    // no workspace open, and so the result stays workspace-relative.
    const relative = mcpLayout.path.split('${workspaceRoot}').join('').replace(/^[/\\]+/, '');
    const folder = path.dirname(path.normalize(relative));
    return folder === '.' ? '.' : folder;
  }

  /**
   * Create the directory holding the MCP config file for a scope.
   * @param scope - Which scope's directory to create.
   * @param host - Optional TargetType override.
   */
  public static async ensureConfigDirectory(scope: McpConfigScope, host?: TargetType): Promise<void> {
    const location = this.getMcpConfigLocation(scope, host);
    if (!location) {
      throw new Error(`No MCP configuration file is defined for this IDE at ${scope} scope. No workspace open?`);
    }

    const configDir = path.dirname(location.configPath);
    if (!fs.existsSync(configDir)) {
      await fs.promises.mkdir(configDir, { recursive: true });
    }
  }
}
