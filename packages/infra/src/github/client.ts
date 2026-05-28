/**
 * GitHubClient — single funnel for every GitHub REST API call.
 *
 * Consolidates the lib's GitHub network surface. Every API call goes
 * through this class, which handles:
 *
 *   - Authorization (via injected `TokenProvider`)
 *   - User-Agent + Accept + X-GitHub-Api-Version on every request
 *   - Retries on transient failures (408, 429, 5xx) with exponential
 *     backoff + jitter
 *   - Primary rate-limit handling (403 + `x-ratelimit-remaining: 0`):
 *     sleeps until `x-ratelimit-reset`
 *   - Secondary rate-limit handling: honours `Retry-After`
 *   - ETag-based conditional requests (`getJsonWithEtag`) — the most
 *     effective quota saver because 304 doesn't count against budget
 *     for many endpoints
 *   - Rate-limit telemetry (`lastRateLimit`) for post-run reporting
 *   - Pluggable observability (`onEvent` callback)
 *   - Pluggable `fetch`, `sleep`, and randomness for deterministic
 *     tests
 *
 * This class is a refined merge of the previous
 * `lib/src/primitive-index/hub/github-api-client.ts` and the
 * implicit fetch loop scattered across the install pipeline. The
 * old `GitHubApiClient` becomes a thin re-export of this class.
 * @module github/client
 */
import {
  randomInt,
} from 'node:crypto';
import {
  GitHubApiError,
} from './errors';
import type {
  ClientEventHandler,
} from './events';
import type {
  TokenProvider,
} from './token';

/** Native fetch shape (Node 18+ / browsers). */
export type FetchLike = (req: Request) => Promise<Response>;

export interface GitHubClientOptions {
  /** Token provider — resolves Bearer tokens per host. */
  tokens: TokenProvider;
  /** Base API URL. Defaults to https://api.github.com. */
  baseUrl?: string;
  /** User-Agent. Defaults to a sensible identifier. */
  userAgent?: string;
  /** Injected fetch for tests. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Max retries after a transient failure. Default 4. */
  maxRetries?: number;
  /** Initial backoff (ms). Each retry doubles it. Default 250. */
  backoffBaseMs?: number;
  /** Jitter (ms) added to each backoff. Default 250. */
  jitterMs?: number;
  /** Upper bound on any single sleep. Default 60_000 ms. */
  maxSleepMs?: number;
  /** Observability hook (called per state transition). */
  onEvent?: ClientEventHandler;
  /** Test seam for the sleep primitive. Default = setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for jitter randomness. Default = cryptographically-random float in [0,1). */
  random?: () => number;
}

export interface RateLimitTelemetry {
  limit: number | undefined;
  remaining: number | undefined;
  used: number | undefined;
  resetAt: Date | undefined;
}

export interface EtaggedOk<T> {
  status: 'ok';
  value: T;
  etag: string | undefined;
}
export interface EtaggedNotModified {
  status: 'notModified';
}
export type EtaggedResult<T> = EtaggedOk<T> | EtaggedNotModified;

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_UA = 'prompt-registry-lib/1.0 (+https://github.com/AmadeusITGroup/prompt-registry)';

/**
 * Single-funnel GitHub REST client. See module-level doc for the
 * full feature list.
 */
/* eslint-disable @typescript-eslint/member-ordering -- public API surface kept at top. */
export class GitHubClient {
  private readonly tokens: TokenProvider;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  public readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly jitterMs: number;
  private readonly maxSleepMs: number;
  private readonly onEvent: ClientEventHandler;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  /**
   * Latest rate-limit headers seen from GitHub. Updated on every
   * response regardless of status.
   */
  public lastRateLimit: RateLimitTelemetry = {
    limit: undefined,
    remaining: undefined,
    used: undefined,
    resetAt: undefined
  };

  public constructor(opts: GitHubClientOptions) {
    this.tokens = opts.tokens;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.fetchImpl = opts.fetch ?? ((req: Request) => fetch(req));
    this.maxRetries = opts.maxRetries ?? 4;
    this.backoffBaseMs = opts.backoffBaseMs ?? 250;
    this.jitterMs = opts.jitterMs ?? 250;
    this.maxSleepMs = opts.maxSleepMs ?? 60_000;
    this.onEvent = opts.onEvent ?? ((): void => undefined);
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? ((): number => randomInt(0, 1_000_000) / 1_000_000);
  }

  /**
   * GET returning parsed JSON. Throws GitHubApiError on non-2xx
   * after retries.
   * @param pathOrUrl Relative path (`/repos/...`) or absolute URL.
   * @param extraHeaders Additional headers to send.
   * @returns Parsed body.
   */
  public async getJson<T>(pathOrUrl: string, extraHeaders?: Record<string, string>): Promise<T> {
    const res = await this.request('GET', pathOrUrl, extraHeaders);
    return res.json() as Promise<T>;
  }

  /**
   * GET returning raw text body. Used for endpoints that return
   * non-JSON (raw content URLs, plain text).
   * @param pathOrUrl Path or URL.
   * @param extraHeaders Additional headers.
   * @returns Body text.
   */
  public async getText(pathOrUrl: string, extraHeaders?: Record<string, string>): Promise<string> {
    const res = await this.request('GET', pathOrUrl, extraHeaders);
    return res.text();
  }

  /**
   * GET with `If-None-Match` guard. Returns `{ status: 'notModified' }`
   * on 304, otherwise `{ status: 'ok', value, etag }`.
   * @param pathOrUrl Path or URL.
   * @param etag Optional previous ETag.
   * @returns Etagged result.
   */
  public async getJsonWithEtag<T>(
    pathOrUrl: string,
    etag?: string
  ): Promise<EtaggedResult<T>> {
    const headers: Record<string, string> = {};
    if (etag !== undefined && etag.length > 0) {
      headers['if-none-match'] = etag;
    }
    const res = await this.request('GET', pathOrUrl, headers, { allowStatus: [304] });
    if (res.status === 304) {
      this.onEvent({
        kind: 'not-modified',
        url: this.absoluteUrl(pathOrUrl),
        attempt: 1,
        status: 304,
        source: 'etag'
      });
      return { status: 'notModified' };
    }
    const value = await res.json() as T;
    return {
      status: 'ok',
      value,
      etag: res.headers.get('etag') ?? undefined
    };
  }

  // --- internal -----------------------------------------------------------

  private async request(
    method: string,
    pathOrUrl: string,
    extraHeaders?: Record<string, string>,
    opts?: { allowStatus?: number[] }
  ): Promise<Response> {
    const url = this.absoluteUrl(pathOrUrl);
    const host = new URL(url).hostname;
    const token = await this.tokens.getToken(host);
    const baseHeaders: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': this.userAgent,
      'x-github-api-version': '2022-11-28'
    };
    if (token !== null && token.length > 0) {
      baseHeaders.authorization = `Bearer ${token}`;
    }
    const headers = new Headers(baseHeaders);
    if (extraHeaders !== undefined) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        headers.set(k, v);
      }
    }
    let attempt = 0;
    let lastStatus = 0;
    let lastBody = '';
    while (attempt <= this.maxRetries) {
      attempt += 1;
      this.onEvent({ kind: 'request', url, attempt });
      const req = new Request(url, { method, headers });
      const res = await this.fetchImpl(req);
      lastStatus = res.status;
      this.captureRateLimit(res);
      const isAllowed = (opts?.allowStatus ?? []).includes(res.status);
      if (res.status < 400 || isAllowed) {
        this.onEvent({ kind: 'success', url, attempt, status: res.status });
        return res;
      }
      // Capture a short body for diagnostics; cap to avoid OOM on huge payloads.
      lastBody = (await res.clone().text()).slice(0, 500);
      const classification = classify(res, lastBody);
      if (classification.kind === 'fatal') {
        this.onEvent({ kind: 'give-up', url, attempt, status: res.status, reason: classification.reason });
        throw new GitHubApiError(
          `GitHub ${String(res.status)} (${classification.reason}): ${url} — ${lastBody}`,
          res.status, lastBody, url
        );
      }
      if (attempt > this.maxRetries) {
        break;
      }
      const sleepMs = Math.min(
        this.computeSleep(classification, attempt, res),
        this.maxSleepMs
      );
      this.onEvent({
        kind: classification.kind === 'rate-limit' || classification.kind === 'secondary-rate-limit'
          ? 'rate-limit'
          : 'retry',
        url, attempt, status: res.status, sleepMs,
        reason: classification.reason
      });
      await this.sleep(sleepMs);
    }
    this.onEvent({ kind: 'give-up', url, attempt, status: lastStatus, reason: `exhausted ${String(this.maxRetries)} retries` });
    throw new GitHubApiError(
      `GitHub ${String(lastStatus)} after ${String(this.maxRetries)} retries: ${url} — ${lastBody}`,
      lastStatus, lastBody, url
    );
  }

  private absoluteUrl(pathOrUrl: string): string {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      return pathOrUrl;
    }
    return this.baseUrl + pathOrUrl;
  }

  private captureRateLimit(res: Response): void {
    // Distinguish "header missing" (-> undefined) from "header is 0".
    const parseHeader = (name: string): number | undefined => {
      const raw = res.headers.get(name);
      if (raw === null) {
        return undefined;
      }
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const limit = parseHeader('x-ratelimit-limit');
    const remaining = parseHeader('x-ratelimit-remaining');
    const used = parseHeader('x-ratelimit-used');
    const resetUnix = parseHeader('x-ratelimit-reset');
    this.lastRateLimit = {
      limit,
      remaining,
      used,
      resetAt: resetUnix === undefined ? undefined : new Date(resetUnix * 1000)
    };
  }

  private computeSleep(
    classification: Classification,
    attempt: number,
    res: Response
  ): number {
    if (classification.kind === 'rate-limit') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (Number.isFinite(reset) && reset > 0) {
        const waitMs = Math.max(0, reset * 1000 - Date.now()) + 250;
        return Math.max(waitMs, 100);
      }
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra >= 0) {
        return Math.max(ra * 1000, 100);
      }
      return this.maxSleepMs;
    }
    if (classification.kind === 'secondary-rate-limit') {
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra >= 0) {
        return Math.max(ra * 1000, 100);
      }
      return this.backoffBaseMs * (2 ** (attempt - 1));
    }
    // transient 5xx / 429
    const back = this.backoffBaseMs * (2 ** (attempt - 1));
    const jitter = this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0;
    return back + jitter;
  }
}

interface Classification {
  kind: 'transient' | 'rate-limit' | 'secondary-rate-limit' | 'fatal';
  reason: string;
}

const classify = (res: Response, body: string): Classification => {
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      return { kind: 'rate-limit', reason: 'primary rate limit' };
    }
    if (/secondary rate limit/i.test(body) || res.headers.get('retry-after') !== null) {
      return { kind: 'secondary-rate-limit', reason: 'secondary rate limit' };
    }
    return { kind: 'fatal', reason: 'forbidden' };
  }
  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    return { kind: 'transient', reason: `status ${String(res.status)}` };
  }
  return { kind: 'fatal', reason: `status ${String(res.status)}` };
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Re-export the event/error types from this module so callers can
 * import everything from `github/client`.
 */

export { type ClientEventHandler, type ClientEvent } from './events';

export { GitHubApiError } from './errors';
