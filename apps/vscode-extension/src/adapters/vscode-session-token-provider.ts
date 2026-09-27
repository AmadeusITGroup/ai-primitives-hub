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
 * @module adapters/vscode-session-token-provider
 */
import type {
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

const TOKEN_CACHE_TTL_MS = 30_000;
const SESSION_TIMEOUT_MS = 60_000;
const tokenCache = new Map<boolean, { token: string; expiresAt: number }>();
const tokenRequests = new Map<boolean, Promise<string | undefined>>();
let cacheGeneration = 0;

export class VsCodeSessionTokenProvider implements TokenProvider {
  private readonly logger = Logger.getInstance();

  /**
   * Create a new VsCodeSessionTokenProvider.
   * @param createIfNone - Whether to prompt the user to sign in if no
   * VS Code GitHub session exists yet. Defaults to `true`, matching
   * most of the extension's existing inline auth chains
   * (`github-adapter.ts`, `apm-adapter.ts`, `awesome-copilot-adapter.ts`)
   * - `skills-adapter.ts` is the one exception, passing `false`.
   */
  public constructor(private readonly createIfNone = true) {}

  private async resolveToken(forceNewSession = false): Promise<string | undefined> {
    const generation = cacheGeneration;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.logger.debug('[VsCodeSessionTokenProvider] Trying VS Code GitHub authentication...');
      const session = await Promise.race([
        vscode.authentication.getSession('github', ['repo'], forceNewSession ? { forceNewSession: true } : { createIfNone: this.createIfNone }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('GitHub sign-in timed out after 60 seconds. Check the GitHub Authentication output and VPN/proxy connectivity, then retry.')), SESSION_TIMEOUT_MS);
        })
      ]);
      if (generation !== cacheGeneration) {
        return undefined;
      }
      if (session) {
        this.logger.info('[VsCodeSessionTokenProvider] Using VS Code GitHub authentication');
        tokenCache.set(this.createIfNone, {
          token: session.accessToken,
          expiresAt: Date.now() + TOKEN_CACHE_TTL_MS
        });
        return session.accessToken;
      }
      this.logger.debug('[VsCodeSessionTokenProvider] VS Code auth session not found');
      return undefined;
    } catch (error) {
      this.logger.warn(`[VsCodeSessionTokenProvider] VS Code auth failed: ${error instanceof Error ? error.message : String(error)}`);
      if (forceNewSession) {
        throw error;
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Clear the process-wide session cache after an explicit authentication
   * reset. The cache is shared because the extension creates one provider per
   * source, while VS Code exposes one GitHub session for the host.
   */
  public static clearCache(): void {
    cacheGeneration += 1;
    tokenCache.clear();
    tokenRequests.clear();
  }

  /** Request a fresh session explicitly; cancellation/failure must reach the UI. */
  public static async forceAuthentication(): Promise<void> {
    VsCodeSessionTokenProvider.clearCache();
    const token = await new VsCodeSessionTokenProvider().resolveToken(true);
    if (!token) {
      throw new Error('GitHub authentication did not return a session. Please retry sign-in.');
    }
  }

  public async getToken(host: string): Promise<string | undefined> {
    if (!isGitHubHost(host)) {
      return undefined;
    }

    const cached = tokenCache.get(this.createIfNone);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const pending = tokenRequests.get(this.createIfNone);
    if (pending) {
      return pending;
    }

    const request = this.resolveToken();
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
