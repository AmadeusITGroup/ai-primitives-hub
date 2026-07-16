/**
 * Default filesystem paths for the primitive-index CLI, following
 * XDG Base Directory spec with explicit env overrides.
 *
 * Precedence (highest to lowest):
 *   1. `AI_PRIMITIVES_HUB_CACHE`     — explicit override for this CLI family
 *   2. `XDG_CACHE_HOME`              — platform-default user cache dir
 *   3. `~/.cache/ai-primitives-hub`  — XDG fallback on POSIX
 *
 * All functions are pure: they take an explicit `DefaultPathEnv` (so tests
 * don't mutate `process.env`) and default to `process.env` at call sites.
 * On Windows we still honour `XDG_CACHE_HOME` for parity — users who have
 * not set it fall through to `~/.cache/ai-primitives-hub`, which is a
 * reasonable convention on all platforms.
 *
 * Ported from the reference branch's `infra/src/harvest/default-paths.ts`,
 * rebranded per migration plan §8 decision 3 (CLI-only, unreleased
 * artifact — `PROMPT_REGISTRY_CACHE` -> `AI_PRIMITIVES_HUB_CACHE`,
 * `prompt-registry` subdir -> `ai-primitives-hub`).
 * @module harvest/default-paths
 */

import * as path from 'node:path';
import {
  xdgCacheDir,
} from '../storage/xdg-base-dirs';

/* eslint-disable @typescript-eslint/naming-convention -- env var names are
   SHOUTING_SNAKE_CASE by OS convention; we mirror them verbatim. */
export interface DefaultPathEnv {
  AI_PRIMITIVES_HUB_CACHE?: string;
  XDG_CACHE_HOME?: string;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * The user-level cache directory for all ai-primitives-hub CLI tools. The
 * primitive-index CLI places its working state (blob cache, progress log,
 * serialised index) under this directory.
 *
 * Thin wrapper around the shared `xdgCacheDir` resolver (ADR-0005
 * decision 2) — kept as its own named export/signature since callers
 * throughout `harvest/*` already depend on it.
 * @param env
 */
export function defaultCacheDir(env: DefaultPathEnv = process.env): string {
  return xdgCacheDir(env);
}

/**
 * The default on-disk serialised index, used when the user does not pass
 * `--index`. It lives at the top of the cache dir (not per-hub) so that
 * `search` / `stats` / `shortlist` work without any extra flags.
 * @param env
 */
export function defaultIndexFile(env: DefaultPathEnv = process.env): string {
  return path.join(defaultCacheDir(env), 'primitive-index.json');
}

/**
 * The per-hub cache directory (blob cache + progress log + etag store).
 * We namespace by hub id so multiple hubs can coexist, and sanitise the
 * id to make it filesystem-safe (slashes/spaces/quotes → underscore).
 * @param hubId Hub identifier, typically `owner/repo`. Undefined or empty
 *              resolves to `local` (CLI uses this when `--no-hub-config`).
 * @param env
 */
export function defaultHubCacheDir(hubId: string | undefined, env: DefaultPathEnv = process.env): string {
  const id = (hubId && hubId.trim().length > 0) ? hubId : 'local';
  const sanitised = id.replaceAll(/[^a-zA-Z0-9._-]/gu, '_');
  return path.join(defaultCacheDir(env), 'hubs', sanitised);
}

/**
 * The default progress log path, used when the user does not pass
 * `--progress`. One file per hub.
 * @param hubId
 * @param env
 */
export function defaultProgressFile(hubId: string | undefined, env: DefaultPathEnv = process.env): string {
  return path.join(defaultHubCacheDir(hubId, env), 'progress.jsonl');
}
