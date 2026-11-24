/**
 * Node `http`/`https`-backed implementation of the `HttpClient` port.
 *
 * Consolidates the raw-request/redirect-following logic that was
 * duplicated across `src/adapters/github-adapter.ts`'s `makeRequest` and
 * `downloadFile` methods into one place, generic over any HTTP(S) source
 * (not just GitHub) so every future adapter that needs raw HTTP can share
 * it instead of re-implementing redirect handling again.
 * @module http/node-http-client
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import {
  getDefaultUserAgent,
} from './user-agent';

const DEFAULT_MAX_REDIRECTS = 10;
/** Default timeout applied to every HTTP request without an explicit timeout. */
export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
/** Maximum delay supported by Node's timer APIs. */
export const MAX_HTTP_TIMEOUT_MS = 2_147_483_647;
/**
 * Default time a request sent on a reused keep-alive connection may wait for
 * its response headers before it is sent again on a fresh connection.
 */
export const DEFAULT_REUSED_CONNECTION_TIMEOUT_MS = 5000;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
/** Socket errors of a reused connection that the server or a proxy closed. */
const REUSED_CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE']);
/**
 * Origins whose reused connections failed: they get a fresh connection per
 * request. Shared by every client of the process, like Node's global agent
 * whose connections they describe.
 */
const freshConnectionOrigins = new Set<string>();

/** Options of {@link NodeHttpClient}. */
export interface NodeHttpClientOptions {
  /**
   * Time a `GET` or `HEAD` request sent on a reused keep-alive connection may
   * wait for its response headers before it is sent again on a fresh
   * connection. Defaults to {@link DEFAULT_REUSED_CONNECTION_TIMEOUT_MS}.
   */
  reusedConnectionTimeoutMs?: number;
}

/**
 * A request sent on a reused keep-alive connection got no response headers
 * in time, or the connection was closed under it.
 */
class ReusedConnectionError extends Error {}

/**
 * A request that needs a fresh connection got an idle pooled one. The socket
 * is discarded before anything is written to it, and the request sent again.
 */
class PooledConnectionError extends Error {}

/**
 * Some proxies and middleboxes leave a request unanswered, or reset it, when
 * it is sent on a keep-alive connection that already carried a request. The
 * client keeps Node's global agent (and so any proxy configured on it), sends
 * such a `GET` or `HEAD` request again once on a fresh connection, and then
 * asks for a fresh connection (`Connection: close`) for every later request to
 * that origin, in every client of the process. A request to such an origin
 * that the agent assigns an idle pooled connection discards it unused and
 * tries again, so it never reaches the server on a reused connection.
 * Requests with a body are never sent twice.
 */
export class NodeHttpClient implements HttpClient {
  private readonly reusedConnectionTimeoutMs: number;

  public constructor(options: NodeHttpClientOptions = {}) {
    this.reusedConnectionTimeoutMs = options.reusedConnectionTimeoutMs ?? DEFAULT_REUSED_CONNECTION_TIMEOUT_MS;
  }

  private async fetchFollowingRedirects(
    request: HttpRequest,
    url: string,
    redirectsRemaining: number,
    deadline: number,
    timeoutMs: number
  ): Promise<HttpResponse> {
    const response = await this.fetchRetryingReusedConnection(request, url, deadline, timeoutMs);

    if (request.followRedirects !== false && REDIRECT_STATUS_CODES.has(response.statusCode) && response.headers.location) {
      if (redirectsRemaining <= 0) {
        throw new Error(`Maximum redirect count exceeded fetching ${request.url}`);
      }
      const nextUrl = new URL(response.headers.location, url).toString();
      // Strip credentials before following a cross-origin redirect (e.g. a
      // GitHub release asset redirecting to a pre-signed S3/Azure URL) -
      // matches fetch()/browser behavior. Same-origin redirects keep every
      // header, including Authorization, unchanged.
      const nextRequest = isSameOrigin(url, nextUrl) ? request : stripCredentialHeaders(request);
      return this.fetchFollowingRedirects(nextRequest, nextUrl, redirectsRemaining - 1, deadline, timeoutMs);
    }

    return response;
  }

  /**
   * Fetch one URL, and send the request again once on a fresh connection when
   * its reused keep-alive connection failed. Only requests without a body get
   * there (see `fetchOnce`), so they are safe to repeat. A request that needs
   * a fresh connection but got an idle pooled one was never sent, and is sent
   * again until it gets a fresh connection: each attempt takes one idle
   * connection out of the pool.
   * @param request Request being fetched.
   * @param url URL of this hop.
   * @param deadline Request deadline (epoch milliseconds).
   * @param timeoutMs Configured request timeout, for the error message.
   * @returns The response of this hop.
   */
  private async fetchRetryingReusedConnection(
    request: HttpRequest,
    url: string,
    deadline: number,
    timeoutMs: number
  ): Promise<HttpResponse> {
    let resent = false;
    for (;;) {
      const remainingTimeoutMs = deadline - Date.now();
      if (remainingTimeoutMs <= 0) {
        throw new Error(`HTTP request to ${request.url} timed out after ${timeoutMs} ms`);
      }
      try {
        return await this.fetchOnce(request, url, remainingTimeoutMs, timeoutMs);
      } catch (error) {
        if (error instanceof PooledConnectionError) {
          continue;
        }
        if (!(error instanceof ReusedConnectionError) || resent) {
          throw error;
        }
        freshConnectionOrigins.add(new URL(url).origin);
        resent = true;
      }
    }
  }

  private async fetchOnce(
    request: HttpRequest,
    url: string,
    timeoutMs: number,
    configuredTimeoutMs: number
  ): Promise<HttpResponse> {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const userAgentHeaders = this.ensureUserAgent(request.headers);
    const freshConnection = freshConnectionOrigins.has(target.origin);
    const headers = freshConnection
      ? { ...userAgentHeaders, Connection: 'close' }
      : userAgentHeaders;
    const method = request.method ?? 'GET';
    const repeatable = (method === 'GET' || method === 'HEAD') && request.body === undefined;

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const state: {
        timeoutHandle?: NodeJS.Timeout;
        reusedConnectionHandle?: NodeJS.Timeout;
        requestHandle?: http.ClientRequest;
      } = {};
      const timeoutError = new Error(`HTTP request to ${request.url} timed out after ${configuredTimeoutMs} ms`);
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(state.timeoutHandle);
        clearTimeout(state.reusedConnectionHandle);
        callback();
      };
      const handleTimeout = (): void => {
        settle(() => {
          reject(timeoutError);
          state.requestHandle?.destroy(timeoutError);
        });
      };
      const failReusedConnection = (reason: string): void => {
        settle(() => {
          reject(new ReusedConnectionError(`HTTP request to ${url} failed: ${reason} on a reused connection`));
          state.requestHandle?.destroy();
        });
      };

      const requestHandle = transport.request(
        target,
        { method, headers },
        (res) => {
          clearTimeout(state.reusedConnectionHandle);
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            settle(() => resolve({
              statusCode: res.statusCode ?? 0,
              body: new Uint8Array(Buffer.concat(chunks)),
              finalUrl: url,
              headers: flattenHeaders(res.headers)
            }));
          });
          res.on('error', (error) => {
            settle(() => reject(new Error(`HTTP request to ${url} failed: ${error.message}`)));
          });
        }
      );
      state.requestHandle = requestHandle;

      const send = (): void => {
        if (request.body !== undefined) {
          requestHandle.write(request.body);
        }
        requestHandle.end();
      };

      requestHandle.once('socket', () => {
        if (freshConnection) {
          // The agent may hand out an idle pooled connection whatever the
          // `Connection` header says. Nothing is written until the connection
          // is known to be fresh, so a pooled one is discarded unused.
          if (requestHandle.reusedSocket) {
            settle(() => {
              reject(new PooledConnectionError(`HTTP request to ${url} got a pooled connection`));
              requestHandle.destroy();
            });
            return;
          }
          send();
          return;
        }
        if (repeatable && requestHandle.reusedSocket) {
          state.reusedConnectionHandle = setTimeout(
            () => failReusedConnection('no response'),
            this.reusedConnectionTimeoutMs
          );
        }
      });
      requestHandle.on('error', (error: NodeJS.ErrnoException) => {
        if (repeatable && requestHandle.reusedSocket && REUSED_CONNECTION_ERROR_CODES.has(error.code ?? '')) {
          failReusedConnection(error.message);
          return;
        }
        settle(() => reject(new Error(`HTTP request to ${url} failed: ${error.message}`)));
      });
      state.timeoutHandle = setTimeout(handleTimeout, timeoutMs);

      if (!freshConnection) {
        send();
      }
    });
  }

  /**
   * Ensure the request headers include a User-Agent. GitHub's API requires
   * one for authenticated requests; the old fetch-based NodeHttpClient got
   * one from the runtime, but node:http does not set it by default.
   * @param headers Request headers (may be undefined).
   * @returns Headers with a default User-Agent if none was present.
   */
  private ensureUserAgent(headers?: Record<string, string>): Record<string, string> {
    const result = headers ?? {};
    if (result['User-Agent'] === undefined && result['user-agent'] === undefined) {
      result['User-Agent'] = getDefaultUserAgent();
    }
    return result;
  }

  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_HTTP_TIMEOUT_MS) {
      throw new Error(
        `HTTP request timeout must be a positive finite number no greater than ${MAX_HTTP_TIMEOUT_MS}, got ${timeoutMs}`
      );
    }
    return this.fetchFollowingRedirects(
      request,
      request.url,
      request.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      Date.now() + timeoutMs,
      timeoutMs
    );
  }
}

function isSameOrigin(a: string, b: string): boolean {
  const urlA = new URL(a);
  const urlB = new URL(b);
  return urlA.protocol === urlB.protocol && urlA.host === urlB.host;
}

const CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'cookie', 'proxy-authorization']);

function stripCredentialHeaders(request: HttpRequest): HttpRequest {
  if (!request.headers) {
    return request;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!CREDENTIAL_HEADER_NAMES.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return { ...request, headers };
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const flattened: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      flattened[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return flattened;
}
