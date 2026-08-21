/**
 * `TokenProvider` that always returns the same literal token for any
 * GitHub host, and `undefined` for everything else.
 *
 * Used by `hub-harvester.ts` to wrap a token already resolved once via
 * `harvest/token-provider.ts`'s `resolveGithubToken` (explicit -> env ->
 * `gh` CLI) into the `core` `TokenProvider` port shape `GitHubApiClient`
 * expects. Equivalent to the reference branch's
 * `infra/src/github/token.ts`'s `staticTokenProvider` factory, ported as
 * a class to match this package's established `TokenProvider`
 * implementation pattern (see `GhCliTokenProvider`) and adapted to
 * `core`'s host-aware `TokenProvider.getToken(): Promise<string |
 * undefined>` (the reference's pre-Phase-3b `TokenProvider` returned
 * `string | null`).
 *
 * Reports itself as the `configured-token` origin (see `auth-event.ts`)
 * because in the extension this is the provider that carries the user's
 * `promptregistry.githubToken` setting - `create-source-adapter.ts` wraps
 * `source.token` in one of these, and `enrichSourceWithGlobalToken` folds
 * the setting into `source.token`. A silent win here used to be
 * indistinguishable from having no token at all.
 * @module auth/static-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isAzureDevOpsHost,
} from '../http/azure-devops-host';
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

export class StaticTokenProvider implements TokenProvider {
  public readonly origin: TokenOrigin = 'configured-token';

  /**
   * Create a provider around an already-resolved token.
   * @param token - The token to hand out. Empty means "not configured".
   * @param onAuthEvent - Optional observability sink; see `auth-event.ts`.
   */
  public constructor(
    private readonly token: string,
    private readonly onAuthEvent?: AuthEventHandler
  ) {}

  public getToken(host: string): Promise<string | undefined> {
    if (!isGitHubHost(host) && !isAzureDevOpsHost(host)) {
      this.onAuthEvent?.({ kind: 'skipped', origin: this.origin, host, reason: 'non-github-host' });
      return Promise.resolve(undefined);
    }

    this.onAuthEvent?.({ kind: 'attempt', origin: this.origin, host });

    if (this.token.length === 0) {
      this.onAuthEvent?.({ kind: 'skipped', origin: this.origin, host, reason: 'not-set' });
      return Promise.resolve(undefined);
    }

    this.onAuthEvent?.({
      kind: 'resolved',
      origin: this.origin,
      host,
      tokenType: describeGitHubTokenType(this.token),
      durationMs: 0
    });
    return Promise.resolve(this.token);
  }
}
