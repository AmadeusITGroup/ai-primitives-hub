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
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '../http/github-host';

export class EnvTokenProvider implements TokenProvider {
  public constructor(private readonly env: Readonly<Record<string, string | undefined>>) {}

  public getToken(host: string): Promise<string | undefined> {
    const token = this.env.GITHUB_TOKEN ?? this.env.GH_TOKEN;
    if (token === undefined || token.length === 0) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(isGitHubHost(host) ? token : undefined);
  }
}
