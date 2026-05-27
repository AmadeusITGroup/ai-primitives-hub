/**
 * Host-aware async TokenProvider for GitHub interactions.
 *
 * Consolidates the lib's previous `install/http.ts` token surface
 * with a simpler, dependency-injectable shape:
 *
 *   - `TokenProvider`       — the interface every consumer uses.
 *   - `staticTokenProvider` — single literal token (for tests).
 *   - `envTokenProvider`    — reads `GITHUB_TOKEN` / `GH_TOKEN`.
 *   - `ghCliTokenProvider`  — shells out to `gh auth token` (lazy spawn).
 *   - `compositeTokenProvider` — chain providers in priority order.
 *   - `NULL_TOKEN_PROVIDER`  — returns null for everything.
 *
 * `spawn` injection on `ghCliTokenProvider` keeps the test path
 * fully synchronous and dependency-free.
 * @module github/token
 */
import type {
  TokenProvider,
} from '@prompt-registry/core';
import {
  isGitHubHost,
} from './url';

export type {
  TokenProvider,
} from '@prompt-registry/core';

/** Token provider that always returns null (public-only). */
export const NULL_TOKEN_PROVIDER: TokenProvider = {
  getToken: (): Promise<string | null> => Promise.resolve(null)
};

/**
 * Provider that returns a literal token for any GitHub host. Useful
 * in tests and when the caller already has a token in hand.
 * @param token Bearer token (empty -> always returns null).
 * @returns TokenProvider.
 */
export const staticTokenProvider = (token: string): TokenProvider => ({
  getToken: (host: string): Promise<string | null> => {
    if (token.length === 0) {
      return Promise.resolve(null);
    }
    return Promise.resolve(isGitHubHost(host) ? token : null);
  }
});

/**
 * Compose multiple TokenProviders. Returns the first non-empty
 * token. Empty-string tokens are treated as null and the chain
 * continues — this matches what users intuitively want when env
 * vars are set to empty.
 * @param providers Providers in priority order.
 * @returns Composite TokenProvider.
 */
export const compositeTokenProvider = (
  ...providers: readonly TokenProvider[]
): TokenProvider => ({
  getToken: async (host: string): Promise<string | null> => {
    for (const p of providers) {
      const t = await p.getToken(host);
      if (t !== null && t.length > 0) {
        return t;
      }
    }
    return null;
  }
});

/**
 * Reads `GITHUB_TOKEN` (preferred) or `GH_TOKEN` from an env bag.
 * Returns the token only for GitHub hosts; foreign hosts get null.
 * @param env Process env to read from.
 * @returns TokenProvider.
 */
export const envTokenProvider = (
  env: Record<string, string | undefined>
): TokenProvider => ({
  getToken: (host: string): Promise<string | null> => {
    const t = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? null;
    if (t === null || t.length === 0) {
      return Promise.resolve(null);
    }
    if (isGitHubHost(host)) {
      return Promise.resolve(t);
    }
    return Promise.resolve(null);
  }
});

/** Result shape from `gh auth token` (subset of node's spawnSync). */
export interface GhSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface GhCliTokenProviderOptions {
  /**
   * Test seam — invoked instead of `child_process.spawnSync`. When
   * absent (production path), the provider lazy-imports the real
   * spawnSync.
   */
  spawn?: () => GhSpawnResult;
}

/**
 * Provider that shells out to `gh auth token`. Returns null on any
 * failure (gh not installed, not logged in, timeout). Never throws.
 * Skips the spawn entirely for non-GitHub hosts so calling it on a
 * tight loop against arbitrary URLs stays cheap.
 * @param opts Optional spawn injection.
 * @returns TokenProvider.
 */
export const ghCliTokenProvider = (
  opts: GhCliTokenProviderOptions = {}
): TokenProvider => ({
  getToken: async (host: string): Promise<string | null> => {
    if (!isGitHubHost(host)) {
      return null;
    }
    try {
      const result = opts.spawn === undefined
        ? await defaultGhSpawn()
        : opts.spawn();
      if (result.status !== 0) {
        return null;
      }
      const tok = result.stdout.trim();
      return tok.length > 0 ? tok : null;
    } catch {
      return null;
    }
  }
});

const defaultGhSpawn = async (): Promise<GhSpawnResult> => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000
  });
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : ''
  };
};

/**
 * Default token provider: env vars first, then `gh` CLI fallback.
 * `PROMPT_REGISTRY_DISABLE_GH_CLI=1` disables the gh fallback —
 * useful for testing the unauth code path in CI.
 * @param env Process env.
 * @returns Composite provider.
 */
export const defaultTokenProvider = (
  env: Record<string, string | undefined>
): TokenProvider => {
  const envP = envTokenProvider(env);
  if (env.PROMPT_REGISTRY_DISABLE_GH_CLI === '1') {
    return envP;
  }
  return compositeTokenProvider(envP, ghCliTokenProvider());
};
