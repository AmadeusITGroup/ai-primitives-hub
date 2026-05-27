/**
 * Node.js HTTP client adapter implementing the HttpClient port.
 *
 * Wraps global fetch (Node 18+) to provide the HttpClient interface.
 * This is the production implementation used by the CLI.
 */
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@prompt-registry/core';

export type { HttpClient, HttpRequest, HttpResponse } from '@prompt-registry/core';

/**
 * Production HTTP client using global fetch (Node 18+).
 */
export class NodeHttpClient implements HttpClient {
  public async fetch(req: HttpRequest): Promise<HttpResponse> {
    const resp = await globalThis.fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      redirect: 'follow'
    });

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
