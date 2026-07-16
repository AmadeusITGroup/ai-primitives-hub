/**
 * HTTP port — network abstraction for source adapters and the install
 * pipeline.
 *
 * `app`/`infra` non-adapter code depends only on this interface, never on
 * `fetch`/`axios`/`node:http` directly. The production adapter
 * (`@ai-primitives-hub/infra`, Phase 3) wraps the real HTTP client.
 * @module ports/http
 */

export interface HttpResponse {
  /** Status code after redirect handling. */
  statusCode: number;
  /** Raw response body bytes. */
  body: Uint8Array;
  /** Final URL after any redirect chain. */
  finalUrl: string;
  /** Lower-cased response headers. */
  headers: Record<string, string>;
}

export interface HttpRequest {
  /** Absolute URL. */
  url: string;
  /** Defaults to `'GET'`. */
  method?: 'GET' | 'HEAD' | 'POST';
  /** Request headers (case-insensitive). */
  headers?: Record<string, string>;
  /** Request body, for `POST`. */
  body?: Uint8Array | string;
  /** Maximum redirect chain length; defaults to the adapter's own default. */
  maxRedirects?: number;
}

/**
 * The minimal HTTP surface source adapters and the install pipeline need.
 */
export interface HttpClient {
  fetch(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * Resolves a bearer token for an authenticated request, e.g. to GitHub's
 * API. Host-aware (`host` is the target request's hostname): the harvest
 * subsystem (Phase 3b) can walk many distinct sources/hosts in a single
 * run, and a provider must be able to refuse to hand a host-specific
 * credential (e.g. a GitHub token) to an unrelated host — a redirect
 * target, a different Enterprise instance, a caller-supplied URL that
 * turns out not to be GitHub at all. A concrete provider still closes
 * over whatever source/context it needs (an explicit `RegistrySource.token`,
 * a `gh` CLI lookup, a VS Code authentication session, ...) so callers
 * never need to know which strategy is in play, and infra never needs to
 * depend on delivery-specific auth mechanisms (e.g. the `vscode` module).
 *
 * Called once per request rather than cached by the caller, so a provider
 * backed by a session that can expire/rotate stays correct without infra
 * needing its own retry-on-401 logic.
 */
export interface TokenProvider {
  getToken(host: string): Promise<string | undefined>;
}
