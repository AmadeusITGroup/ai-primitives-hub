/**
 * Target-related utilities for CLI commands.
 *
 * Centralizes target resolution logic to reduce duplication across commands.
 * @module framework/target
 */
import {
  findLockfile,
  getLockfilePathForMode,
  type RepositoryCommitMode,
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import {
  type Target,
} from '@ai-primitives-hub/core';
import {
  readTargetsHierarchical,
} from '@ai-primitives-hub/infra';
import {
  type Context,
} from './context';

/**
 * Load all targets from the hierarchical target configuration.
 * @param ctx CLI context.
 * @returns Array of configured targets.
 */
export const loadTargets = async (ctx: Context): Promise<Target[]> => {
  const userPaths = resolveUserConfigPaths(ctx.env);
  return readTargetsHierarchical({ cwd: ctx.cwd(), fs: ctx.fs }, userPaths.userTargets);
};

/**
 * CLI-only overrides that can change how a configured target is used for one
 * command invocation.
 */
export interface TargetOverrides {
  scope?: Target['scope'];
  commitMode?: RepositoryCommitMode;
}

/**
 * Derive the concrete target used by an operation.
 *
 * Scope and commit-mode flags must travel with the target all the way to the
 * writer and lockfile helpers. Keeping them as separate local variables lets
 * layout-aware writers observe the stale configured scope. Repository targets
 * also need an explicit root so every downstream consumer resolves the same
 * workspace when `--scope repository` is used without `--workspace-root`.
 * @param ctx CLI context.
 * @param target Configured target.
 * @param overrides Per-invocation CLI overrides.
 * @returns A new target containing the effective operation values.
 */
export const resolveEffectiveTarget = (
  ctx: Context,
  target: Target,
  overrides: TargetOverrides = {}
): Target => {
  const scope = overrides.scope ?? target.scope;
  const rootPath = target.rootPath === undefined || target.rootPath.length === 0
    ? (scope === 'repository' ? ctx.cwd() : target.rootPath)
    : target.rootPath;

  return {
    ...target,
    ...(overrides.scope === undefined ? {} : { scope: overrides.scope }),
    ...(overrides.commitMode === undefined ? {} : { commitMode: overrides.commitMode }),
    ...(rootPath === undefined ? {} : { rootPath })
  };
};

/**
 * Find the lockfile path for the current working directory.
 * @param ctx CLI context.
 * @returns Lockfile path or null if not found.
 */
export const findProjectLockfile = async (ctx: Context): Promise<string | null> => {
  const userPaths = resolveUserConfigPaths(ctx.env);
  return findLockfile(ctx.cwd(), ctx.fs, userPaths.userLockfile);
};

/**
 * Resolve the lockfile path for a target's scope.
 *
 * `repository` scope routes through `getLockfilePathForMode`, which
 * picks one of the two physical, extension-compatible files
 * (`prompt-registry.lock.json` for `commit`, `prompt-registry.local.lock.json`
 * for `local-only`) under `target.rootPath` (falling back to `ctx.cwd()`).
 * Every other scope uses the CLI-only, single-file, non-split
 * `resolveUserConfigPaths(env).userLockfile` — the extension has never
 * tracked user/workspace-scope installs via a lockfile (see
 * `stores/json-lockfile-store.ts`'s module doc), so `commitMode` is
 * meaningless there and ignored.
 * @param ctx CLI context.
 * @param target Target being installed into / uninstalled from.
 * @param commitMode Effective commit mode; only consulted for `repository` scope.
 *   Defaults to `target.commitMode ?? 'commit'`.
 * @returns Absolute lockfile path.
 */
export const lockfilePathForTarget = (ctx: Context, target: Target, commitMode?: RepositoryCommitMode): string => {
  if (target.scope === 'repository') {
    const mode = commitMode ?? target.commitMode ?? 'commit';
    return getLockfilePathForMode(target.rootPath ?? ctx.cwd(), mode);
  }
  return resolveUserConfigPaths(ctx.env).userLockfile;
};
