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
 * @module auth/env-token-provider
 */
import type {
  ResolvedToken,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';

export class EnvTokenProvider implements TokenProvider {
  public constructor(private readonly env: Readonly<Record<string, string | undefined>>) {}

  public getToken(host: string): Promise<ResolvedToken | undefined> {
    // Reported per variable rather than collapsed into one 'env' label:
    // "which env var is wrong?" is exactly what the user needs to know.
    const candidates: [string, string | undefined][] = [
      ['GITHUB_TOKEN', this.env.GITHUB_TOKEN],
      ['GH_TOKEN', this.env.GH_TOKEN]
    ];
    for (const [variable, token] of candidates) {
      if (token !== undefined && token.length > 0) {
        return Promise.resolve(
          isGitHubHost(host) ? { token, origin: { kind: 'env', detail: variable } } : undefined
        );
      }
    }
    return Promise.resolve(undefined);
  }
}
