/**
 * HttpsBundleDownloader — fetches a bundle's bytes and integrity-
 * checks them. As of the GitHub middleware migration this class is
 * a thin adapter over `AssetFetcher` (lib/src/github/asset-fetcher.ts):
 * the downloader keeps the existing `BundleDownloader` API surface
 * while gaining retries, Accept-header switching and the
 * inline-bytes shortcut from the shared middleware.
 *
 * Construct it with either:
 *   - a real `AssetFetcher` (recommended for production code), or
 *   - a legacy `(HttpClient, TokenProvider)` pair (kept for tests
 *     that already inject a fake `HttpClient`); we wrap that pair
 *     in an internal AssetFetcher so the behavior is identical.
 */
import {
  type Installable,
} from '@prompt-registry/core';
import {
  type BundleDownloader,
  type DownloadResult,
} from '@prompt-registry/core';
import {
  type HttpClient,
  type TokenProvider,
} from '@prompt-registry/core';
import {
  AssetFetcher,
} from '../github/asset-fetcher';
import {
  type FetchLike,
} from '../github/client';

/**
 * HttpsBundleDownloader — fetches a bundle's bytes and integrity-checks them.
 * Thin adapter over AssetFetcher that provides retries, Accept-header switching, and inline-bytes shortcut.
 */
export class HttpsBundleDownloader implements BundleDownloader {
  private readonly fetcher: AssetFetcher;

  /**
   * Construct from either a pre-built AssetFetcher (preferred) or a
   * legacy `(HttpClient, TokenProvider)` pair (back-compat for
   * existing tests). The legacy path adapts `HttpClient` to the
   * native `fetch` shape internally.
   * @param a Either an AssetFetcher or an HttpClient.
   * @param tokens Required when `a` is an HttpClient.
   */
  public constructor(
    a: AssetFetcher | HttpClient,
    tokens?: TokenProvider
  ) {
    if (a instanceof AssetFetcher) {
      this.fetcher = a;
      return;
    }
    if (tokens === undefined) {
      throw new Error('HttpsBundleDownloader: TokenProvider required when constructing from HttpClient');
    }
    // Legacy back-compat: wrap the HttpClient as a fetch impl.
    // The pre-migration HttpsBundleDownloader had NO retries, so we
    // preserve that semantics here. Callers who want retries should
    // construct an `AssetFetcher` directly and pass that instead.
    this.fetcher = new AssetFetcher({
      tokens,
      fetch: httpClientToFetch(a),
      maxRetries: 0
    });
  }

  /**
   * Fetch and integrity-check an installable's bundle bytes.
   * @param installable Resolved Installable.
   * @returns DownloadResult containing bytes + sha256 hex.
   */
  public async download(installable: Installable): Promise<DownloadResult> {
    return this.fetcher.fetchBytes(installable.downloadUrl, {
      integrity: installable.integrity,
      inlineBytes: installable.inlineBytes
    });
  }
}

/**
 * Adapter: wrap an `HttpClient` as a `FetchLike` so legacy callers
 * can still inject their fakes. Headers + body are mapped to the
 * native `Request` / `Response` shapes.
 * @param http Legacy HttpClient.
 * @returns FetchLike usable by AssetFetcher.
 */
const httpClientToFetch = (http: HttpClient): FetchLike =>
  async (req: Request): Promise<Response> => {
    // Convert Headers -> Record (lower-case keys preserved).
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const res = await http.fetch({
      url: req.url,
      headers,
      method: req.method === 'HEAD' ? 'HEAD' : 'GET'
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers
    });
  };
