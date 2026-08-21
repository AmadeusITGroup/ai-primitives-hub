/**
 * Default `TokenProvider` wiring: env vars first, then `gh` CLI fallback.
 *
 * `AI_PRIMITIVES_HUB_DISABLE_GH_CLI=1` disables the `gh` fallback —
 * useful for testing the unauthenticated code path in CI. Rebranded
 * from the reference branch's `PROMPT_REGISTRY_DISABLE_GH_CLI` per
 * migration plan §8 decision 3 (CLI-only, unreleased env var).
 *
 * A plain composing function rather than a class, consistent with this
 * package's other "wire concrete providers together" helpers (e.g.
 * `app`'s `create-source-adapter.ts`'s `buildSourceTokenProvider`) — it
 * has no token-resolution strategy of its own, only assembly.
 * @module auth/default-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import type {
  AuthEventHandler,
} from './auth-event';
import {
  CompositeTokenProvider,
} from './composite-token-provider';
import {
  EnvTokenProvider,
} from './env-token-provider';
import {
  GhCliTokenProvider,
} from './gh-cli-token-provider';

/**
 * Build the default TokenProvider: env vars first, then `gh` CLI.
 * @param env Process env (typically `ctx.env`).
 * @param onAuthEvent Optional observability sink, threaded through to
 * every provider in the chain so a caller such as `doctor` can report
 * which origin won. See `auth-event.ts`.
 * @returns Composite TokenProvider.
 */
export const defaultTokenProvider = (
  env: Readonly<Record<string, string | undefined>>,
  onAuthEvent?: AuthEventHandler
): TokenProvider => {
  const envProvider = new EnvTokenProvider(env, onAuthEvent);
  if (env.AI_PRIMITIVES_HUB_DISABLE_GH_CLI === '1') {
    return envProvider;
  }
  return new CompositeTokenProvider(
    [envProvider, new GhCliTokenProvider(undefined, onAuthEvent)],
    onAuthEvent
  );
};
