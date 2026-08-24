/**
 * `TokenProvider` backed by VS Code's built-in GitHub authentication
 * session (`vscode.authentication.getSession('github', ...)`).
 *
 * Bridges the "VS Code session" step of the auth fallback chain
 * documented in `src/adapters/AGENTS.md` into `@ai-primitives-hub/core`'s
 * `TokenProvider` port, so it can be composed with `infra`'s
 * `GhCliTokenProvider`/`StaticTokenProvider` via a `CompositeTokenProvider`
 * once the adapter-unification cutover (migration plan §7.5, Phase 4
 * item 3, decision #10) wires a real chain into `RegistryManager`'s
 * adapters. Kept in the extension rather than `infra` since only the
 * VS Code extension host may import `vscode` (same reasoning already
 * documented on `infra`'s `GhCliTokenProvider`).
 *
 * Reports itself as the `ide-session` origin and, uniquely among the
 * origins, can report the token's granted scopes: VS Code hands them over
 * on the session object, whereas an `env-var`, `configured-token`, or
 * `gh-cli` token would need GitHub's `x-oauth-scopes` response header to
 * reveal the same thing. Since a missing `repo` scope is a routine cause
 * of a 403 on a private source, that makes this the one origin whose
 * `resolved` event can pre-empt the question.
 * @module adapters/vscode-session-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import type {
  AuthEventHandler,
  TokenOrigin,
} from '@ai-primitives-hub/infra';
import {
  describeGitHubTokenType,
  isGitHubHost,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  createAuthEventLogger,
} from './auth-event-logger';

const TOKEN_CACHE_TTL_MS = 30_000;
const tokenCache = new Map<boolean, { token: string; expiresAt: number; scopes: readonly string[] }>();
const tokenRequests = new Map<boolean, Promise<string | undefined>>();

export class VsCodeSessionTokenProvider implements TokenProvider {
  public readonly origin: TokenOrigin = 'ide-session';

  /**
   * Create a new VsCodeSessionTokenProvider.
   * @param createIfNone - Whether to prompt the user to sign in if no
   * VS Code GitHub session exists yet. Defaults to `true`, matching
   * most of the extension's existing inline auth chains
   * (`github-adapter.ts`, `apm-adapter.ts`, `awesome-copilot-adapter.ts`)
   * - `skills-adapter.ts` is the one exception, passing `false`.
   * @param onAuthEvent - Observability sink. Defaults to the output-channel
   * logger so that a construction site which has not been given a
   * source-scoped handler still narrates its resolution rather than
   * falling silent.
   */
  public constructor(
    private readonly createIfNone = true,
    private readonly onAuthEvent: AuthEventHandler = createAuthEventLogger()
  ) {}

  private async resolveToken(host: string): Promise<string | undefined> {
    const startedAt = Date.now();
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: this.createIfNone });
      if (session) {
        tokenCache.set(this.createIfNone, {
          token: session.accessToken,
          expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
          scopes: session.scopes
        });
        this.onAuthEvent({
          kind: 'resolved',
          origin: this.origin,
          host,
          tokenType: describeGitHubTokenType(session.accessToken),
          scopes: session.scopes,
          durationMs: Date.now() - startedAt
        });
        return session.accessToken;
      }
      this.onAuthEvent({
        kind: 'skipped',
        origin: this.origin,
        host,
        reason: 'no-session',
        durationMs: Date.now() - startedAt
      });
      return undefined;
    } catch (error) {
      this.onAuthEvent({
        kind: 'failed',
        origin: this.origin,
        host,
        reason: 'unknown',
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt
      });
      return undefined;
    }
  }

  /**
   * Clear the process-wide session cache after an explicit authentication
   * reset. The cache is shared because the extension creates one provider per
   * source, while VS Code exposes one GitHub session for the host.
   */
  public static clearCache(): void {
    tokenCache.clear();
  }

  public async getToken(host: string): Promise<string | undefined> {
    if (!isGitHubHost(host)) {
      this.onAuthEvent({ kind: 'skipped', origin: this.origin, host, reason: 'non-github-host' });
      return undefined;
    }

    // Reported on every call, cache hit or not: the 30s cache and the
    // in-flight dedupe below used to make a busy sync look like a single
    // resolution, which is why one log line covered a whole session.
    const cached = tokenCache.get(this.createIfNone);
    if (cached && cached.expiresAt > Date.now()) {
      this.onAuthEvent({
        kind: 'attempt',
        origin: this.origin,
        host,
        cached: true,
        detail: `createIfNone=${String(this.createIfNone)}`
      });
      this.onAuthEvent({
        kind: 'resolved',
        origin: this.origin,
        host,
        tokenType: describeGitHubTokenType(cached.token),
        scopes: cached.scopes,
        durationMs: 0,
        cached: true
      });
      return cached.token;
    }

    const pending = tokenRequests.get(this.createIfNone);
    if (pending) {
      this.onAuthEvent({
        kind: 'attempt',
        origin: this.origin,
        host,
        cached: true,
        detail: `joined in-flight request, createIfNone=${String(this.createIfNone)}`
      });
      // Report the shared request's outcome under *this* host too. Without
      // it, a host that joins rather than initiates logs an attempt and no
      // resolution - which is what hub resolution does when it consults
      // api.github.com and raw.githubusercontent.com back to back.
      const joinedToken = await pending;
      if (joinedToken === undefined) {
        this.onAuthEvent({ kind: 'skipped', origin: this.origin, host, reason: 'no-session', durationMs: 0 });
        return undefined;
      }
      this.onAuthEvent({
        kind: 'resolved',
        origin: this.origin,
        host,
        tokenType: describeGitHubTokenType(joinedToken),
        scopes: tokenCache.get(this.createIfNone)?.scopes,
        durationMs: 0,
        cached: true
      });
      return joinedToken;
    }

    this.onAuthEvent({
      kind: 'attempt',
      origin: this.origin,
      host,
      detail: `createIfNone=${String(this.createIfNone)}`
    });

    const request = this.resolveToken(host);
    tokenRequests.set(this.createIfNone, request);
    try {
      return await request;
    } finally {
      if (tokenRequests.get(this.createIfNone) === request) {
        tokenRequests.delete(this.createIfNone);
      }
    }
  }
}
