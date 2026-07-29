/**
 * Layout resolver — merges multiple TargetLayoutsConfig layers and
 * resolves a concrete TargetLayout for a given Target.
 *
 * Application layer: pure logic, no IO. The filesystem loading is
 * handled by `infra/stores/layout-config-store.ts`.
 *
 * Merge strategy (analogous to .gitconfig):
 *   - `baseDir`: replaced if specified in a higher layer.
 *   - `kindRoutes`: deep-merged; higher-layer entries override
 *     individual routes without wiping the full map.
 *   - `skipPaths`: replaced if specified in a higher layer.
 * @module install/layout-resolver
 */
import type {
  McpLayoutConfig,
  ScopedLayoutDef,
  Target,
  TargetLayout,
  TargetLayoutsConfig,
} from '@ai-primitives-hub/core';

/**
 * Workspace-root token used in layout `baseDir` values (e.g.
 * `"${workspaceRoot}/.github"`). Resolved from the target at install time.
 * Exported so callers can resolve a layout against the token itself and read
 * the workspace-relative portion of `baseDir` (e.g. the host's top folder).
 */
export const WORKSPACE_ROOT_TOKEN = '${workspaceRoot}';

/**
 * Merge an ordered array of layout config layers into a single
 * resolved `TargetLayout` for the given target.
 *
 * The `${workspaceRoot}` token in `baseDir` is resolved to
 * `target.rootPath ?? target.path ?? '.'`. Only `scope === 'repository'`
 * uses the `repository` layout branch (falling back to `user`); every
 * other scope value (including this codebase's `workspace` scope,
 * which the reference branch does not have) uses the `user` branch.
 * @param target - Target to resolve.
 * @param layers - Ordered layers from least- to most-specific.
 * @returns Resolved TargetLayout, or null if no definition exists for
 *          the target type in any layer.
 */
export function resolveLayoutFromLayers(
  target: Target,
  layers: TargetLayoutsConfig[]
): TargetLayout | null {
  const scope = target.scope;
  let merged: ScopedLayoutDef | null = null;

  for (const layer of layers) {
    const typeDef = layer.layouts[target.type];
    if (typeDef === undefined) {
      continue;
    }
    // Pick the scope-specific def, falling back to 'user' if 'repository' is absent.
    const scopeDef = scope === 'repository'
      ? (typeDef.repository ?? typeDef.user)
      : typeDef.user;

    merged = mergeScoped(merged, scopeDef);
  }

  if (merged === null) {
    return null;
  }

  let baseDir: string;
  if (scope === 'repository') {
    // Repository scope: substitute the ${workspaceRoot} token wherever it
    // appears in baseDir (e.g. "${workspaceRoot}/.github"), so a layout can
    // fold its top-level folder into baseDir and keep kindRoutes relative —
    // matching how user scope already models baseDir.
    const workspaceRoot = target.rootPath ?? target.path ?? '.';
    baseDir = merged.baseDir.split(WORKSPACE_ROOT_TOKEN).join(workspaceRoot);
  } else {
    // User scope: target.path overrides the config's baseDir if set.
    baseDir = target.path ?? merged.baseDir;
  }

  return {
    baseDir,
    kindRoutes: { ...merged.kindRoutes },
    skipPaths: merged.skipPaths ? [...merged.skipPaths] : undefined
  };
}

/**
 * Deep-merge two ScopedLayoutDef objects.
 * `next` takes precedence for `baseDir` and `skipPaths`;
 * `kindRoutes` are merged entry-by-entry.
 * @param base
 * @param next
 */
function mergeScoped(
  base: ScopedLayoutDef | null,
  next: ScopedLayoutDef
): ScopedLayoutDef {
  if (base === null) {
    return next;
  }
  return {
    baseDir: next.baseDir,
    kindRoutes: { ...base.kindRoutes, ...next.kindRoutes },
    skipPaths: next.skipPaths ?? base.skipPaths
  };
}

/**
 * Resolve the MCP layout config for a given target type from an ordered set
 * of layout config layers (same merge model as `resolveLayoutFromLayers`).
 * Later layers override earlier ones; the first layer to define an `mcpConfig`
 * is used as the base, with subsequent layers replacing it entirely.
 * Returns `undefined` if no layer defines an `mcpConfig` for the target type.
 * Pure; no IO.
 * @param targetType - IDE target type identifier (e.g. `'kiro'`, `'vscode'`).
 * @param layers - Ordered layers from least- to most-specific.
 */
export function resolveMcpLayoutConfig(
  targetType: string,
  layers: TargetLayoutsConfig[]
): McpLayoutConfig | undefined {
  let result: McpLayoutConfig | undefined;
  for (const layer of layers) {
    const config = layer.layouts[targetType]?.mcpConfig;
    if (config !== undefined) {
      // McpLayoutConfig is fully readonly — no need to copy; later layers overwrite entirely.
      result = config;
    }
  }
  return result;
}
