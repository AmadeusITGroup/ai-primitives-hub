/**
 * User-level config paths.
 *
 * Resolves the on-disk locations for user-scoped registry state
 * (hubs, profile activations, active-hub pointer, optional user
 * targets, user-scope lockfile) per the XDG Base Directory
 * Specification.
 *
 * Delegates the XDG root resolution to `infra`'s `xdgConfigDir`
 * (ADR-0005 decision 2's shared resolver) rather than re-implementing
 * `XDG_CONFIG_HOME`/`~/.config` fallback logic inline as the reference
 * branch's own version of this file does — avoids reintroducing the
 * exact duplication that resolver was created to consolidate. One
 * behavioral difference from the reference's own inline version: the
 * no-`XDG_CONFIG_HOME` fallback is `os.homedir()` (via `xdgConfigDir`),
 * not `env.HOME`/`env.USERPROFILE` — matching every other XDG-based path
 * in this codebase (e.g. the harvest cache dir) rather than diverging
 * from them; a caller wanting a fully-hermetic override should still set
 * `XDG_CONFIG_HOME` itself, which both approaches honour identically.
 * All artifact names here are the CLI's own, not-yet-released state
 * (rebranded per migration plan §8 decision 3 — `prompt-registry` ->
 * `ai-primitives-hub`); this is unrelated to, and does not rename, the
 * pre-existing, production, git-shared repository-scope lockfile
 * (`prompt-registry.lock.json`, resolved elsewhere via `findLockfile`).
 */
import * as path from 'node:path';
import {
  xdgConfigDir,
} from '@ai-primitives-hub/infra';

/** Resolved user-config path roots. */
export interface UserConfigPaths {
  /** ${XDG_CONFIG_HOME:-$HOME/.config}/ai-primitives-hub/ */
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
  /** {root}/ai-primitives-hub.lock.json (user-scope lockfile) */
  userLockfile: string;
}

/**
 * Resolve the user-config paths from an env bag. Pure; no IO.
 * @param env Environment variables (typically `ctx.env`).
 * @returns Resolved paths.
 */
export const resolveUserConfigPaths = (env: Record<string, string | undefined>): UserConfigPaths => {
  const root = xdgConfigDir(env);
  return {
    root,
    hubs: path.join(root, 'hubs'),
    profileActivations: path.join(root, 'profile-activations'),
    activeHub: path.join(root, 'active-hub.json'),
    userTargets: path.join(root, 'targets.yml'),
    tokenCache: path.join(root, 'token'),
    userLockfile: path.join(root, 'ai-primitives-hub.lock.json')
  };
};
