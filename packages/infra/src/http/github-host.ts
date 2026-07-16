/**
 * Host predicate for GitHub-owned hosts.
 *
 * Shared by `GhCliTokenProvider` (must not shell out for a foreign host)
 * and `GitHubApiClient` (must not attach a GitHub bearer token to a
 * request against a redirect target, or a caller-supplied URL that isn't
 * actually GitHub's). Ported from the reference branch's
 * `infra/src/github/url.ts` (`isGitHubHost`), trimmed to just the
 * predicate — the URL-building helpers it shipped alongside aren't needed
 * by anything ported so far.
 * @module http/github-host
 */

const GITHUB_HOST_SUFFIXES = ['.github.com', '.githubusercontent.com'] as const;

/**
 * True for any GitHub-owned host: the public site, the API, raw content,
 * codeload, gists, etc. The suffix match requires an actual subdomain
 * before the suffix, so `fakegithub.com` and the bare `githubusercontent.com`
 * both correctly return false.
 * @param host - Hostname to test (typically lower-case from a URL).
 */
export function isGitHubHost(host: string): boolean {
  if (host.length === 0) {
    return false;
  }
  if (host === 'github.com' || host === 'api.github.com') {
    return true;
  }
  for (const suffix of GITHUB_HOST_SUFFIXES) {
    if (host.endsWith(suffix) && host.length > suffix.length) {
      return true;
    }
  }
  return false;
}
