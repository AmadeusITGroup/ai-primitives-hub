/**
 * `GitHubApi` port implementation, backed by an injected `HttpClient`.
 *
 * Replaces `src/adapters/github-adapter.ts`'s `makeRequest`/`downloadFile`
 * methods. Two behavioral simplifications relative to that code, both
 * deliberate:
 *
 * - No HTML-error-page body-scraping. It only ever improved a diagnostic
 *   message for an edge case (an auth gateway/proxy returning HTML instead
 *   of JSON); status-code-based error messages below still cover it.
 * - No multi-strategy auth retry loop (explicit token -> VS Code session ->
 *   `gh` CLI, invalidating a cache and retrying on 401/403). That chain
 *   conflated two concerns: *which* token to use is a delivery-specific
 *   policy (CLI vs. extension), so it belongs in whichever `TokenProvider`
 *   the caller injects, not in this HTTP layer. `getToken()` is called
 *   fresh on every request, so a `TokenProvider` that itself tries
 *   multiple strategies still gets a chance to re-resolve on the next call.
 *
 * Phase 3b addition: resilient by default. Transient failures (408/429/5xx)
 * are retried with exponential backoff + jitter; a primary rate limit (403
 * + `x-ratelimit-remaining: 0`) sleeps until `x-ratelimit-reset`; a
 * secondary rate limit honours `Retry-After`. None of this changes the
 * public error contract for a *fatal* status (401/403-non-rate-limit/404/…
 * still throw the same `describeError` message as before) — it only adds
 * retries in front of it, so all pre-existing tests keep passing unchanged.
 * Ported from the reference branch's `infra/src/github/client.ts`, adapted
 * to sit on top of this repo's `HttpClient` port (which already fully
 * buffers the response body and follows redirects) instead of a raw
 * `fetch`, so `NodeHttpClient`/`HttpClient` need no changes at all.
 * @module http/github-api-client
 */
import type {
  EtaggedResult,
  GitHubApi,
  HttpClient,
  HttpResponse,
  TokenProvider,
} from '@ai-primitives-hub/core';

export type GitHubClientEventKind =
  | 'request'
  | 'success'
  | 'not-modified'
  | 'retry'
  | 'rate-limit'
  | 'give-up';

/**
 * Observability event emitted on every state transition of a request.
 * Structural rather than free-form strings so callers/tests can match on
 * them with simple deep-equality.
 */
export interface GitHubClientEvent {
  kind: GitHubClientEventKind;
  url: string;
  attempt: number;
  status?: number;
  /** Sleep applied before the next attempt (ms). Set on `retry`/`rate-limit`. */
  sleepMs?: number;
  /** Short reason string. Set on `retry`/`rate-limit`/`give-up`. */
  reason?: string;
}

export type GitHubClientEventHandler = (event: GitHubClientEvent) => void;

export interface RateLimitTelemetry {
  limit: number | undefined;
  remaining: number | undefined;
  used: number | undefined;
  resetAt: Date | undefined;
}

export interface GitHubApiClientOptions {
  /** Defaults to `https://api.github.com`. */
  baseUrl?: string;
  /** Defaults to `ai-primitives-hub/1.0`. */
  userAgent?: string;
  /** Resolves a bearer token for each request; omit for unauthenticated access. */
  tokenProvider?: TokenProvider;
  /** Max retries after a transient failure. Default 4. */
  maxRetries?: number;
  /** Initial backoff (ms). Each retry doubles it. Default 250. */
  backoffBaseMs?: number;
  /** Jitter (ms) added to each transient-retry backoff. Default 250. */
  jitterMs?: number;
  /** Upper bound on any single sleep. Default 60_000 ms. */
  maxSleepMs?: number;
  /** Observability hook (called on every request/retry/rate-limit/give-up). */
  onEvent?: GitHubClientEventHandler;
  /** Test seam for the sleep primitive. Default = real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for jitter randomness. Default = `Math.random`. */
  random?: () => number;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_USER_AGENT = 'ai-primitives-hub/1.0';
const NOOP_EVENT_HANDLER: GitHubClientEventHandler = (): void => undefined;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Classification {
  kind: 'transient' | 'rate-limit' | 'secondary-rate-limit' | 'fatal';
  reason: string;
}

export class GitHubApiClient implements GitHubApi {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly jitterMs: number;
  private readonly maxSleepMs: number;
  private readonly onEvent: GitHubClientEventHandler;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  /** Latest rate-limit headers seen from GitHub. Updated on every response. */
  public lastRateLimit: RateLimitTelemetry = {
    limit: undefined,
    remaining: undefined,
    used: undefined,
    resetAt: undefined
  };

  public constructor(
    private readonly http: HttpClient,
    private readonly options: GitHubApiClientOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = options.maxRetries ?? 4;
    this.backoffBaseMs = options.backoffBaseMs ?? 250;
    this.jitterMs = options.jitterMs ?? 250;
    this.maxSleepMs = options.maxSleepMs ?? 60_000;
    this.onEvent = options.onEvent ?? NOOP_EVENT_HANDLER;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  private resolveUrl(pathOrUrl: string): string {
    return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
  }

  /**
   * GitHub's asset-download API endpoints return JSON metadata about the
   * asset by default; only `Accept: application/octet-stream` makes them
   * return the actual bytes. Only applies to `this.baseUrl`-hosted URLs -
   * a `browser_download_url` or redirect target doesn't need it (and
   * shouldn't get an unexpected Accept override).
   * @param url - Already-resolved absolute URL to check.
   */
  private needsOctetStreamAccept(url: string): boolean {
    return url.startsWith(this.baseUrl);
  }

  private async buildHeaders(url: string, accept: string, extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: accept,
      ...extraHeaders
    };
    const host = new URL(url).hostname;
    const token = await this.options.tokenProvider?.getToken(host);
    if (token) {
      headers.Authorization = `token ${token}`;
    }
    return headers;
  }

  private classify(response: HttpResponse): Classification {
    if (response.statusCode === 403) {
      if (response.headers['x-ratelimit-remaining'] === '0') {
        return { kind: 'rate-limit', reason: 'primary rate limit' };
      }
      const body = Buffer.from(response.body).toString('utf8').slice(0, 500);
      if (/secondary rate limit/i.test(body) || response.headers['retry-after'] !== undefined) {
        return { kind: 'secondary-rate-limit', reason: 'secondary rate limit' };
      }
      return { kind: 'fatal', reason: 'forbidden' };
    }
    if (response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500) {
      return { kind: 'transient', reason: `status ${String(response.statusCode)}` };
    }
    return { kind: 'fatal', reason: `status ${String(response.statusCode)}` };
  }

  private computeSleep(classification: Classification, attempt: number, response: HttpResponse): number {
    if (classification.kind === 'rate-limit') {
      const reset = Number(response.headers['x-ratelimit-reset']);
      if (Number.isFinite(reset) && reset > 0) {
        const waitMs = Math.max(0, reset * 1000 - Date.now()) + 250;
        return Math.max(waitMs, 100);
      }
      const retryAfter = Number(response.headers['retry-after']);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        return Math.max(retryAfter * 1000, 100);
      }
      return this.maxSleepMs;
    }
    if (classification.kind === 'secondary-rate-limit') {
      const retryAfter = Number(response.headers['retry-after']);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        return Math.max(retryAfter * 1000, 100);
      }
      return this.backoffBaseMs * (2 ** (attempt - 1));
    }
    const back = this.backoffBaseMs * (2 ** (attempt - 1));
    const jitter = this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0;
    return back + jitter;
  }

  private captureRateLimit(response: HttpResponse): void {
    const parseHeader = (name: string): number | undefined => {
      const raw = response.headers[name];
      if (raw === undefined) {
        return undefined;
      }
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const resetUnix = parseHeader('x-ratelimit-reset');
    this.lastRateLimit = {
      limit: parseHeader('x-ratelimit-limit'),
      remaining: parseHeader('x-ratelimit-remaining'),
      used: parseHeader('x-ratelimit-used'),
      resetAt: resetUnix === undefined ? undefined : new Date(resetUnix * 1000)
    };
  }

  private async request(
    pathOrUrl: string,
    accept: string,
    extraHeaders?: Record<string, string>,
    opts?: { allowStatus?: number[] }
  ): Promise<HttpResponse> {
    const url = this.resolveUrl(pathOrUrl);
    const headers = await this.buildHeaders(url, accept, extraHeaders);
    const allowStatus = opts?.allowStatus ?? [];
    let attempt = 0;
    for (;;) {
      attempt += 1;
      this.onEvent({ kind: 'request', url, attempt });
      const response = await this.http.fetch({ url, headers });
      this.captureRateLimit(response);
      if (response.statusCode < 400 || allowStatus.includes(response.statusCode)) {
        this.onEvent({ kind: 'success', url, attempt, status: response.statusCode });
        return response;
      }
      const classification = this.classify(response);
      if (classification.kind === 'fatal' || attempt > this.maxRetries) {
        this.onEvent({ kind: 'give-up', url, attempt, status: response.statusCode, reason: classification.reason });
        throw new Error(describeError(response, url));
      }
      const sleepMs = Math.min(this.computeSleep(classification, attempt, response), this.maxSleepMs);
      this.onEvent({
        kind: classification.kind === 'rate-limit' || classification.kind === 'secondary-rate-limit' ? 'rate-limit' : 'retry',
        url,
        attempt,
        status: response.statusCode,
        sleepMs,
        reason: classification.reason
      });
      await this.sleep(sleepMs);
    }
  }

  public async getJson<T>(pathOrUrl: string, extraHeaders?: Record<string, string>): Promise<T> {
    const response = await this.request(pathOrUrl, 'application/json', extraHeaders);
    const text = Buffer.from(response.body).toString('utf8');
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`Failed to parse GitHub response as JSON: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async getText(pathOrUrl: string, extraHeaders?: Record<string, string>): Promise<string> {
    const url = this.resolveUrl(pathOrUrl);
    const accept = this.needsOctetStreamAccept(url) ? 'application/octet-stream' : '*/*';
    const response = await this.request(pathOrUrl, accept, extraHeaders);
    return Buffer.from(response.body).toString('utf8');
  }

  public async download(pathOrUrl: string, extraHeaders?: Record<string, string>): Promise<Uint8Array> {
    const url = this.resolveUrl(pathOrUrl);
    const accept = this.needsOctetStreamAccept(url) ? 'application/octet-stream' : '*/*';
    const response = await this.request(pathOrUrl, accept, extraHeaders);
    return response.body;
  }

  public async getJsonWithEtag<T>(pathOrUrl: string, etag?: string): Promise<EtaggedResult<T>> {
    const extraHeaders: Record<string, string> = {};
    if (etag !== undefined && etag.length > 0) {
      extraHeaders['If-None-Match'] = etag;
    }
    const response = await this.request(pathOrUrl, 'application/json', extraHeaders, { allowStatus: [304] });
    if (response.statusCode === 304) {
      this.onEvent({ kind: 'not-modified', url: this.resolveUrl(pathOrUrl), attempt: 1, status: 304 });
      return { status: 'notModified' };
    }
    const text = Buffer.from(response.body).toString('utf8');
    const value = JSON.parse(text) as T;
    return { status: 'ok', value, etag: response.headers.etag };
  }
}

function describeError(response: HttpResponse, url: string): string {
  switch (response.statusCode) {
    case 401: {
      return `GitHub API error: 401 - Authentication failed. Token may be invalid or expired. (${url})`;
    }
    case 403: {
      return `GitHub API error: 403 - Access forbidden. Token may lack required scopes (repo). (${url})`;
    }
    case 404: {
      return `GitHub API error: 404 - Not found or not accessible. Check authentication. (${url})`;
    }
    default: {
      return `GitHub API error: ${response.statusCode} (${url})`;
    }
  }
}
