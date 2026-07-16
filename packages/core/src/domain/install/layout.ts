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
}
