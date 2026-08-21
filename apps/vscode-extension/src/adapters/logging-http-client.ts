/**
 * `HttpClient` decorator that reports what was actually requested.
 *
 * Motivated by first-run setup reporting `✗ Hub unavailable` with no way
 * to tell a 404 from a 403 from a black-holed socket. Hub resolution calls
 * `NodeHttpClient` directly (see `infra`'s `hub/hub-resolver.ts`
 * `fetchYamlConfig`), so it never passes through `GitHubApiClient` and
 * gets none of that client's `onEvent` telemetry - the request was
 * completely unobserved.
 *
 * Wrapping rather than modifying `NodeHttpClient` keeps the reporting in
 * the delivery layer, where the `Logger` lives: `HttpClient` is a `core`
 * port, so a decorator composes without `infra` gaining a logger
 * dependency.
 *
 * Volume policy, learned from the auth-event work: `Logger` defaults to
 * DEBUG in normal operation, so anything emitted is effectively visible to
 * every user. A bundle sync issues hundreds of requests, so successful
 * ones are reported only when tracing is explicitly enabled. Failures -
 * non-2xx and transport errors - are always reported, because they are the
 * thing being diagnosed and they are rare.
 *
 * Never logs credentials: an `Authorization` header is reported as
 * `auth=yes` and its value is never read.
 * @module adapters/logging-http-client
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';
import * as vscode from 'vscode';
import {
  Logger,
} from '../utils/logger';

const PREFIX = '[Http]';

/**
 * Render a request target compactly, without credentials or cache-busting
 * noise.
 *
 * The hub resolver appends a `?t=<timestamp>` cache-buster to every
 * `hub-config.yml` fetch; keeping it would make otherwise-identical lines
 * look different. Any other query string is preserved, since it can be
 * load-bearing, but a `token`/`access_token` parameter is masked in case a
 * caller ever puts a credential in a URL.
 * @param url - Absolute request URL.
 * @returns `host/path` plus any meaningful query, credentials masked.
 */
export function describeRequestTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  parsed.searchParams.delete('t');
  for (const name of ['token', 'access_token']) {
    if (parsed.searchParams.has(name)) {
      parsed.searchParams.set(name, '***');
    }
  }
  const query = parsed.searchParams.toString();
  return `${parsed.host}${parsed.pathname}${query.length > 0 ? `?${query}` : ''}`;
}

/**
 * True when the request carries an `Authorization` header, whatever its
 * casing. The value itself is never inspected.
 * @param request - The outgoing request.
 * @returns Whether credentials were attached.
 */
function hasAuthorization(request: HttpRequest): boolean {
  const headers = request.headers ?? {};
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
}

export interface LoggingHttpClientOptions {
  /**
   * Report successful requests too. Off by default: normal operation
   * issues hundreds of them. Driven by `promptregistry.logging.httpTrace`.
   */
  trace?: boolean;
}

export class LoggingHttpClient implements HttpClient {
  private readonly logger = Logger.getInstance();

  /**
   * Wrap an `HttpClient` with request reporting.
   * @param inner - The client doing the actual work.
   * @param options - Reporting policy; see `LoggingHttpClientOptions`.
   */
  public constructor(
    private readonly inner: HttpClient,
    private readonly options: LoggingHttpClientOptions = {}
  ) {}

  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    const method = request.method ?? 'GET';
    const target = describeRequestTarget(request.url);
    const auth = hasAuthorization(request) ? 'yes' : 'no';
    const startedAt = Date.now();

    try {
      const response = await this.inner.fetch(request);
      const elapsed = Date.now() - startedAt;
      const line = `${PREFIX} ${method} ${target} auth=${auth} -> ${response.statusCode} (${elapsed}ms)`;

      if (response.statusCode >= 400) {
        // Always visible: this is the detail missing from "unavailable".
        this.logger.warn(line);
      } else if (this.options.trace === true) {
        this.logger.debug(line);
      }
      if (response.finalUrl !== request.url && this.options.trace === true) {
        this.logger.debug(`${PREFIX} ${method} ${target} redirected to ${describeRequestTarget(response.finalUrl)}`);
      }
      return response;
    } catch (error) {
      // A transport failure - DNS, refused connection, or a socket that
      // hung until the OS gave up. The elapsed time is the tell: a long
      // one means the host accepted nothing back.
      const elapsed = Date.now() - startedAt;
      this.logger.warn(
        `${PREFIX} ${method} ${target} auth=${auth} -> failed after ${elapsed}ms: `
        + `${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }
}

/**
 * Whether successful requests should be reported.
 *
 * Off by default: a bundle sync issues hundreds of requests, and `Logger`
 * defaults to DEBUG, so always-on tracing would drown the channel.
 * Failures are reported regardless of this setting.
 * @returns The `promptregistry.logging.httpTrace` setting.
 */
export function isHttpTraceEnabled(): boolean {
  return vscode.workspace.getConfiguration('promptregistry').get<boolean>('logging.httpTrace', false);
}
