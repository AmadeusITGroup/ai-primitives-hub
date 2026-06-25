/**
 * Node.js HTTP client adapter implementing the HttpClient port.
 *
 * Wraps global fetch (Node 18+) to provide the HttpClient interface.
 * This is the production implementation used by the CLI.
 *
 * Automatically respects `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` env vars so
 * that corporate networks work the same way `gh` CLI does. Without this,
 * `globalThis.fetch` may fail with "fetch failed" while `gh api` succeeds.
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@prompt-registry/core';
import {
  createProxyAwareFetch,
  type FetchLike,
} from './proxy-aware-fetch';

export type { HttpClient, HttpRequest, HttpResponse } from '@prompt-registry/core';

export interface NodeHttpClientOptions {
  /**
   * Environment bag used to detect `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`.
   * Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>;
  /**
   * Override fetch implementation. Used by tests and by callers that already
   * provide a proxy-aware or instrumented fetch.
   */
  fetch?: FetchLike;
}

/**
 * Production HTTP client using global fetch (Node 18+).
 */
export class NodeHttpClient implements HttpClient {
  private readonly fetchImpl: FetchLike;

  public constructor(opts: NodeHttpClientOptions = {}) {
    const env = opts.env ?? process.env;
    this.fetchImpl = opts.fetch ?? createProxyAwareFetch(env);
  }

  public async fetch(req: HttpRequest): Promise<HttpResponse> {
    const resp = await this.fetchImpl(new Request(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      redirect: 'follow'
    }));

    const headers: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      statusCode: resp.status,
      body: new Uint8Array(await resp.arrayBuffer()),
      finalUrl: resp.url,
      headers
    };
  }
}
