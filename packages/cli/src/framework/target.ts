/**
 * Target-related utilities for CLI commands.
 *
 * Centralizes target resolution logic to reduce duplication across commands.
 *
 * Lockfile paths resolved here belong to the legacy 2.0.0 store; repository
 * `install` and `uninstall` use the install record (`framework/install-record.ts`).
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
 * Resolve the older 2.0.0 lockfile path for a target's scope (not the install record).
 * Only workspace scope still records installs here; repository paths serve old-file fallbacks.
 * `repository` scope uses `prompt-registry.lock.json` or
 * `prompt-registry.local.lock.json` under `target.rootPath` (else `ctx.cwd()`);
 * every other scope the CLI's old user lockfile.
 * @param ctx CLI context.
 * @param target Target being installed into / uninstalled from.
 * @param commitMode Effective commit mode; only consulted for `repository` scope.
 *   Defaults to `target.commitMode ?? 'commit'`.
 * @returns Absolute path of the older lockfile.
 */
export const lockfilePathForTarget = (ctx: Context, target: Target, commitMode?: RepositoryCommitMode): string => {
  if (target.scope === 'repository') {
    const mode = commitMode ?? target.commitMode ?? 'commit';
    return getLockfilePathForMode(target.rootPath ?? ctx.cwd(), mode);
  }
  return resolveUserConfigPaths(ctx.env).userLockfile;
};
