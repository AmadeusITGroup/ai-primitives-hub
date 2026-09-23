/**
 * Canonical repository context for a GitHub-backed source.
 *
 * The request host and repository host are intentionally separate: a request
 * can target `api.github.com` or `raw.githubusercontent.com` while a
 * repository-scoped credential must still be minted for `github.com/owner/repository`.
 */
export interface GitHubRepositoryTarget {
  /** Host used when addressing the repository for authentication purposes. */
  host: string;
  /** Repository owner or organization. */
  owner: string;
  /** Repository name. */
  repository: string;
}
