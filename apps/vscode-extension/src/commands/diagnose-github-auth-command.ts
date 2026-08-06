/**
 * Command that explains *why* GitHub access is failing, for one target.
 *
 * Exists because the symptom users actually see is a 404 on
 * `raw.githubusercontent.com` ("Failed to download bundle: … 404"), which is
 * the same answer GitHub gives for a missing file, a rejected token, a token
 * without the `repo` scope, a token that is not SSO-authorized for the
 * owning organization, and an account that isn't a member of that
 * organization. The status code cannot tell those apart; `api.github.com`
 * can, so this command probes it with the exact credential a fetch would
 * use.
 *
 * Targeted only: it diagnoses the repository the caller names (the URL from
 * the failure), plus one control probe against known-public raw content.
 * There is no "sweep every configured source" mode — that duplicated the
 * adapters' knowledge of which source types are GitHub-hosted, and answered
 * a question nobody asked at the moment something failed.
 *
 * Read-only: it resolves and probes, never writes, and never signs the user
 * in (`createIfNone: false`) — diagnosing a freshly minted session would
 * report on a credential that wasn't the one that failed. The remediation
 * it offers is `promptregistry.forceGitHubAuth`, which mints a new session
 * token and lets the user switch accounts.
 * @module commands/diagnose-github-auth-command
 */
import type {
  ResolvedToken,
} from '@ai-primitives-hub/core';
import {
  diagnoseGitHubToken,
  formatCredential,
  formatGitHubTokenReport,
  formatRawContentProbe,
  isDefaultHub,
  probeRawContentWithCredential,
} from '@ai-primitives-hub/infra';
import type {
  GitHubTokenReport,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  githubDiagnosticsTokenProvider,
  sharedHttpClient,
} from '../adapters/infra-adapter-factory';
import {
  Logger,
} from '../utils/logger';

/**
 * Control URL for `probeRawContentWithCredential`.
 *
 * Deliberately a constant, and deliberately not the recommended default
 * hub: the control only proves anything if it is *unambiguously* public,
 * and the recommended hub is a private Amadeus repository, which would make
 * "the control failed" indistinguishable from "no access to that repo".
 */
const PUBLIC_CONTROL_URL = 'https://raw.githubusercontent.com/AmadeusITGroup/prompt-registry-config/main/README.md';

const RESET_TOKEN = 'Reset GitHub Token';
const SHOW_LOGS = 'Show Logs';

/**
 * What to diagnose. Supplied by whatever just failed - typically the raw
 * URL from the error, which already names the repository.
 */
export interface DiagnoseGitHubAuthTarget {
  /** Any github.com or raw.githubusercontent.com URL from the failure. */
  url?: string;
  /** Human-readable name of the failing thing, for the log line. */
  label?: string;
}

/**
 * Extract `owner/repo` from a GitHub URL.
 *
 * Handles both source URLs (`https://github.com/owner/repo[.git]`) and the
 * raw content URLs that appear in download failures
 * (`https://raw.githubusercontent.com/owner/repo/main/collections/x.yml`),
 * since the latter is what the error hands us.
 * @param url - URL to parse.
 * @returns `owner/repo`, or undefined when the URL isn't a GitHub repo URL.
 */
export function parseRepoLocation(url: string): string | undefined {
  const match = /(?:github\.com|raw\.githubusercontent\.com|codeload\.github\.com)[/:]([^/]+)\/([^/?#]+)/
    .exec(url.replace(/\.git(?=$|[/?#])/, ''));
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

export class DiagnoseGitHubAuthCommand {
  private readonly logger = Logger.getInstance();

  /**
   * Surface a verdict with the one action that can fix a bad credential.
   * @param message - Verdict to show.
   */
  private async offerRemediation(message: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(message, RESET_TOKEN, SHOW_LOGS);
    if (choice === RESET_TOKEN) {
      await vscode.commands.executeCommand('promptregistry.forceGitHubAuth');
    } else if (choice === SHOW_LOGS) {
      this.logger.show();
    }
  }

  /**
   * Report the expected case: a valid credential whose account simply
   * cannot see one of the hubs this extension ships by default. Logged at
   * `info`, reported as information — it is not an error.
   * @param location - `owner/repo` that is not visible.
   * @param credential - Credential in effect.
   * @param report - Credential diagnosis.
   */
  private async reportExpectedNoAccess(
    location: string,
    credential: ResolvedToken,
    report: GitHubTokenReport
  ): Promise<void> {
    this.logger.info(`[DiagnoseGitHubAuth] ⓘ Hub not available to this account: github:${location}`);
    this.logger.info(`[DiagnoseGitHubAuth]   Credential: ${formatCredential(credential)}`);
    this.logger.info(`[DiagnoseGitHubAuth]   ${report.verdict}`);
    this.logger.info('[DiagnoseGitHubAuth]   Expected for accounts outside the owning organization. This is not an error.');
    await vscode.window.showInformationMessage(
      `Your GitHub account cannot see ${location}, one of the default hubs. `
      + 'This is expected outside the owning organization and is not an error — import a custom hub instead.'
    );
  }

  /**
   * Control experiment against content that is unambiguously public: the
   * only way to prove empirically that GitHub is rejecting the credential
   * on the host that actually serves bundles.
   * @param credential - Credential to test.
   * @returns The probe verdict.
   */
  private async runControlProbe(credential: ResolvedToken): Promise<string> {
    const probe = await probeRawContentWithCredential(sharedHttpClient, credential.token, PUBLIC_CONTROL_URL);
    this.logger.info(`[DiagnoseGitHubAuth] Public control probe: ${formatRawContentProbe(probe)}`);
    return probe.verdict;
  }

  /**
   * Report that the credential reaches what was asked about.
   * @param credential - Credential in effect.
   * @param scope - What was probed.
   * @param controlVerdict - Control probe verdict, when one ran.
   */
  private async reportHealthy(
    credential: ResolvedToken,
    scope: string,
    controlVerdict: string | undefined
  ): Promise<void> {
    if (controlVerdict !== undefined && !controlVerdict.startsWith('the credential is accepted')) {
      // api.github.com is happy but raw content is not: the credential
      // works, yet the host that actually serves bundles disagrees.
      await this.offerRemediation(controlVerdict);
      return;
    }
    const message = `GitHub authentication looks healthy (${formatCredential(credential)} can reach ${scope}).`;
    this.logger.info(`[DiagnoseGitHubAuth] ${message}`);
    // Still offer the reset: "the credential is fine" is a verdict the user
    // may not believe, and resetting is cheap and non-destructive.
    if (await vscode.window.showInformationMessage(message, RESET_TOKEN, SHOW_LOGS) === RESET_TOKEN) {
      await vscode.commands.executeCommand('promptregistry.forceGitHubAuth');
    }
  }

  /**
   * Diagnose the credential against the target repository.
   * @param target - The failing target; its URL names the repository.
   */
  public async execute(target?: DiagnoseGitHubAuthTarget): Promise<void> {
    this.logger.show();
    this.logger.info('[DiagnoseGitHubAuth] Diagnosing GitHub authentication...');

    try {
      const location = target?.url === undefined ? undefined : parseRepoLocation(target.url);
      if (target?.url !== undefined && location === undefined) {
        this.logger.debug(`[DiagnoseGitHubAuth] Target URL is not a GitHub repository URL: ${target.url}`);
      }

      const credential = await githubDiagnosticsTokenProvider.getToken('github.com');
      if (credential === undefined) {
        this.logger.warn(
          '[DiagnoseGitHubAuth] No GitHub credential available from any provider (VS Code session, gh CLI). '
          + 'Public repositories still work anonymously; private ones will answer 404.'
        );
        await this.offerRemediation('No GitHub credential found. Sign in to GitHub to access private sources.');
        return;
      }

      const report = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Diagnosing GitHub authentication...',
        cancellable: false
      }, async () => diagnoseGitHubToken(sharedHttpClient, credential.token, location));

      const scope = location ?? '(credential only)';
      this.logger.info(`[DiagnoseGitHubAuth] ${formatCredential(credential)} ${scope}: ${formatGitHubTokenReport(report)}`);

      // `repoStatus === undefined` is an explicit fact, not an inference:
      // the repo probe never ran, either because no repository was named or
      // because the credential itself was rejected first.
      const credentialLevel = report.repoStatus === undefined;
      if (report.userStatus !== 200) {
        await this.offerRemediation(`Root cause: ${report.verdict}`);
        return;
      }

      if (credentialLevel) {
        await this.reportHealthy(credential, scope, undefined);
        return;
      }

      if (report.repoStatus === 200) {
        await this.reportHealthy(credential, scope, await this.runControlProbe(credential));
        return;
      }

      // Valid credential, repository not visible.
      if (location !== undefined && isDefaultHub({ type: 'github', location })) {
        await this.reportExpectedNoAccess(location, credential, report);
        return;
      }
      const probe = await this.runControlProbe(credential);
      const headline = `Root cause: ${report.verdict} [${formatCredential(credential)}]`;
      await this.offerRemediation(probe === undefined ? headline : `${headline} Control probe: ${probe}`);
    } catch (error) {
      this.logger.error('[DiagnoseGitHubAuth] Diagnostics failed', error as Error);
      vscode.window.showErrorMessage(`GitHub diagnostics failed: ${(error as Error).message}`);
    }
  }
}
