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
 * @module auth/static-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';

export class StaticTokenProvider implements TokenProvider {
  public constructor(private readonly token: string) {}

  public getToken(host: string): Promise<string | undefined> {
    if (this.token.length === 0) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(isGitHubHost(host) ? this.token : undefined);
  }
}
