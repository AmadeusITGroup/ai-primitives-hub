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
  const [report] = await diagnoseGitHubTokenForRepos(http, token, repoLocation === undefined ? [] : [repoLocation]);
  return report;
}

/**
 * Same headers the hub/raw fetches use, so a rejection here reproduces the
 * rejection there rather than testing a different credential path.
 * @param token The token to probe with.
 */
function probeHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': GITHUB_API_USER_AGENT };
}

/** Credential-level facts, shared by every repo in one diagnosis run. */
type CredentialFacts = Pick<GitHubTokenReport, 'userStatus' | 'login' | 'scopes' | 'error'>;

/**
 * Validate the credential itself: is it accepted, whose is it, and what
 * scopes does it carry.
 * @param http HttpClient to probe with.
 * @param token The token to diagnose.
 * @returns The credential-level facts; `error` set on a transport failure.
 */
async function probeCredential(http: HttpClient, token: string): Promise<CredentialFacts> {
  try {
    const userRes = await http.fetch({ url: `${GITHUB_API_BASE_URL}/user`, headers: probeHeaders(token), maxRedirects: 5 });
    const facts: CredentialFacts = { userStatus: userRes.statusCode, scopes: userRes.headers['x-oauth-scopes'] };
    if (userRes.statusCode === 200) {
      try {
        facts.login = (JSON.parse(new TextDecoder().decode(userRes.body)) as { login?: string }).login;
      } catch {
        // Body was not the expected JSON; the status already carries the
        // signal we need, so keep going rather than failing the probe.
      }
    }
    return facts;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Diagnose one credential against several repositories at once.
 *
 * The per-repo `diagnoseGitHubToken` would re-validate the credential for
 * every repository, so diagnosing N sources cost 2N round trips and ran
 * them one after another. The credential is the same for all of them, so
 * `GET /user` runs once here and the repo probes run concurrently: 1 + N
 * requests, in roughly the time of the slowest one. When the credential
 * itself is rejected the repo probes are skipped entirely - their answer
 * would be meaningless, and the verdict already only depends on `/user`.
 *
 * Never throws and never returns the token value.
 * @param http HttpClient to probe with.
 * @param token The token to diagnose.
 * @param repoLocations `owner/repo` values to probe for access; may be empty
 * to diagnose the credential alone.
 * @returns One report per location (sharing the credential-level fields), or
 * a single credential-only report when no location was supplied or the
 * credential was rejected.
 */
export async function diagnoseGitHubTokenForRepos(
  http: HttpClient,
  token: string,
  repoLocations: readonly string[]
): Promise<GitHubTokenReport[]> {
  const redacted = redactToken(token);
  const facts = await probeCredential(http, token);

  const credentialOnly = (): GitHubTokenReport[] => {
    const report: GitHubTokenReport = { token: redacted, ...facts, verdict: '' };
    report.verdict = concludeVerdict(report);
    return [report];
  };

  if (repoLocations.length === 0 || facts.userStatus !== 200) {
    return credentialOnly();
  }

  return await Promise.all(repoLocations.map(async (repoLocation) => {
    const report: GitHubTokenReport = { token: redacted, ...facts, verdict: '' };
    try {
      const repoRes = await http.fetch({ url: `${GITHUB_API_BASE_URL}/repos/${repoLocation}`, headers: probeHeaders(token), maxRedirects: 5 });
      report.repoStatus = repoRes.statusCode;
      report.sso = repoRes.headers['x-github-sso'];
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    report.verdict = concludeVerdict(report, repoLocation);
    return report;
  }));
}

export interface RawContentProbe {
  /** URL probed, both with and without the credential. */
  url: string;
  /** Status of the authenticated attempt. */
  authenticatedStatus?: number;
  /** Status of the anonymous attempt; absent when the first one succeeded. */
  anonymousStatus?: number;
  /** Transport-level failure message, when a probe could not complete. */
  error?: string;
  /** Plain-language conclusion drawn from the two attempts. */
  verdict: string;
}

/**
 * Control experiment: fetch a known-public raw URL with the credential and,
 * if that fails, without it.
 *
 * `diagnoseGitHubToken` interrogates `api.github.com`, but the requests that
 * actually fail run against `raw.githubusercontent.com` - a different host,
 * a different edge, and different (mis)behavior on auth. Pointing both
 * attempts at content that is unambiguously public separates the two
 * explanations for a 404 there: if the anonymous attempt succeeds where the
 * authenticated one failed, GitHub is rejecting the credential and no
 * private repository will ever load with it; if both succeed, the
 * credential is fine on that host and the original 404 is about *that*
 * path or repository.
 *
 * Never throws and never returns the token value.
 * @param http HttpClient to probe with.
 * @param token The token to test.
 * @param url Public raw URL to use as the control (e.g. a README on the
 * default community hub).
 * @returns A report including an actionable verdict.
 */
export async function probeRawContentWithCredential(http: HttpClient, token: string, url: string): Promise<RawContentProbe> {
  const probe: RawContentProbe = { url, verdict: '' };
  try {
    const authenticated = await http.fetch({
      url,
      headers: { Authorization: `token ${token}`, 'User-Agent': GITHUB_API_USER_AGENT },
      maxRedirects: 5
    });
    probe.authenticatedStatus = authenticated.statusCode;
    if (authenticated.statusCode === 200) {
      probe.verdict = `the credential is accepted for public raw content (${url}), so it is a working GitHub credential - the original failure is specific to the requested repository or path.`;
      return probe;
    }

    const anonymous = await http.fetch({ url, headers: { 'User-Agent': GITHUB_API_USER_AGENT }, maxRedirects: 5 });
    probe.anonymousStatus = anonymous.statusCode;
    if (anonymous.statusCode === 200) {
      probe.verdict = `GitHub is rejecting the credential itself: ${url} is public and loads anonymously, but returns ${String(authenticated.statusCode)} with this token. Reset the GitHub token.`;
      return probe;
    }
    probe.verdict = `inconclusive: the public control URL failed both with (${String(authenticated.statusCode)}) and without `
      + `(${String(anonymous.statusCode)}) the credential, which points at connectivity or a proxy rather than the token.`;
    return probe;
  } catch (error) {
    probe.error = error instanceof Error ? error.message : String(error);
    probe.verdict = `could not reach the public control URL (${probe.error}); treat this as a network/proxy problem, not an access problem.`;
    return probe;
  }
}

/**
 * Render a raw-content control probe as a single log line.
 * @param probe The probe to format.
 * @returns A `key=value` summary ending with the verdict.
 */
export function formatRawContentProbe(probe: RawContentProbe): string {
  const parts = [`url=${probe.url}`];
  if (probe.authenticatedStatus !== undefined) {
    parts.push(`authenticated=${String(probe.authenticatedStatus)}`);
  }
  if (probe.anonymousStatus !== undefined) {
    parts.push(`anonymous=${String(probe.anonymousStatus)}`);
  }
  if (probe.error !== undefined) {
    parts.push(`probeError=${probe.error}`);
  }
  return `[${parts.join(', ')}] verdict: ${probe.verdict}`;
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
