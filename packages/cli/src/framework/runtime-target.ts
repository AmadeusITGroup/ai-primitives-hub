/**
 * runtime-target helper — composes the shared application session from the
 * command Context. Thin composition only: no ownership, routing or payload
 * business rules live here.
 * @module framework/runtime-target
 */
import * as path from 'node:path';
import {
  createRuntimeTargetSession,
  type RuntimeSessionOptions,
  type RuntimeTargetSession,
} from '@ai-primitives-hub/app';
import type {
  FileSystem,
  RuntimeProjectionFileSystem,
} from '@ai-primitives-hub/core';
import {
  FileSystemLayoutConfigLoader,
  resolveUserConfigDir,
  ScopedRuntimeTargetStore,
  XdgAppStorage,
  xdgConfigDir,
} from '@ai-primitives-hub/infra';
import {
  CLI_VERSION,
} from '../version';
import {
  loadConfig,
} from './config';
import type {
  Context,
} from './context';

export const TARGET_MANAGEMENT_CONFIG_KEY = 'experimental.targetManagement';

/**
 * Gate: the whole namespace is opt-in. Enabled by `experimental.targetManagement: true`
 * in the layered CLI config (user file `$XDG_CONFIG_HOME/ai-primitives-hub/config.yml`).
 * Returns an actionable message when off, null when enabled.
 * @param ctx
 */
export const runtimeTargetGateError = async (ctx: Context): Promise<string | null> => {
  const config = await loadConfig({ cwd: ctx.cwd(), env: ctx.env, fs: ctx.fs });
  const experimental = config.experimental as { targetManagement?: unknown } | undefined;
  return experimental?.targetManagement === true
    ? null
    : `target management is disabled; set ${TARGET_MANAGEMENT_CONFIG_KEY}: true in the CLI config (${xdgConfigDir(ctx.env)}/config.yml)`;
};

/**
 * Whether target management is enabled; an unreadable config counts as off.
 * @param ctx
 */
export const targetManagementEnabled = async (ctx: Context): Promise<boolean> => {
  try {
    return await runtimeTargetGateError(ctx) === null;
  } catch {
    return false;
  }
};

const hasProjectionFs = (fs: FileSystem): fs is RuntimeProjectionFileSystem =>
  typeof (fs as RuntimeProjectionFileSystem).lstat === 'function'
  && typeof (fs as RuntimeProjectionFileSystem).realpath === 'function'
  && typeof (fs as RuntimeProjectionFileSystem).chmod === 'function';

/**
 * Resolve the workspace root: nearest ancestor containing `.git` (file OR
 * directory) walking up from ctx.cwd(), else ctx.cwd() itself. Normalized to
 * an absolute path rooted at ctx.cwd() — never process.cwd().
 * @param ctx
 * @param override
 */
export const resolveWorkspaceRoot = async (ctx: Context, override?: string): Promise<string> => {
  const asAbs = (p: string): string => path.resolve(ctx.cwd(), p);
  if (override !== undefined) {
    const abs = asAbs(override);
    return abs;
  }
  let dir = path.resolve(ctx.cwd());
  for (;;) {
    // `.git` may be a directory (normal clone) or a file (worktree/submodule).
    const probe = path.join(dir, '.git');

    if (await ctx.fs.exists(probe)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(ctx.cwd());
    }
    dir = parent;
  }
};

export interface RuntimeTargetCommandFlags {
  workspaceRoot?: string;
  global?: boolean;
}

/**
 * Build the shared session for this invocation. `global` means no workspace
 * (user-default slot); otherwise workspaceRoot resolves via .git discovery.
 * @param ctx
 * @param flags
 */
export const createRuntimeSession = async (
  ctx: Context,
  flags: RuntimeTargetCommandFlags
): Promise<RuntimeTargetSession> => {
  if (!hasProjectionFs(ctx.fs)) {
    throw new Error('runtime-target requires the projection filesystem port (lstat/realpath/chmod)');
  }
  const storage = new XdgAppStorage(ctx.env);
  const workspaceRoot = flags.global === true
    ? undefined
    : await resolveWorkspaceRoot(ctx, flags.workspaceRoot);
  const layoutCwd = workspaceRoot ?? ctx.env.HOME ?? ctx.env.USERPROFILE;
  if (layoutCwd === undefined || !path.isAbsolute(layoutCwd)) {
    throw new Error('an absolute HOME or USERPROFILE is required for the user-default context');
  }
  const opts: RuntimeSessionOptions = {
    storage,
    store: new ScopedRuntimeTargetStore({
      storage,
      toolVersion: CLI_VERSION,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot })
    }),
    fs: ctx.fs,
    env: ctx.env,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    layoutLoader: new FileSystemLayoutConfigLoader({
      cwd: layoutCwd,
      fs: ctx.fs,
      userConfigDir: resolveUserConfigDir(ctx.env)
    })
  };
  return createRuntimeTargetSession(opts);
};
