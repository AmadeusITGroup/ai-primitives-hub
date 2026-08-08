/**
 * Command that explains *why* GitHub access is failing.
 *
 * Exists because the symptom users actually see is a 404 on
 * `raw.githubusercontent.com` ("Failed to download bundle: GitHub API
 * error: 404"), which is the same answer GitHub gives for a missing file,
 * a rejected token, a token without the `repo` scope, a token that is not
 * SSO-authorized for the owning organization, and an account that isn't a
 * member of that organization. The status code cannot tell those apart;
 * `api.github.com` can, so this command probes it with the exact credential
 * the source adapters use (`githubTokenProviderChain`).
 *
 * Nothing here silently works around a bad credential: a failing request
 * stays failed, and the outcome is always a named root cause plus the
 * option to reset the token.
 *
 * Two shapes, deliberately:
 *
 * - **Targeted** (`execute({ url })`, how the failed-install notification
 *   calls it): diagnose only the repository that just failed, plus one
 *   control probe against public raw content. Three requests, one verdict
 *   about the thing the user was actually doing.
 * - **Sweep** (`execute()`, from the command palette): validate the
 *   credential once, then probe each distinct GitHub source repository
 *   concurrently.
 *
 * Read-only: it resolves and probes, never writes. The remediation it
 * offers is the existing `promptregistry.forceGitHubAuth` command, which
 * mints a brand-new session token and lets the user switch accounts.
 * @module commands/diagnose-github-auth-command
 */
import {
  diagnoseGitHubTokenForRepos,
  formatGitHubTokenReport,
  formatRawContentProbe,
  probeRawContentWithCredential,
} from '@ai-primitives-hub/infra';
import type {
  GitHubTokenReport,
} from '@ai-primitives-hub/infra';
import * as vscode from 'vscode';
import {
  githubTokenProviderChain,
  sharedHttpClient,
} from '../adapters/infra-adapter-factory';
import {
  getRecommendedHub,
} from '../config/default-hubs';
import {
  RegistryManager,
} from '../services/registry-manager';
import {
  Logger,
} from '../utils/logger';

/** Source types whose content is fetched from GitHub with a credential. */
const GITHUB_SOURCE_TYPES = new Set(['github', 'skills', 'awesome-copilot', 'apm']);

/** Public repository used as the control experiment when a hub lookup fails. */
const FALLBACK_PUBLIC_REPO = 'github/awesome-copilot';

/**
 * What to diagnose. Supplied by whatever just failed - typically the raw
 * URL from the error message, which already names the repository.
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
 * since the latter is what the error message hands us.
 * @param url - URL to parse.
 * @returns `owner/repo`, or undefined when the URL isn't a GitHub repo URL.
 */
export function parseRepoLocation(url: string): string | undefined {
  const match = /(?:github\.com|raw\.githubusercontent\.com|codeload\.github\.com)[/:]([^/]+)\/([^/?#]+)/.exec(url.replace(/\.git(?=$|[/?#])/, ''));
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/**
 * A public raw URL that must be readable by anyone, used as the control in
 * `probeRawContentWithCredential`.
 *
 * Uses the recommended default hub (a public repository the extension
 * already depends on being reachable) so the control tests the same host
 * and edge as the failing download.
 */
function publicControlUrl(): string {
  const reference = getRecommendedHub()?.reference;
  const isGitHubHub = reference?.type === 'github' && reference.location.length > 0;
  const location = isGitHubHub ? reference.location : FALLBACK_PUBLIC_REPO;
  const ref = (isGitHubHub ? reference.ref : undefined) ?? 'main';
  return `https://raw.githubusercontent.com/${location}/${ref}/README.md`;
}

export class DiagnoseGitHubAuthCommand {
  private readonly logger = Logger.getInstance();

  constructor(private readonly registryManager: RegistryManager) {}

  /**
   * Resolve the credential through the adapters' own provider chain,
   * reporting which link produced it.
   * @returns The token and its origin label, or undefined when no provider
   * had one to offer.
   */
  private async resolveToken(): Promise<{ token: string; origin: string } | undefined> {
    for (const { label, provider } of githubTokenProviderChain) {
      const token = await provider.getToken('github.com');
      if (token !== undefined) {
        this.logger.info(`[DiagnoseGitHubAuth] Credential resolved from: ${label}`);
        return { token, origin: label };
      }
      this.logger.debug(`[DiagnoseGitHubAuth] No credential from: ${label}`);
    }
    return undefined;
  }

  /**
   * The repositories to probe: just the failing one when a target was
   * supplied, otherwise every distinct GitHub-hosted source.
   * @param target - Optional failing target.
   */
  private async resolveLocations(target?: DiagnoseGitHubAuthTarget): Promise<string[]> {
    if (target?.url !== undefined) {
      const location = parseRepoLocation(target.url);
      if (location !== undefined) {
        this.logger.info(`[DiagnoseGitHubAuth] Diagnosing ${target.label ?? location} (${location}) only`);
        return [location];
      }
      this.logger.debug(`[DiagnoseGitHubAuth] Target URL is not a GitHub repository URL: ${target.url}`);
    }

    const sources = await this.registryManager.listSources();
    const locations = new Set<string>();
    for (const source of sources) {
      if (!GITHUB_SOURCE_TYPES.has(source.type)) {
        continue;
      }
      const location = parseRepoLocation(source.url);
      if (location !== undefined) {
        locations.add(location);
      }
    }
    return [...locations];
  }

  /**
   * Probe the resolved repositories with the credential.
   *
   * De-duplicated first (several sources commonly point at one repo), then
   * handed to `diagnoseGitHubTokenForRepos`, which validates the credential
   * once and probes the repos concurrently - 1 + N requests rather than 2N
   * sequential ones.
   * @param token - Credential to probe with.
   * @param locations - `owner/repo` values to probe.
   * @returns One report per probed location, or a single credential-level
   * report when there is nothing repo-specific to say.
   */
  /**
   * Surface the verdict with the one action that can fix a bad credential.
   * @param message - Verdict to show.
   */
  private async offerRemediation(message: string): Promise<void> {
    const RESET = 'Reset GitHub Token';
    const LOGS = 'Show Logs';
    const choice = await vscode.window.showWarningMessage(message, RESET, LOGS);
    if (choice === RESET) {
      await vscode.commands.executeCommand('promptregistry.forceGitHubAuth');
    } else if (choice === LOGS) {
      this.logger.show();
    }
  }

  private async probeLocations(token: string, locations: string[]): Promise<{ location: string; report: GitHubTokenReport }[]> {
    const reports = await diagnoseGitHubTokenForRepos(sharedHttpClient, token, locations);

    // A credential-level answer (nothing to probe, or the credential itself
    // was rejected) comes back as one report covering all of them.
    if (reports.length !== locations.length) {
      const scope = locations.length === 0 ? '(credential only, no GitHub sources configured)' : `(credential only, covers ${locations.join(', ')})`;
      return [{ location: scope, report: reports[0] }];
    }
    return locations.map((location, index) => ({ location, report: reports[index] }));
  }

  public async execute(target?: DiagnoseGitHubAuthTarget): Promise<void> {
    this.logger.show();
    this.logger.info('[DiagnoseGitHubAuth] Diagnosing GitHub authentication...');

    try {
      const diagnosis = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Diagnosing GitHub authentication...',
        cancellable: false
      }, async () => {
        const resolved = await this.resolveToken();
        if (resolved === undefined) {
          return undefined;
        }
        const locations = await this.resolveLocations(target);
        return { credential: resolved, results: await this.probeLocations(resolved.token, locations) };
      });

      if (diagnosis === undefined) {
        this.logger.warn(
          '[DiagnoseGitHubAuth] No GitHub credential available from any provider (VS Code session, gh CLI). '
          + 'Public repositories still work anonymously; private ones will answer 404.'
        );
        await this.offerRemediation('No GitHub credential found. Sign in to GitHub to access private sources.');
        return;
      }

      const { credential, results } = diagnosis;
      for (const { location, report } of results) {
        this.logger.info(`[DiagnoseGitHubAuth] ${location}: ${formatGitHubTokenReport(report)}`);
      }

      const failing = results.filter(({ report }) => report.userStatus !== 200 || (report.repoStatus !== undefined && report.repoStatus !== 200));
      const credentialRejected = results.some(({ report }) => report.userStatus !== undefined && report.userStatus !== 200);

      // Control experiment against public raw content. Skipped when
      // api.github.com already rejected the credential outright (nothing
      // left to disambiguate) and when a sweep found nothing wrong.
      let controlVerdict: string | undefined;
      if (!credentialRejected && (target !== undefined || failing.length > 0)) {
        const probe = await probeRawContentWithCredential(sharedHttpClient, credential.token, publicControlUrl());
        this.logger.info(`[DiagnoseGitHubAuth] Public control probe: ${formatRawContentProbe(probe)}`);
        controlVerdict = probe.verdict;
      }

      if (failing.length === 0) {
        const scope = target?.url === undefined ? 'every configured GitHub source' : (results[0]?.location ?? 'the requested repository');
        this.logger.info(`[DiagnoseGitHubAuth] Credential from ${credential.origin} can reach ${scope}.`);
        if (controlVerdict !== undefined && !controlVerdict.startsWith('the credential is accepted')) {
          // api.github.com is happy but raw content is not: the credential
          // works, yet the host that actually serves bundles disagrees.
          await this.offerRemediation(controlVerdict);
          return;
        }
        const healthy = `GitHub authentication looks healthy (credential from ${credential.origin} can reach ${scope}).`
          + (target?.url === undefined ? '' : ' The failure was about the requested file or path, not access.');
        // Still offer the reset: "the credential is fine" is a verdict the
        // user may not believe, and resetting is cheap and non-destructive.
        const RESET = 'Reset GitHub Token';
        if (await vscode.window.showInformationMessage(healthy, RESET, 'Show Logs') === RESET) {
          await vscode.commands.executeCommand('promptregistry.forceGitHubAuth');
        }
        return;
      }

      this.logger.warn(`[DiagnoseGitHubAuth] Credential from ${credential.origin} cannot reach ${failing.map(({ location }) => location).join(', ')}`);
      const headline = `Root cause: ${failing[0].report.verdict}`;
      await this.offerRemediation(controlVerdict === undefined ? headline : `${headline} Control probe: ${controlVerdict}`);
    } catch (error) {
      this.logger.error('[DiagnoseGitHubAuth] Diagnostics failed', error as Error);
      vscode.window.showErrorMessage(`GitHub diagnostics failed: ${(error as Error).message}`);
    }
  }
}
