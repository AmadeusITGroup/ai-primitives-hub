/**
 * AssetFetcher — fetches binary content (release assets, raw blobs)
 * over HTTPS. Companion to `GitHubClient`, optimized for the
 * "download bytes" use case rather than the JSON REST surface.
 *
 * Differences vs `GitHubClient`:
 *   - Different Accept header policy:
 *       `api.github.com/.../releases/assets/<id>` requires exactly
 *         `Accept: application/octet-stream` (anything broader makes
 *         GitHub return JSON metadata) — this is I-012.
 *       Other hosts get a permissive
 *         `application/octet-stream, application/zip, *\u002F*`.
 *   - No rate-limit-header awareness (release-asset URLs and S3
 *     redirects don't carry x-ratelimit-* headers).
 *   - Lighter retry budget (default 3 vs 4) — bandwidth wastes on
 *     huge zip retries.
 *   - Integrity check via `sha256-<hex>`.
 *   - `inlineBytes` shortcut: when the caller already has the bytes
 *     (synthesized bundles from awesome-copilot/skills resolvers),
 *     skip the network entirely.
 * @module github/asset-fetcher
 */
import {
  createHash,
  randomInt,
} from 'node:crypto';
import type {
  FetchLike,
} from './client';
import {
  GitHubApiError,
  GitHubNetworkError,
} from './errors';
import type {
  TokenProvider,
} from './token';
import {
  isGitHubHost,
} from './url';

export interface AssetFetcherOptions {
  tokens: TokenProvider;
  /** Injected fetch for tests. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** User-Agent. */
  userAgent?: string;
  /** Max retries. Default 3. */
  maxRetries?: number;
  /** Initial backoff in ms. Default 250. */
  backoffBaseMs?: number;
  /** Jitter (ms). Default 250. */
  jitterMs?: number;
  /** Test seam for the sleep primitive. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for the random source. */
  random?: () => number;
}

export interface FetchBytesOptions {
  /** Optional `sha256-<hex>` to verify against the body. */
  integrity?: string;
  /**
   * When set, return these bytes directly. Used by source resolvers
   * that synthesize bundles in memory (awesome-copilot, skills).
   */
  inlineBytes?: Uint8Array;
}

export interface FetchBytesResult {
  bytes: Uint8Array;
  sha256: string;
}

const DEFAULT_UA = 'prompt-registry-lib/1.0 (+https://github.com/AmadeusITGroup/prompt-registry)';

/**
 * Fetches binary content over HTTPS with sensible retries + an
 * optional integrity check. See module docs for the full policy.
 */
/* eslint-disable @typescript-eslint/member-ordering -- public API first. */
export class AssetFetcher {
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly jitterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  public constructor(opts: AssetFetcherOptions) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetch ?? (((req: Request) => fetch(req)) as FetchLike);
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 250;
    this.jitterMs = opts.jitterMs ?? 250;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? ((): number => randomInt(0, 1_000_000) / 1_000_000);
  }

  /**
   * Fetch bytes from a URL with auto-Accept selection, retry on
   * transient 5xx, and optional integrity check.
   * @param url Absolute URL to fetch.
   * @param opts Optional integrity hash + inline-bytes shortcut.
   * @returns `{ bytes, sha256 }`.
   */
  public async fetchBytes(url: string, opts: FetchBytesOptions = {}): Promise<FetchBytesResult> {
    if (opts.inlineBytes !== undefined) {
      const inlineSha256 = sha256Hex(opts.inlineBytes);
      this.verifyIntegrity(opts.integrity, inlineSha256, '<inline>');
      return { bytes: opts.inlineBytes, sha256: inlineSha256 };
    }
    const res = await this.fetchWithRetry(url);
    const body = new Uint8Array(await res.arrayBuffer());
    const sha256 = sha256Hex(body);
    this.verifyIntegrity(opts.integrity, sha256, url);
    return { bytes: body, sha256 };
  }

  // --- internal -----------------------------------------------------------

  private handleNetworkError(err: unknown, attempt: number, url: string): never {
    if (attempt > this.maxRetries) {
      throw new GitHubNetworkError(
        `network error after ${String(this.maxRetries)} retries: ${url}`,
        url,
        err instanceof Error ? err : undefined
      );
    }
    throw err; // Signal retry to caller
  }

  private async handleResponseStatus(res: Response, url: string, attempt: number): Promise<{ shouldRetry: boolean; body: string }> {
    if (res.status >= 200 && res.status < 300) {
      return { shouldRetry: false, body: '' };
    }
    const body = (await res.clone().text()).slice(0, 500);
    if (!isTransient(res.status)) {
      throw new GitHubApiError(
        `asset fetch failed: HTTP ${String(res.status)} for ${url} — ${body}`,
        res.status, body, url
      );
    }
    if (attempt > this.maxRetries) {
      throw new GitHubApiError(
        `asset fetch failed: HTTP ${String(res.status)} after ${String(this.maxRetries)} retries: ${url}`,
        res.status, body, url
      );
    }
    return { shouldRetry: true, body };
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    const headers = await this.buildHeaders(url);
    return this.executeRetryLoop(url, headers);
  }

  private async executeRetryLoop(url: string, headers: Headers): Promise<Response> {
    return this.retryFetchWithBackoff(url, headers);
  }

  private async retryFetchWithBackoff(url: string, headers: Headers): Promise<Response> {
    let attempt = 0;
    let lastStatus = 0;
    let lastBody = '';
    while (attempt <= this.maxRetries) {
      attempt += 1;
      let res: Response;
      try {
        res = await this.attemptFetch(url, headers, attempt);
      } catch (err) {
        if (attempt > this.maxRetries) {
          throw new GitHubNetworkError(
            `network error after ${String(this.maxRetries)} retries: ${url}`,
            url,
            err instanceof Error ? err : undefined
          );
        }
        await this.sleep(this.computeSleep(attempt));
        continue;
      }
      lastStatus = res.status;
      const statusCheck = await this.handleResponseStatus(res, url, attempt);
      if (!statusCheck.shouldRetry) {
        return res;
      }
      lastBody = statusCheck.body;
      await this.sleep(this.computeSleep(attempt));
    }
    throw new GitHubApiError(
      `asset fetch failed: HTTP ${String(lastStatus)} after ${String(this.maxRetries)} retries: ${url}`,
      lastStatus, lastBody, url
    );
  }

  private async attemptFetch(url: string, headers: Headers, _attempt: number): Promise<Response> {
    return await this.fetchImpl(new Request(url, { method: 'GET', headers }));
  }

  private async buildHeaders(url: string): Promise<Headers> {
    const u = new URL(url);
    const accept = isApiAssetUrl(u)
      ? 'application/octet-stream'
      : 'application/octet-stream, application/zip, */*';
    const headers = new Headers({
      accept,
      'user-agent': this.userAgent
    });
    if (isGitHubHost(u.hostname)) {
      const token = await this.tokens.getToken(u.hostname);
      if (token !== null && token.length > 0) {
        headers.set('authorization', `Bearer ${token}`);
      }
    }
    return headers;
  }

  private computeSleep(attempt: number): number {
    const back = this.backoffBaseMs * (2 ** (attempt - 1));
    const jitter = this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0;
    return back + jitter;
  }

  private verifyIntegrity(integrity: string | undefined, actual: string, where: string): void {
    if (integrity === undefined) {
      return;
    }
    const expected = integrity.replace(/^sha256-/, '');
    if (expected !== actual) {
      throw new Error(`integrity mismatch for ${where}: expected ${expected}, got ${actual}`);
    }
  }
}

const isApiAssetUrl = (u: URL): boolean =>
  u.hostname === 'api.github.com' && /\/releases\/assets\/\d+/.test(u.pathname);

const isTransient = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
