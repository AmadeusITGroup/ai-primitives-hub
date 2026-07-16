/**
 * sourceId helper.
 *
 * Mirrors the algorithm in `src/utils/source-id-utils.ts` of the
 * VS Code extension exactly so that lockfile entries written by the
 * CLI are interchangeable with entries written by the extension.
 *
 * Pure function; no IO; safe to import from anywhere.
 * @module domain/source-id
 */
import {
  createHash,
} from 'node:crypto';

/**
 * Optional fields that participate in the hash.
 */
export interface SourceIdConfig {
  /** Git branch for git-based sources. Defaults to 'main'; 'master' is canonicalized to 'main'. */
  branch?: string;
  /** Path to the collections directory. Defaults to 'collections'. */
  collectionsPath?: string;
}

/**
 * Lowercase host + path; strip protocol + trailing slashes.
 *
 * Falls back to a regex-based normalization when `URL` parsing fails
 * (matches the extension's behaviour for invalid URLs).
 * @param url Raw URL.
 * @returns Normalized URL string.
 */
export const normalizeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase().replace(/\/+$/, '');
    return host + path;
  } catch {
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  }
};

/**
 * Canonicalize branch name to 'main' if missing or 'master'.
 * @param branch Optional branch name.
 * @returns Canonical branch.
 */
const canonicalBranch = (branch?: string): string => {
  if (branch === undefined || branch.length === 0 || branch === 'master') {
    return 'main';
  }
  return branch;
};

/**
 * Generate a stable sourceId of the form `{type}-{12hex}`.
 *
 * The hash includes (sourceType, normalizedUrl, branch,
 * collectionsPath) so that the same logical source maps to the same
 * id regardless of how the user typed the URL.
 * @param sourceType e.g. 'github', 'awesome-copilot', 'apm'.
 * @param url Source URL.
 * @param config Optional branch + collections path.
 * @returns The sourceId.
 */
export const generateSourceId = (
  sourceType: string,
  url: string,
  config?: SourceIdConfig
): string => {
  const normalizedUrl = normalizeUrl(url);
  const branch = canonicalBranch(config?.branch);
  const collectionsPath = config?.collectionsPath ?? 'collections';
  const hash = createHash('sha256')
    .update(`${sourceType}:${normalizedUrl}:${branch}:${collectionsPath}`)
    .digest('hex')
    .substring(0, 12);
  return `${sourceType}-${hash}`;
};

/**
 * Generate a hub-key analogue for hubs[] entries in the lockfile.
 *
 * Format: `{12hex}` for main/master/no-branch, `{12hex}-{branch}`
 * otherwise (matches extension's `generateHubKey`).
 * @param url Hub URL.
 * @param branch Optional branch.
 * @returns The hub key.
 */
export const generateHubKey = (url: string, branch?: string): string => {
  const normalizedUrl = normalizeUrl(url);
  const hash = createHash('sha256')
    .update(normalizedUrl)
    .digest('hex')
    .substring(0, 12);
  const b = canonicalBranch(branch);
  return b === 'main' ? hash : `${hash}-${b}`;
};
