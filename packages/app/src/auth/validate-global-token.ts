/**
 * Validate a global GitHub credential against `api.github.com` and
 * decide whether the extension/CLI should stop applying it to sources.
 *
 * Ported from `apps/vscode-extension/src/services/registry-manager.ts`'s
 * `ensureGlobalTokenChecked` (probe → interpret → decide). That method
 * mixed this reusable business rule with VS Code-specific concerns
 * (reading `promptregistry.githubToken`, showing a warning notification),
 * which the caller keeps; this use case owns only the orchestration that
 * is the same regardless of delivery layer, so a future CLI can reuse it.
 * @module auth/validate-global-token
 */
import type {
  HttpClient,
  OnLogEvent,
} from '@ai-primitives-hub/core';
import {
  diagnoseGitHubToken,
  formatGitHubTokenReport,
  type GitHubTokenReport,
} from '@ai-primitives-hub/infra';

/**
 * Outcome of validating a global GitHub credential.
 */
export interface GlobalTokenValidation {
  /** True when GitHub rejected the credential outright (401 on `/user`). */
  rejected: boolean;
  /** Full diagnostics report, for logging/user-facing messages. */
  report: GitHubTokenReport;
}

/**
 * Probe a global GitHub credential and decide whether it should be
 * treated as rejected.
 *
 * A stale global token is unusually destructive: applied to *every*
 * GitHub source, it suppresses each adapter's own VS Code-session/`gh`-CLI
 * fallback, turning a perfectly good signed-in session into a 401 on
 * every source — public repositories included. Probing it once up front
 * converts that into a single actionable decision the caller can act on
 * (skip applying the token, warn the user) instead of a 401 per source.
 * @param http HttpClient used to probe `api.github.com`.
 * @param token The configured global token to validate.
 * @param onLog Optional sink for diagnostic log events.
 * @returns Whether the credential was rejected, plus the full report.
 */
export async function validateGlobalToken(
  http: HttpClient,
  token: string,
  onLog?: OnLogEvent
): Promise<GlobalTokenValidation> {
  const report = await diagnoseGitHubToken(http, token);

  if (report.userStatus === 401) {
    onLog?.({
      level: 'warn',
      message: '[validateGlobalToken] The configured GitHub token was rejected by GitHub; '
        + `ignoring it for this session and falling back to another credential: ${formatGitHubTokenReport(report)}`
    });
    return { rejected: true, report };
  }

  onLog?.({ level: 'debug', message: `[validateGlobalToken] Global GitHub token validated: ${formatGitHubTokenReport(report)}` });
  return { rejected: false, report };
}
