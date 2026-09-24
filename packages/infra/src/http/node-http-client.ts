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

const DEFAULT_MAX_REDIRECTS = 10;
/** Default timeout applied to every HTTP request without an explicit timeout. */
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export class NodeHttpClient implements HttpClient {
  private async fetchFollowingRedirects(
    request: HttpRequest,
    url: string,
    redirectsRemaining: number,
    deadline: number,
    timeoutMs: number
  ): Promise<HttpResponse> {
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs <= 0) {
      throw new Error(`HTTP request to ${request.url} timed out after ${timeoutMs} ms`);
    }

    const response = await this.fetchOnce(request, url, remainingTimeoutMs, timeoutMs);

    if (REDIRECT_STATUS_CODES.has(response.statusCode) && response.headers.location) {
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

  private async fetchOnce(
    request: HttpRequest,
    url: string,
    timeoutMs: number,
    configuredTimeoutMs: number
  ): Promise<HttpResponse> {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const headers = this.ensureUserAgent(request.headers);

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const state: {
        timeoutHandle?: NodeJS.Timeout;
        requestHandle?: http.ClientRequest;
      } = {};
      const timeoutError = new Error(`HTTP request to ${request.url} timed out after ${configuredTimeoutMs} ms`);
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (state.timeoutHandle) {
          clearTimeout(state.timeoutHandle);
        }
        callback();
      };
      const handleTimeout = (): void => {
        settle(() => {
          reject(timeoutError);
          state.requestHandle?.destroy(timeoutError);
        });
      };

      const requestHandle = transport.request(
        target,
        { method: request.method ?? 'GET', headers },
        (res) => {
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

      requestHandle.on('error', (error) => {
        settle(() => reject(new Error(`HTTP request to ${url} failed: ${error.message}`)));
      });
      state.timeoutHandle = setTimeout(handleTimeout, timeoutMs);

      if (request.body !== undefined) {
        requestHandle.write(request.body);
      }
      requestHandle.end();
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
      result['User-Agent'] = 'ai-primitives-hub/1.0';
    }
    return result;
  }

  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`HTTP request timeout must be a positive finite number, got ${timeoutMs}`);
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
