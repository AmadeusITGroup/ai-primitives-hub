/**
 * Log-safe rendering of "which credential was used, and where did it come
 * from".
 *
 * Every auth failure in this codebase has to answer that question: a
 * status code says a request failed, but only the credential's origin says
 * what the user should *do* — reset a VS Code session, fix
 * `promptregistry.githubToken`, unset `GITHUB_TOKEN`, or re-run
 * `gh auth login`. Producing that string in one place keeps the wording
 * identical across the hub resolver, the bundle downloader, the GitHub API
 * client, the CLI doctor, and the diagnose command.
 *
 * Token values never appear here, only `redactToken`'s descriptor.
 * @module auth/format-token-origin
 */
import type {
  ResolvedToken,
  TokenOrigin,
} from '@ai-primitives-hub/core';
import {
  redactToken,
} from '../harvest/token-provider';

/**
 * Render a token origin as `kind` or `kind:detail`.
 * @param origin - Origin to render.
 * @returns e.g. `setting:promptregistry.githubToken`, `vscode-session(octocat)`.
 */
export function formatTokenOrigin(origin: TokenOrigin): string {
  if (origin.detail === undefined || origin.detail.length === 0) {
    return origin.kind;
  }
  // A VS Code account label is a name, not an identifier — parenthesised so
  // it reads as "the session belonging to octocat".
  return origin.kind === 'vscode-session'
    ? `${origin.kind}(${origin.detail})`
    : `${origin.kind}:${origin.detail}`;
}

/**
 * Render a resolved credential (or the absence of one) for a log line or
 * an error context.
 * @param resolved - The credential in play, or `undefined` when the
 * request was made anonymously.
 * @returns e.g. `origin=anonymous`, or
 * `origin=vscode-session(octocat) token=***<len=40,tail=9c1e>`.
 */
export function formatCredential(resolved: ResolvedToken | undefined): string {
  if (resolved === undefined) {
    return 'origin=anonymous';
  }
  return `origin=${formatTokenOrigin(resolved.origin)} token=${redactToken(resolved.token)}`;
}
