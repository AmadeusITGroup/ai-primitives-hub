/**
 * `TokenProvider` that reads `GITHUB_TOKEN` (preferred) or `GH_TOKEN`
 * from an injected env bag, returning the token only for GitHub hosts.
 *
 * Equivalent to the reference branch's `infra/src/github/token.ts`'s
 * `envTokenProvider` factory, ported as a class to match this package's
 * established `TokenProvider` implementation pattern (see
 * `GhCliTokenProvider`/`StaticTokenProvider`) and adapted to `core`'s
 * host-aware `TokenProvider.getToken(): Promise<string | undefined>`
 * (the reference's pre-Phase-3b `TokenProvider` returned `string | null`).
 *
 * Wired into the CLI's `defaultTokenProvider` only; the VS Code extension
 * deliberately has no env-var step (users configure
 * `promptregistry.githubToken` instead), so an `env-var` origin appearing
 * in extension logs would indicate a wiring mistake.
 * @module auth/env-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';
import type {
  AuthEventHandler,
  TokenOrigin,
} from './auth-event';
import {
  describeGitHubTokenType,
} from './auth-event';

export class EnvTokenProvider implements TokenProvider {
  public readonly origin: TokenOrigin = 'env-var';

  /**
   * Create a provider over a process-style env map.
   * @param env - Environment variables to read (typically `ctx.env`).
   * @param onAuthEvent - Optional observability sink; see `auth-event.ts`.
   */
  public constructor(
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly onAuthEvent?: AuthEventHandler
  ) {}

  public getToken(host: string): Promise<string | undefined> {
    if (!isGitHubHost(host)) {
      this.onAuthEvent?.({ kind: 'skipped', origin: this.origin, host, reason: 'non-github-host' });
      return Promise.resolve(undefined);
    }

    // Mirror the `??` precedence below exactly, so the reported variable is
    // the one actually consulted: an empty `GITHUB_TOKEN` still shadows
    // `GH_TOKEN` rather than falling through to it.
    const token = this.env.GITHUB_TOKEN ?? this.env.GH_TOKEN;
    const variable = this.env.GITHUB_TOKEN === undefined ? 'GH_TOKEN' : 'GITHUB_TOKEN';
    this.onAuthEvent?.({ kind: 'attempt', origin: this.origin, host, detail: variable });

    if (token === undefined || token.length === 0) {
      this.onAuthEvent?.({ kind: 'skipped', origin: this.origin, host, reason: 'not-set' });
      return Promise.resolve(undefined);
    }

    this.onAuthEvent?.({
      kind: 'resolved',
      origin: this.origin,
      host,
      tokenType: describeGitHubTokenType(token),
      durationMs: 0
    });
    return Promise.resolve(token);
  }
}
