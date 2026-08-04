/**
 * Credential diagnostics for GitHub tokens.
 *
 * Exists because `raw.githubusercontent.com` is actively misleading about
 * bad credentials: it answers **404** — never 401/403 — when the
 * `Authorization` header carries a token GitHub rejects, even for content
 * that is public and served fine anonymously. A stale VS Code session
 * therefore makes *every* hub look non-existent, and the response itself
 * carries no hint that the credential was the problem.
 *
 * `api.github.com` *is* honest about it, so probing it with the same
 * token turns an ambiguous 404 into a specific answer: token rejected
 * (401), missing scope (`x-oauth-scopes`), org SSO authorization required
 * (`x-github-sso`), wrong account (`login`), or genuinely no access to
 * that repo (403/404 on the repo endpoint while `/user` succeeds).
 *
 * Token values never appear in the output, only the package-wide
 * `redactToken` descriptor.
 * @module auth/github-token-diagnostics
 */
import type {
  HttpClient,
} from '@ai-primitives-hub/core';
import {
  redactToken,
} from '../harvest/token-provider';
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_USER_AGENT,
} from '../http/github-api-client';

export interface GitHubTokenReport {
  /** Redacted token descriptor (`redactToken`: length + last four chars). */
  token: string;
  /** Status of `GET /user`; absent when the request never completed. */
  userStatus?: number;
  /** Login GitHub attributes the token to. */
  login?: string;
  /** Scopes the token actually carries, per `x-oauth-scopes`. */
  scopes?: string;
  /** Status of `GET /repos/{location}`, when a repo was supplied. */
  repoStatus?: number;
  /** `x-github-sso` challenge, when the org enforces SAML SSO. */
  sso?: string;
  /** Transport-level failure message, when a probe could not complete. */
  error?: string;
  /** Plain-language conclusion drawn from the probes. */
  verdict: string;
}

/**
 * Derive the actionable conclusion from the probe results.
 * @param report Report assembled so far.
 * @param repoLocation `owner/repo` that was probed, when supplied.
 * @returns A one-line verdict naming the likely cause and the fix.
 */
function concludeVerdict(report: GitHubTokenReport, repoLocation?: string): string {
  if (report.error !== undefined) {
    return `could not reach api.github.com to validate the credential (${report.error}); treat this as a network/proxy problem, not an access problem`;
  }
  if (report.userStatus === 401) {
    return 'GitHub rejected the credential itself (401 on /user): it is expired, revoked, or not a GitHub API token. Sign out of GitHub and sign back in to mint a new session token.';
  }
  if (report.userStatus !== 200) {
    return `unexpected status ${String(report.userStatus)} from /user; the credential could not be validated.`;
  }

  // /user succeeded, so the token itself is valid — narrow to repo access.
  const login = report.login ?? 'an unknown login';
  const scopes = report.scopes ?? '';
  if (repoLocation === undefined || report.repoStatus === 200) {
    return `credential is valid and belongs to ${login} (scopes: ${scopes === '' ? '(none reported)' : scopes}).`;
  }
  if (report.sso !== undefined) {
    return `credential is valid (${login}) but is not SSO-authorized for ${repoLocation} (x-github-sso: ${report.sso}). Authorize it for the organization, then retry.`;
  }
  if (!scopes.split(',').map((scope) => scope.trim()).includes('repo')) {
    return `credential is valid (${login}) but lacks the 'repo' scope (has: ${scopes === '' ? '(none)' : scopes}), so private repositories like ${repoLocation} are invisible to it.`;
  }
  return `credential is valid and belongs to ${login}, but that account cannot see ${repoLocation} (status ${String(report.repoStatus)}). `
    + 'Check whether the account is a member of the owning organization, or switch accounts.';
}

/**
 * Probe `api.github.com` with a token to determine whether it is valid,
 * whose it is, what it can do, and whether it can reach a given repo.
 *
 * Never throws and never returns the token value.
 * @param http HttpClient to probe with.
 * @param token The token to diagnose.
 * @param repoLocation Optional `owner/repo` to also probe for access.
 * @returns A redacted report including an actionable verdict.
 */
export async function diagnoseGitHubToken(
  http: HttpClient,
  token: string,
  repoLocation?: string
): Promise<GitHubTokenReport> {
  const report: GitHubTokenReport = { token: redactToken(token), verdict: '' };

  // Same header shape the hub fetch uses, so a rejection here reproduces
  // the rejection there rather than testing a different credential path.
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': GITHUB_API_USER_AGENT };

  try {
    const userRes = await http.fetch({ url: `${GITHUB_API_BASE_URL}/user`, headers, maxRedirects: 5 });
    report.userStatus = userRes.statusCode;
    report.scopes = userRes.headers['x-oauth-scopes'];
    if (userRes.statusCode === 200) {
      try {
        report.login = (JSON.parse(new TextDecoder().decode(userRes.body)) as { login?: string }).login;
      } catch {
        // Body was not the expected JSON; the status already carries the
        // signal we need, so keep going rather than failing the probe.
      }

      if (repoLocation !== undefined) {
        const repoRes = await http.fetch({ url: `${GITHUB_API_BASE_URL}/repos/${repoLocation}`, headers, maxRedirects: 5 });
        report.repoStatus = repoRes.statusCode;
        report.sso = repoRes.headers['x-github-sso'];
      }
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  report.verdict = concludeVerdict(report, repoLocation);
  return report;
}

/**
 * Render a report as a single log line.
 * @param report The report to format.
 * @returns A `key=value` summary ending with the verdict.
 */
export function formatGitHubTokenReport(report: GitHubTokenReport): string {
  const parts = [`token=${report.token}`];
  const fields: [string, string | number | undefined][] = [
    ['userStatus', report.userStatus],
    ['login', report.login],
    ['scopes', report.scopes],
    ['repoStatus', report.repoStatus],
    ['sso', report.sso],
    ['probeError', report.error]
  ];
  for (const [name, value] of fields) {
    if (value !== undefined) {
      parts.push(`${name}=${String(value)}`);
    }
  }
  return `[${parts.join(', ')}] verdict: ${report.verdict}`;
}
