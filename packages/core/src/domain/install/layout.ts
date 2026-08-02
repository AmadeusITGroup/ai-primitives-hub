/**
 * Domain types for target layout configuration.
 *
 * A layout config describes where each primitive kind should be placed
 * for a given target type and scope (user vs repository). These types
 * represent the on-disk configuration format (YAML/JSON) as well as
 * the resolved shape consumed by writers.
 *
 * Pure domain: no IO, no framework imports.
 * @module domain/install/layout
 */

/**
 * Per-scope layout definition as stored in a layout config file.
 * Both user and repository scopes use this same shape.
 */
export interface ScopedLayoutDef {
  /**
   * Base directory for the target. May contain env var tokens like
   * `${HOME}` or the special `${workspaceRoot}` token which is resolved
   * from `target.rootPath ?? target.path ?? '.'` at install time.
   */
  readonly baseDir: string;
  /**
   * Map from bundle sub-path prefix (e.g. `"prompts/"`) to output
   * sub-path relative to `baseDir` (e.g. `".github/prompts/"`).
   */
  readonly kindRoutes: Readonly<Record<string, string>>;
  /**
   * Bundle-relative paths to skip entirely (manifests, READMEs, etc.).
   * Defaults to `["deployment-manifest.yml", "README.md"]` if absent.
   */
  readonly skipPaths?: readonly string[];
  /**
   * MCP config file for this target type **at this scope**.
   *
   * Absent means the IDE has no MCP config file at this scope — it is NOT
   * inherited from the `user` scope. Inheriting would make a repository-scope
   * install write into the user's home config (Windsurf and Copilot CLI have no
   * workspace-level MCP file), so absence must stay meaningful.
   */
  readonly mcpConfig?: McpLayoutConfig;
}

/**
 * Per-target-type layout definition. Holds one entry per scope.
 * `repository` is optional: if absent, `user` layout is used regardless
 * of the target's scope field.
 */
export interface TargetLayoutDef {
  /** Layout for user-scoped targets. */
  readonly user: ScopedLayoutDef;
  /** Layout for repository-scoped targets. Falls back to `user` if absent. */
  readonly repository?: ScopedLayoutDef;
}

/**
 * The JSON key used for MCP server entries in an IDE config file.
 * VS Code Copilot uses `'servers'`; all other known IDEs use `'mcpServers'`.
 */
export type McpServersKey = 'servers' | 'mcpServers';

/**
 * MCP config file description for one IDE at one scope.
 * Stored in default-layouts.json alongside the primitive layout definitions
 * so that all IDE-specific path decisions live in one place.
 *
 * Note: there is deliberately no `format` field. Every file is read with the JSONC
 * parser (which accepts plain JSON), and every write currently reformats the file via
 * `JSON.stringify`, so nothing would branch on it. A format field belongs here only
 * once comment-preserving writes exist to consume it.
 */
export interface McpLayoutConfig {
  /**
   * Full path template to the MCP config file, e.g.
   * `"${HOME}/.kiro/settings/mcp.json"` or `"${workspaceRoot}/.vscode/mcp.json"`.
   * Tokens are resolved by `resolvePathTokens`.
   */
  readonly path: string;
  /**
   * JSON root key used for MCP server entries.
   * VS Code Copilot uses `'servers'`; all other known IDEs use `'mcpServers'`.
   */
  readonly serversKey: McpServersKey;
  /**
   * Whether the host resolves `${input:id}` placeholders against an `inputs` array,
   * prompting the user for the value. This is a VS Code Copilot feature.
   *
   * Defaults to `false` when absent, because only VS Code is known to support it.
   *
   * A host that does not support inputs receives the placeholder as a literal string,
   * so the server is written successfully and then fails at startup. Callers must
   * therefore check this before installing a server that references an input, rather
   * than relying on the write succeeding.
   */
  readonly supportsInputs?: boolean;
}

/**
 * Token used in path templates for the user home directory.
 */
export const HOME_TOKEN = '${HOME}';

/**
 * Token used in path templates for the workspace root.
 * Resolved from `target.rootPath ?? target.path` at install time.
 */
export const WORKSPACE_ROOT_TOKEN = '${workspaceRoot}';

/**
 * Token used in path templates for the VS Code user data `User` directory.
 *
 * VS Code is the only supported host whose config directory is neither
 * HOME-relative nor identical across platforms: it follows each OS's app-data
 * convention (`%APPDATA%\Code\User`, `~/Library/Application Support/Code/User`,
 * `~/.config/Code/User`), the `Code` segment varies by variant (Insiders,
 * Cursor, Windsurf, Kiro), and portable installs, `--user-data-dir` and remote
 * sessions move it entirely. The delivery layer therefore resolves this token
 * from the running host rather than from a static template.
 */
export const VSCODE_USER_DIR_TOKEN = '${vscodeUserDir}';

/**
 * Thrown when a path template contains a token that no caller supplied.
 * Failing loudly prevents an unresolved token reaching the filesystem, where it
 * would silently create a directory literally named `${...}`.
 */
export class UnresolvedPathTokenError extends Error {
  public constructor(
    /** The token that could not be resolved, including delimiters. */
    public readonly token: string,
    /** The template the token appeared in. */
    public readonly template: string
  ) {
    super(`Unresolved token "${token}" in path template "${template}"`);
    this.name = 'UnresolvedPathTokenError';
  }
}

/**
 * Expand `${VAR}` tokens and leading `~` in a path template.
 * Pure: no IO. Converged from `expandPath` in `file-tree-writer` so both
 * MCP path resolution and primitive layout resolution use the same logic.
 * @param template - Path string possibly containing `${VAR}` or `~`.
 * @param env - Environment variable map (e.g. `process.env`).
 * @returns Expanded path with all tokens replaced.
 */
export function expandPath(template: string, env: Record<string, string | undefined>): string {
  let out = template.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => env[name] ?? '');
  if (out.startsWith('~')) {
    const home = env.HOME ?? env.USERPROFILE ?? '';
    out = home + out.slice(1);
  }
  return out;
}

/**
 * Resolve every `${token}` in a path template against an explicit token map.
 *
 * Unlike `expandPath`, this accepts tokens of any casing (so `${HOME}`,
 * `${workspaceRoot}` and `${vscodeUserDir}` all work through one code path) and
 * throws `UnresolvedPathTokenError` on a token the caller did not supply,
 * rather than substituting an empty string or leaving the token in place.
 *
 * A token whose value is an empty string is treated as unresolved: an empty
 * `${HOME}` would silently turn `${HOME}/.kiro/mcp.json` into an absolute
 * `/.kiro/mcp.json`, writing outside the user's home directory.
 *
 * Pure: no IO.
 * @param template - Path template, e.g. `"${HOME}/.kiro/settings/mcp.json"`.
 * @param tokens - Token name (without delimiters) to replacement value.
 * @returns The template with every token replaced.
 * @throws {UnresolvedPathTokenError} When a token is missing or empty.
 */
export function resolvePathTokens(
  template: string,
  tokens: Readonly<Record<string, string | undefined>>
): string {
  return template.replaceAll(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const value = tokens[name];
    if (value === undefined || value === '') {
      throw new UnresolvedPathTokenError(`\${${name}}`, template);
    }
    return value;
  });
}

/**
 * Resolve the path of an MCP config file for one scope.
 * Thin wrapper over `resolvePathTokens` that names the intent at call sites.
 * Pure: no IO.
 * @param config - MCP layout config for the target IDE at one scope.
 * @param tokens - Token name to replacement value.
 * @returns Fully resolved MCP config file path.
 * @throws {UnresolvedPathTokenError} When the template needs a token that was not supplied.
 */
export function resolveMcpConfigPath(
  config: McpLayoutConfig,
  tokens: Readonly<Record<string, string | undefined>>
): string {
  return resolvePathTokens(config.path, tokens);
}

/**
 * Root shape of an `ai-primitives-hub-layouts.yml` (or `.json`) config file.
 * Keyed by target type identifier (e.g. `"vscode"`, `"kiro"`).
 *
 * A partial config (only overriding some targets, or some kindRoutes
 * within a target) is valid — the layout resolver deep-merges multiple
 * layers before resolving.
 */
export interface TargetLayoutsConfig {
  readonly layouts: Readonly<Record<string, TargetLayoutDef>>;
}

/**
 * Mapping from a primitive kind to a relative subdirectory.
 * Keys are bundle sub-path prefixes (e.g. `"prompts/"`),
 * values are output sub-paths relative to baseDir.
 */
export type KindRoutes = Record<string, string>;

/**
 * Resolved target layout consumed by writers.
 * The `baseDir` is already resolved (no `${workspaceRoot}` token);
 * `${HOME}` and other env tokens are still present and expanded by
 * `expandPath` at write time.
 */
export interface TargetLayout {
  /** Base directory the writer writes into (post-${VAR} expansion). */
  baseDir: string;
  /** Map: bundle subpath prefix → output subpath under baseDir. */
  kindRoutes: KindRoutes;
  /** Bundle-relative paths to skip (manifests, READMEs, etc.). */
  skipPaths?: string[];
}

/**
 * Validate an unknown value as a `TargetLayoutsConfig`.
 * Returns the typed config or throws with a descriptive message.
 * Pure; no IO.
 * @param raw - Parsed YAML/JSON to validate.
 * @returns Typed `TargetLayoutsConfig`.
 */
export function validateTargetLayoutsConfig(raw: unknown): TargetLayoutsConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('layout config must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.layouts === null || typeof obj.layouts !== 'object') {
    throw new Error('layout config must have a "layouts" object');
  }
  const layouts = obj.layouts as Record<string, unknown>;
  for (const [type, def] of Object.entries(layouts)) {
    if (def === null || typeof def !== 'object') {
      throw new Error(`layout config: "${type}" must be an object`);
    }
    const typedDef = def as Record<string, unknown>;
    validateScopedLayoutDef(typedDef.user, `${type}.user`);
    if (typedDef.repository !== undefined) {
      validateScopedLayoutDef(typedDef.repository, `${type}.repository`);
    }
  }
  return raw as TargetLayoutsConfig;
}

function validateScopedLayoutDef(raw: unknown, path: string): void {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(`layout config: "${path}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.baseDir !== 'string') {
    throw new TypeError(`layout config: "${path}.baseDir" must be a string`);
  }
  if (obj.kindRoutes === null || typeof obj.kindRoutes !== 'object') {
    throw new TypeError(`layout config: "${path}.kindRoutes" must be an object`);
  }
  for (const [k, v] of Object.entries(obj.kindRoutes as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new TypeError(`layout config: "${path}.kindRoutes.${k}" must be a string`);
    }
  }
  if (obj.skipPaths !== undefined) {
    if (!Array.isArray(obj.skipPaths)) {
      throw new TypeError(`layout config: "${path}.skipPaths" must be an array`);
    }
    for (const p of obj.skipPaths as unknown[]) {
      if (typeof p !== 'string') {
        throw new TypeError(`layout config: "${path}.skipPaths" entries must be strings`);
      }
    }
  }
  if (obj.mcpConfig !== undefined) {
    validateMcpLayoutConfig(obj.mcpConfig, `${path}.mcpConfig`);
  }
}

const MCP_SERVERS_KEYS = new Set(['servers', 'mcpServers']);

function validateMcpLayoutConfig(raw: unknown, path: string): void {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(`layout config: "${path}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.path !== 'string' || obj.path.length === 0) {
    throw new TypeError(`layout config: "${path}.path" must be a non-empty string`);
  }
  if (typeof obj.serversKey !== 'string' || !MCP_SERVERS_KEYS.has(obj.serversKey)) {
    throw new TypeError(
      `layout config: "${path}.serversKey" must be one of ${[...MCP_SERVERS_KEYS].join(', ')}`
    );
  }
  if (obj.supportsInputs !== undefined && typeof obj.supportsInputs !== 'boolean') {
    throw new TypeError(`layout config: "${path}.supportsInputs" must be a boolean`);
  }
}
