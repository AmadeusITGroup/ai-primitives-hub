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
  ResolvedToken,
  TokenOrigin,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';

export class StaticTokenProvider implements TokenProvider {
  /**
   * Wrap a literal token as a `TokenProvider`.
   * @param token - The literal token to hand out.
   * @param origin - Where the token came from. Defaults to `explicit`,
   * the case where a caller passed a token in directly (e.g. a per-source
   * `RegistrySource.token`); pass a specific origin when the token was
   * read from somewhere the user can act on, such as a setting.
   */
  public constructor(
    private readonly token: string,
    private readonly origin: TokenOrigin = { kind: 'explicit' }
  ) {}

  public getToken(host: string): Promise<ResolvedToken | undefined> {
    if (this.token.length === 0 || !isGitHubHost(host)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ token: this.token, origin: this.origin });
  }
}
