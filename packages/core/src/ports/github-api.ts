/**
 * GitHubApi port — interface for GitHub REST API interactions.
 *
 * Covers the access patterns `src/adapters/github-adapter.ts` and
 * `src/adapters/skills-adapter.ts` need: JSON GETs (repository contents,
 * tree, releases), text GETs (raw file content), and binary downloads
 * (release/tarball assets). Also covers the ETag-conditional GET the
 * Phase 3b harvest subsystem needs to poll `/commits/:ref` cheaply across
 * many hub sources without spending full rate-limit budget on unchanged
 * repos (`getJsonWithEtag`). Retry/backoff/rate-limit handling is
 * deliberately *not* part of this port — it's a resilience concern of
 * whichever concrete implementation wraps the transport (see
 * `@ai-primitives-hub/infra`'s `GitHubApiClient`), not something every
 * `GitHubApi` implementation (e.g. a test double) needs to reason about.
 * @module ports/github-api
 */

/**
 * Result of an ETag-conditional GET. `notModified` means the caller's
 * cached value is still current and nothing was parsed; `ok` carries a
 * fresh value and its new ETag (`undefined` if the response omitted one).
 */
export interface EtaggedOk<T> {
  status: 'ok';
  value: T;
  etag: string | undefined;
}
export interface EtaggedNotModified {
  status: 'notModified';
}
export type EtaggedResult<T> = EtaggedOk<T> | EtaggedNotModified;

export interface GitHubApi {
  /**
   * GET returning parsed JSON. Throws on a non-2xx response.
   * @param pathOrUrl - Relative API path (e.g. `/repos/{owner}/{repo}`) or absolute URL.
   * @param extraHeaders - Optional additional headers.
   */
  getJson<T>(pathOrUrl: string, extraHeaders?: Record<string, string>): Promise<T>;

  /**
   * GET returning the raw text body. Throws on a non-2xx response.
   * @param pathOrUrl - Relative API path or absolute URL.
   * @param extraHeaders - Optional additional headers.
   */
  getText(pathOrUrl: string, extraHeaders?: Record<string, string>): Promise<string>;

  /**
   * GET returning the raw response bytes, for binary assets (release ZIPs,
   * tarballs). Throws on a non-2xx response.
   * @param pathOrUrl - Relative API path or absolute URL.
   * @param extraHeaders - Optional additional headers.
   */
  download(pathOrUrl: string, extraHeaders?: Record<string, string>): Promise<Uint8Array>;

  /**
   * GET with an `If-None-Match` guard. Returns `{ status: 'notModified' }`
   * on a 304 response instead of throwing; otherwise `{ status: 'ok',
   * value, etag }`. Lets a caller with a previously-seen ETag skip paying
   * for a body transfer — and, on many GitHub endpoints, skip the
   * rate-limit cost too — when nothing changed.
   * @param pathOrUrl - Relative API path or absolute URL.
   * @param etag - Previously-seen ETag for this exact resource, if any.
   */
  getJsonWithEtag<T>(pathOrUrl: string, etag?: string): Promise<EtaggedResult<T>>;
}
