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
 *
 * Narrates the chain through an optional `onAuthEvent` handler: which
 * origins are about to be tried, and - the question that used to be
 * unanswerable - the fact that all of them declined. Individual origins
 * report their own outcomes directly to the same handler, so a consumer
 * sees `chain-start`, then each provider's `attempt`/`skipped`/`failed`,
 * then either that provider's `resolved` or this class's
 * `chain-exhausted`.
 * @module auth/composite-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import type {
  AuthEventHandler,
  TokenOrigin,
} from './auth-event';
import {
  isOriginAware,
} from './auth-event';

export class CompositeTokenProvider implements TokenProvider {
  /**
   * Create a chain over an ordered list of providers.
   * @param providers - Tried in order; the first non-`undefined` wins.
   * @param onAuthEvent - Optional observability sink; see `auth-event.ts`.
   * Pass the same handler to the wrapped providers to get a complete
   * picture, since each one reports its own outcome.
   */
  public constructor(
    private readonly providers: readonly TokenProvider[],
    private readonly onAuthEvent?: AuthEventHandler
  ) {}

  /**
   * Origins this chain can attribute, in order. Providers predating the
   * `origin` label (or bare test doubles) are simply absent, which is why
   * this is reported as planned rather than guaranteed.
   */
  private plannedOrigins(): readonly TokenOrigin[] {
    return this.providers.flatMap((provider) => (isOriginAware(provider) ? [provider.origin] : []));
  }

  public async getToken(host: string): Promise<string | undefined> {
    if (this.onAuthEvent === undefined) {
      // Keep the uninstrumented path free of any bookkeeping.
      for (const provider of this.providers) {
        const token = await provider.getToken(host);
        if (token !== undefined) {
          return token;
        }
      }
      return undefined;
    }

    const startedAt = Date.now();
    const plannedOrigins = this.plannedOrigins();
    this.onAuthEvent({ kind: 'chain-start', host, plannedOrigins });

    for (const provider of this.providers) {
      const token = await provider.getToken(host);
      if (token !== undefined) {
        // The winning provider has already emitted its own `resolved`.
        return token;
      }
    }

    this.onAuthEvent({
      kind: 'chain-exhausted',
      host,
      triedOrigins: plannedOrigins,
      durationMs: Date.now() - startedAt
    });
    return undefined;
  }
}
