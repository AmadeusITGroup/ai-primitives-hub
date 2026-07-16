/**
 * Shared test helper — a route-table `HttpClient` double.
 *
 * Used by `http/github-api-client.test.ts` to exercise `GitHubApiClient`
 * itself (the one place that legitimately needs to drive the raw
 * `HttpClient` port directly). The `resolvers/*.ts` GitHub-backed
 * resolvers depend on the higher-level `GitHubApi` port instead — see
 * `resolvers/github-resolver.ts`'s module doc — so their tests use
 * `fake-github-api.ts`/`recording-github-api.ts`, not this helper.
 * Matches `test/AGENTS.md`'s "mandatory helper reuse" principle, applied
 * to this package's own Vitest suites.
 * @module test/helpers/fake-http-client
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';

export interface FakeRoute {
  method?: string;
  url: string;
  status: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

/**
 * A minimal `HttpClient` double backed by an exact-URL route table.
 * Records every request made for assertions (e.g. auth headers sent).
 */
export class FakeHttpClient implements HttpClient {
  private readonly routes: FakeRoute[] = [];
  public readonly calls: HttpRequest[] = [];

  /**
   * Register a response for an exact URL (+ optional method).
   * @param route - Route definition to add.
   * @returns `this`, for chaining.
   */
  public addRoute(route: FakeRoute): this {
    this.routes.push(route);
    return this;
  }

  public fetch(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request);
    const method = request.method ?? 'GET';
    const route = this.routes.find((r) => r.url === request.url && (r.method ?? 'GET') === method);
    if (route === undefined) {
      throw new Error(`FakeHttpClient: no route registered for ${method} ${request.url}`);
    }
    const body = typeof route.body === 'string' ? new TextEncoder().encode(route.body) : route.body ?? new Uint8Array();
    return Promise.resolve({
      statusCode: route.status,
      body,
      finalUrl: request.url,
      headers: route.headers ?? {}
    });
  }
}
