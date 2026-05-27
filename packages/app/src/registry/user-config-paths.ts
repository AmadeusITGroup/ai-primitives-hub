/**
 * User-level config paths.
 *
 * Resolves the on-disk locations for user-scoped registry state
 * (hubs, profile activations, active-hub pointer, optional user
 * targets) per the XDG Base Directory Specification.
 */
import * as path from 'node:path';

/** Resolved user-config path roots. */
export interface UserConfigPaths {
  /** ${XDG_CONFIG_HOME:-$HOME/.config}/prompt-registry/ */
  root: string;
  /** {root}/hubs/ */
  hubs: string;
  /** {root}/profile-activations/ */
  profileActivations: string;
  /** {root}/active-hub.json */
  activeHub: string;
  /** {root}/targets.yml (optional user targets file) */
  userTargets: string;
  /** {root}/token (token cache) */
  tokenCache: string;
  /** {root}/prompt-registry.lock.json (user-scope lockfile) */
  userLockfile: string;
}

/**
 * Resolve the user-config paths from an env bag. Pure; no IO.
 * @param env Environment variables (typically `ctx.env`).
 * @returns Resolved paths.
 */
export const resolveUserConfigPaths = (env: Record<string, string | undefined>): UserConfigPaths => {
  const xdg = env.XDG_CONFIG_HOME;
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const base = xdg !== undefined && xdg.length > 0
    ? xdg
    : path.join(home, '.config');
  const root = path.join(base, 'prompt-registry');
  return {
    root,
    hubs: path.join(root, 'hubs'),
    profileActivations: path.join(root, 'profile-activations'),
    activeHub: path.join(root, 'active-hub.json'),
    userTargets: path.join(root, 'targets.yml'),
    tokenCache: path.join(root, 'token'),
    userLockfile: path.join(root, 'prompt-registry.lock.json')
  };
};
