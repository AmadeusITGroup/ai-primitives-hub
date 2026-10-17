/**
 * XDG Base Directory resolution — shared by every `infra` module that
 * needs a per-user config/cache/data directory, so there is exactly one
 * place that knows the env var names and POSIX fallback paths (ADR-0005
 * decision 2: consolidate what used to be two independent, ad hoc XDG
 * resolvers — `harvest/default-paths.ts`'s `defaultCacheDir()` and
 * `stores/layout-config-store.ts`'s `resolveUserConfigDir()`).
 *
 * All functions are pure: they take an explicit env map (so tests don't
 * mutate `process.env`) and default to `process.env` at call sites. The
 * home-directory fallback also comes from that map (`HOME`, or
 * `USERPROFILE` on Windows — the same variables `os.homedir()` reads), so
 * a caller that injects a sandboxed env is never routed to the process
 * owner's real home. `os.homedir()` is only the last resort.
 * @module storage/xdg-base-dirs
 */
import * as os from 'node:os';
import * as path from 'node:path';

/* eslint-disable @typescript-eslint/naming-convention -- env var names are
   SHOUTING_SNAKE_CASE by OS convention; we mirror them verbatim. */
export interface XdgEnv {
  XDG_DATA_HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_CACHE_HOME?: string;
  /** Explicit override for this CLI family's cache dir, takes precedence over XDG_CACHE_HOME. */
  AI_PRIMITIVES_HUB_CACHE?: string;
  /** Home directory on POSIX; the fallback base when an XDG var is unset. */
  HOME?: string;
  /** Home directory on Windows; the fallback base when an XDG var is unset. */
  USERPROFILE?: string;
}
/* eslint-enable @typescript-eslint/naming-convention */

export const APP_SUBDIR = 'ai-primitives-hub';

/**
 * Home directory for the XDG fallbacks. Honours the injected env first,
 * mirroring `os.homedir()`'s own lookup (`USERPROFILE` on Windows, `HOME`
 * elsewhere), so the result is unchanged for `process.env` callers.
 * @param env
 */
function homeDir(env: XdgEnv): string {
  const injected = process.platform === 'win32' ? env.USERPROFILE : env.HOME;
  return injected !== undefined && injected !== '' ? injected : os.homedir();
}

/**
 * User-level data directory (persistent app data: installed-bundle
 * records, profiles, logs). Respects `XDG_DATA_HOME`, falls back to
 * `~/.local/share/ai-primitives-hub`.
 * @param env
 */
export function xdgDataDir(env: XdgEnv = process.env): string {
  const base = env.XDG_DATA_HOME ?? path.join(homeDir(env), '.local', 'share');
  return path.join(base, APP_SUBDIR);
}

/**
 * User-level config directory. Respects `XDG_CONFIG_HOME`, falls back
 * to `~/.config/ai-primitives-hub`.
 * @param env
 */
export function xdgConfigDir(env: XdgEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME ?? path.join(homeDir(env), '.config');
  return path.join(base, APP_SUBDIR);
}

/**
 * User-level cache directory. Precedence: `AI_PRIMITIVES_HUB_CACHE`
 * (explicit override) > `XDG_CACHE_HOME` > `~/.cache/ai-primitives-hub`.
 * @param env
 */
export function xdgCacheDir(env: XdgEnv = process.env): string {
  if (env.AI_PRIMITIVES_HUB_CACHE) {
    return env.AI_PRIMITIVES_HUB_CACHE;
  }
  const base = env.XDG_CACHE_HOME ?? path.join(homeDir(env), '.cache');
  return path.join(base, APP_SUBDIR);
}
