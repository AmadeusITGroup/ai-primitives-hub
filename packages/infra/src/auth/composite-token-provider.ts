/**
 * `TokenProvider` that tries a sequence of providers in order and
 * returns the first token any of them resolves.
 *
 * Ported from the fallback-chain *pattern* used by the extension's
 * `src/adapters/{github,awesome-copilot,apm,skills}-adapter.ts` (each
 * hand-rolls the same explicit-token -> VS Code session -> `gh` CLI
 * sequence inline). This class only models the generic "try each in
 * order, stop at the first hit" shape - it has no GitHub-specific
 * knowledge itself, relying entirely on each wrapped `TokenProvider`'s
 * own host-awareness (see `GhCliTokenProvider`/`StaticTokenProvider`)
 * to decide whether it has anything to offer for a given host.
 *
 * Every `TokenProvider` implementation in this codebase only ever
 * resolves a non-empty string or `undefined` (never `null` or an empty
 * string) - this class relies on that contract rather than
 * re-validating it.
 * @module auth/composite-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';

export class CompositeTokenProvider implements TokenProvider {
  public constructor(private readonly providers: readonly TokenProvider[]) {}

  public async getToken(host: string): Promise<string | undefined> {
    for (const provider of this.providers) {
      const token = await provider.getToken(host);
      if (token !== undefined) {
        return token;
      }
    }
    return undefined;
  }
}
