/**
 * Error types for the GitHub middleware.
 *
 * `GitHubApiError` carries the HTTP status + a truncated body so
 * callers can map specific status codes to domain errors without
 * needing to inspect the raw Response.
 * @module github/errors
 */

/**
 * Thrown when a GitHub API request fails after all retries (or
 * gives up immediately on a fatal status). Always carries the
 * final status code and a short body excerpt.
 */
export class GitHubApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly url: string
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * Thrown when the request loop exits without ever receiving a
 * Response (e.g. fetch threw on every retry — DNS, TLS, abort).
 */
export class GitHubNetworkError extends Error {
  public constructor(
    message: string,
    public readonly url: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'GitHubNetworkError';
  }
}
