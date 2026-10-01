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
type SessionMode = 'prompt' | 'passive' | 'silent' | 'force' | 'force-select' | 'select';
// Keep native requests until THEY settle: a local timeout cannot cancel VS Code.
const nativeRequests = new Map<SessionMode, Promise<vscode.AuthenticationSession | undefined>>();
let interactiveRequest: { kind: 'select' | 'force'; token: Promise<string | undefined> } | undefined;
let attemptCounter = 0;
let notifiedGeneration = -1;

export class GitHubSessionError extends Error {
  public constructor(public readonly code: 'TIMEOUT' | 'PENDING' | 'CANCELLED' | 'FAILED', message: string) {
    super(message);
    this.name = 'GitHubSessionError';
  }
}

const sessionOptions: Record<SessionMode, vscode.AuthenticationGetSessionOptions> = {
  prompt: { createIfNone: true },
  passive: { createIfNone: false },
  silent: { silent: true },
  force: { forceNewSession: true },
  'force-select': { forceNewSession: true, clearSessionPreference: true },
  select: { createIfNone: true, clearSessionPreference: true }
};

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

  private async resolveToken(mode: SessionMode, scheduledGeneration?: number): Promise<string | undefined> {
    // Interactive lookups run on a deferred microtask, so bind their publication
    // authority to the generation captured when they were *scheduled*. Otherwise
    // a reset between scheduling and start would be invisible here, letting a
    // detached sign-in publish its session over credentials another provider
    // recovered in the new generation.
    const generation = scheduledGeneration ?? cacheGeneration;
    const interactive = mode === 'force' || mode === 'force-select' || mode === 'select';
    const attempt = ++attemptCounter;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (nativeRequests.has(mode)) {
        throw new GitHubSessionError('PENDING', 'A previous GitHub sign-in is still running in VS Code. Complete or close its browser prompt, or reload the window before retrying.');
      }
      this.logger.info(`[GitHubAuth] attempt=${attempt} mode=${mode} phase=session-start`);
      const nativeRequest = Promise.resolve(vscode.authentication.getSession('github', ['repo'], sessionOptions[mode]));
      nativeRequests.set(mode, nativeRequest);
      const release = (): void => {
        if (nativeRequests.get(mode) === nativeRequest) {
          nativeRequests.delete(mode);
        }
      };
      // Register both handlers so late rejections are observed without caching late results.
      void nativeRequest.then(release, release);
      const session = await Promise.race([
        nativeRequest,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new GitHubSessionError('TIMEOUT',
            'GitHub sign-in did not finish within 60 seconds. Check the browser sign-in prompt and GitHub Authentication output. If it remains stuck, reload the window.'
          )), SESSION_TIMEOUT_MS);
        })
      ]);
      if (generation !== cacheGeneration) {
        this.logger.debug(`[GitHubAuth] attempt=${attempt} phase=discarded durationMs=${Date.now() - startedAt}`);
        return undefined;
      }
      if (session) {
        this.logger.info(`[GitHubAuth] attempt=${attempt} mode=${mode} phase=session-ready durationMs=${Date.now() - startedAt}`);
        const entry = {
          token: session.accessToken,
          expiresAt: Date.now() + TOKEN_CACHE_TTL_MS
        };
        tokenCache.set(this.createIfNone, entry);
        if (interactive) {
          tokenCache.set(false, entry);
          tokenCache.set(true, entry);
        }
        return session.accessToken;
      }
      this.logger.debug(`[GitHubAuth] attempt=${attempt} mode=${mode} phase=no-session durationMs=${Date.now() - startedAt}; continuing configured fallback`);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const cancelled = (error instanceof Error && error.name === 'CancellationError')
        || /\bcancel(?:led|ed|lation)?\b|did not consent|user (?:denied|declined)/i.test(message);
      const failure = error instanceof GitHubSessionError
        ? error
        : (cancelled
          ? new GitHubSessionError('CANCELLED', 'GitHub sign-in was cancelled or access was declined.')
          : new GitHubSessionError('FAILED', 'VS Code could not obtain a GitHub session. Check GitHub Authentication output and your VPN/proxy connection.'));
      // Do not log provider error bodies: they can contain tokens or callback URLs.
      const nextStep = interactive ? 'interactive sign-in failed' : 'continuing configured fallback';
      this.logger.warn(`[GitHubAuth] attempt=${attempt} mode=${mode} outcome=${failure.code} durationMs=${Date.now() - startedAt}; ${nextStep}`);
      if (interactive) {
        throw failure;
      }
      if (generation === cacheGeneration && notifiedGeneration !== generation && failure.code !== 'CANCELLED') {
        notifiedGeneration = generation;
        void Promise.resolve(vscode.window.showWarningMessage(
          'GitHub sign-in is unavailable. Other configured authentication will be tried. Open logs for details, or sign in again.',
          'Show Logs', 'Sign In Again'
        )).then((action) => {
          if (action === 'Show Logs') {
            this.logger.show();
          } else if (action === 'Sign In Again') {
            return vscode.commands.executeCommand('promptregistry.forceGitHubAuth');
          }
        }).catch(() => this.logger.warn('[GitHubAuth] Could not show authentication recovery action'));
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
    // Detach any in-flight interactive sign-in so a stalled prompt cannot
    // gate later reads or recovery: `getToken` must not keep returning a
    // pre-reset `interactiveRequest.token` that is still blocked on VS Code.
    // The pending promise is bounded by SESSION_TIMEOUT_MS and self-cleans
    // through its own generation-guarded `release`; dropping the reference
    // only stops new callers from attaching to it.
    interactiveRequest = undefined;
    notifiedGeneration = -1;
  }

  /** Request a fresh session explicitly; cancellation/failure must reach the UI. */
  public static async forceAuthentication(): Promise<void> {
    // Use the supported account-selection option once if a previous forced
    // request is still pending. Never invent options/scopes to defeat sharing.
    await VsCodeSessionTokenProvider.runInteractive(nativeRequests.has('force') ? 'force-select' : 'force');
  }

  /** Bound the first-run account picker using the same coordinator as refresh. */
  public static async selectAccount(): Promise<void> {
    await VsCodeSessionTokenProvider.runInteractive('select');
  }

  private static async runInteractive(mode: SessionMode): Promise<void> {
    const kind = mode === 'select' ? 'select' : 'force';
    if (interactiveRequest && interactiveRequest.kind !== kind) {
      throw new GitHubSessionError('PENDING', 'Another GitHub sign-in or account selection is already in progress. Complete it before retrying this action.');
    }
    if (!interactiveRequest) {
      // A blocked attempt must not discard a session recovered in the meantime.
      if (nativeRequests.has(mode)) {
        throw new GitHubSessionError('PENDING', 'A previous GitHub sign-in is still running in VS Code. Complete or close its browser prompt, or reload the window before retrying.');
      }
      VsCodeSessionTokenProvider.clearCache();
      const scheduledGeneration = cacheGeneration;
      const request = { kind, token: Promise.resolve().then(() => new VsCodeSessionTokenProvider().resolveToken(mode, scheduledGeneration)) } as const;
      interactiveRequest = request;
      const release = (): void => {
        if (interactiveRequest === request) {
          interactiveRequest = undefined;
        }
      };
      void request.token.then(release, release);
    }
    const token = await interactiveRequest.token;
    if (!token) {
      throw new GitHubSessionError('FAILED', 'GitHub authentication did not return a session. Please retry sign-in.');
    }
  }

  public async getToken(host: string): Promise<string | undefined> {
    if (!isGitHubHost(host)) {
      return undefined;
    }

    if (interactiveRequest) {
      // Neither prompting nor passive reads may publish an older session during refresh.
      return interactiveRequest.token.catch(() => undefined);
    }

    const cached = tokenCache.get(this.createIfNone);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const pending = tokenRequests.get(this.createIfNone);
    if (pending) {
      return pending;
    }

    const normalMode = this.createIfNone ? 'prompt' : 'passive';
    // A separate silent lookup can observe a completed browser sign-in without
    // rejoining VS Code's stuck prompt or opening more browser windows.
    const request = this.resolveToken(nativeRequests.has(normalMode) ? 'silent' : normalMode);
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
