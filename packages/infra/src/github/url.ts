/**
 * Pure URL builders + host predicates for GitHub interactions.
 *
 * Centralizes the lessons from I-011 (private-repo release assets must
 * use the API URL, not browser_download_url) and the host-matching
 * logic that the token provider needs. Pure functions only — no IO,
 * no globals — so the rest of the `github/` module is trivially
 * testable.
 * @module github/url
 */

export interface BuildApiUrlOptions {
  /** Override base URL for GitHub Enterprise. Defaults to public api.github.com. */
  base?: string;
}

const DEFAULT_API_BASE = 'https://api.github.com';

/**
 * Join an API path against the GitHub REST base. Path must begin
 * with '/'. Throws on absolute URLs (caller probably wanted to use
 * the URL directly without rebuilding).
 * @param apiPath Path beginning with '/'.
 * @param opts Optional base override (GHE).
 * @returns Absolute URL.
 */
export const buildApiUrl = (apiPath: string, opts: BuildApiUrlOptions = {}): string => {
  if (apiPath.startsWith('http://') || apiPath.startsWith('https://')) {
    throw new Error(`buildApiUrl: argument is absolute, not a path: ${apiPath}`);
  }
  if (!apiPath.startsWith('/')) {
    throw new Error(`buildApiUrl: path must have leading slash: ${apiPath}`);
  }
  const base = (opts.base ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  return `${base}${apiPath}`;
};

export interface BuildRawContentOptions {
  owner: string;
  repo: string;
  /** Branch / tag / commit. URL-encoded automatically. */
  ref: string;
  /** Repo-relative path (leading slash optional). */
  path: string;
}

/**
 * Build a raw.githubusercontent.com URL. Use this for fetching the
 * verbatim contents of a single file at a ref (cheap, no rate-limit
 * cost on most accounts).
 * @param opts owner/repo/ref/path.
 * @returns Absolute URL.
 */
export const buildRawContentUrl = (opts: BuildRawContentOptions): string => {
  const path = opts.path.replace(/^\/+/, '');
  const ref = encodeURIComponent(opts.ref);
  return `https://raw.githubusercontent.com/${opts.owner}/${opts.repo}/${ref}/${path}`;
};

export interface BuildReleaseAssetApiUrlOptions {
  owner: string;
  repo: string;
  /** Numeric asset id from the release JSON. */
  assetId: number;
  /** Optional GHE base; defaults to public api.github.com. */
  base?: string;
}

/**
 * I-011: build the API URL for a release asset. This URL accepts a
 * Bearer token and works for *both* public and private repos. The
 * `browser_download_url` (on github.com) returns 404 for private
 * assets even with a Bearer token, so prefer this builder anywhere
 * the asset id is known.
 * @param opts owner/repo/assetId.
 * @returns Absolute URL.
 */
export const buildReleaseAssetApiUrl = (opts: BuildReleaseAssetApiUrlOptions): string => {
  const base = (opts.base ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  return `${base}/repos/${opts.owner}/${opts.repo}/releases/assets/${String(opts.assetId)}`;
};

const GITHUB_HOST_SUFFIXES = ['.github.com', '.githubusercontent.com'] as const;

/**
 * Host predicate: returns true iff the hostname belongs to GitHub
 * (the public site, the API, raw content, codeload, gists, etc.).
 *
 * The host suffix match is *strict*: we require an actual subdomain
 * before the suffix, so `fakegithub.com` and `githubusercontent.com`
 * (the bare suffix) both correctly return false.
 * @param host Hostname to test (typically lower-case from a URL).
 * @returns True for any GitHub-owned host.
 */
export const isGitHubHost = (host: string): boolean => {
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
};

export interface RepoSlug {
  owner: string;
  repo: string;
}

/**
 * Parse a `<owner>/<repo>` slug, accepting common variants:
 *   - `owner/repo`
 *   - `https://github.com/owner/repo`
 *   - `owner/repo.git`
 *   - `owner/repo/`
 * Throws on malformed input rather than silently returning empties.
 * @param input Raw slug string.
 * @returns `{ owner, repo }`.
 */
export const parseRepoSlug = (input: string): RepoSlug => {
  if (input.length === 0) {
    throw new Error(`parseRepoSlug: malformed (empty): ${input}`);
  }
  const stripped = input
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const parts = stripped.split('/');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error(`parseRepoSlug: malformed: ${input}`);
  }
  return { owner: parts[0], repo: parts[1] };
};
