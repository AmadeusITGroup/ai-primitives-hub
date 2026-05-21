/**
 * Utility for converting GitHub raw URLs to API content URLs.
 */

/**
 * Convert a raw.githubusercontent.com URL to the equivalent GitHub API contents URL.
 * Returns undefined if the URL isn't a raw GitHub URL.
 *
 * Example: https://raw.githubusercontent.com/owner/repo/branch/path/file.json
 *       → https://api.github.com/repos/owner/repo/contents/path/file.json?ref=branch
 * @param url
 */
export function convertRawUrlToApi(url: string): string | undefined {
  const match = url.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+?)(?:\?.*)?$/
  );
  if (!match) {
    return undefined;
  }
  const [, owner, repo, ref, path] = match;
  return `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
}
