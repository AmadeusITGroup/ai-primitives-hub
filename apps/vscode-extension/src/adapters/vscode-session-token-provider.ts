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
  ResolvedToken,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  isGitHubHost,
  redactToken,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

/**
 * Scopes every GitHub session this extension requests must carry; private
 * hubs and repositories are unreadable without `repo`. Single source of
 * truth for the scope list, shared with the account picker
 * (`utils/github-account-prompt.ts`) and the force-auth command.
 */
export const GITHUB_REQUIRED_SCOPES = ['repo'];

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

  public async getToken(host: string): Promise<ResolvedToken | undefined> {
    if (!isGitHubHost(host)) {
      return undefined;
    }
    try {
      this.logger.debug(`[VsCodeSessionTokenProvider] Trying VS Code GitHub authentication for ${host} (scopes=[${GITHUB_REQUIRED_SCOPES.join(', ')}], createIfNone=${this.createIfNone})...`);
      const session = await vscode.authentication.getSession('github', GITHUB_REQUIRED_SCOPES, { createIfNone: this.createIfNone });
      if (session) {
        // Which account and which token, in every log where a later 404
        // might turn out to be a credential problem: the account label
        // catches "signed in with the wrong account" (common with a
        // personal account and an org-managed one both present), the
        // redacted descriptor lets the token be matched against
        // `gh auth token`, and `session.scopes` is what VS Code actually
        // granted - which can be narrower than what was requested when a
        // pre-existing session is reused.
        this.logger.info(
          `[VsCodeSessionTokenProvider] Using VS Code GitHub authentication (account=${session.account.label}, `
          + `grantedScopes=[${session.scopes.join(', ')}], token=${redactToken(session.accessToken)})`
        );
        const missingScopes = GITHUB_REQUIRED_SCOPES.filter((scope) => !session.scopes.includes(scope));
        if (missingScopes.length > 0) {
          this.logger.warn(
            `[VsCodeSessionTokenProvider] Session is missing required scope(s): ${missingScopes.join(', ')}. `
            + 'Private repositories will answer 404 rather than 403. Run "AI Primitives Hub: Diagnose GitHub Authentication" to confirm, '
            + 'then "AI Primitives Hub: Force GitHub Authentication" to mint a new session.'
          );
        }
        return {
          token: session.accessToken,
          // The account label is what distinguishes "signed in with the
          // wrong account" from "the token is broken", so it travels with
          // the credential rather than only appearing in this one log line.
          origin: { kind: 'vscode-session', detail: session.account.label }
        };
      }
      this.logger.debug('[VsCodeSessionTokenProvider] VS Code auth session not found');
      return undefined;
    } catch (error) {
      this.logger.warn(`[VsCodeSessionTokenProvider] VS Code auth failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}
