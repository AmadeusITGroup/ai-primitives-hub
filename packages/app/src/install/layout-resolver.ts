/**
 * Layout resolver — merges multiple TargetLayoutsConfig layers and
 * resolves a concrete TargetLayout for a given Target.
 *
 * Application layer: pure logic, no IO. The filesystem loading is
 * handled by infra/stores/layout-config-store.ts.
 *
 * Merge strategy (analogous to .gitconfig):
 *   - `baseDir`: replaced if specified in a higher layer.
 *   - `kindRoutes`: deep-merged; higher-layer entries override
 *     individual routes without wiping the full map.
 *   - `skipPaths`: replaced if specified in a higher layer.
 */
import type {
  Target,
} from '@prompt-registry/core';
import type {
  ScopedLayoutDef,
  TargetLayout,
  TargetLayoutsConfig,
} from '@prompt-registry/core';

/** Workspace-root token resolved from target at install time. */
const WORKSPACE_ROOT_TOKEN = '${workspaceRoot}';

/**
 * Merge an ordered array of layout config layers into a single
 * resolved `TargetLayout` for the given target.
 *
 * The `${workspaceRoot}` token in `baseDir` is resolved to
 * `target.workspaceRoot ?? target.path ?? '.'`.
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
    // Repository scope: ${workspaceRoot} resolved from target fields.
    const workspaceRoot = target.workspaceRoot ?? target.path ?? '.';
    baseDir = merged.baseDir === WORKSPACE_ROOT_TOKEN ? workspaceRoot : merged.baseDir;
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
