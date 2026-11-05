import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@ai-primitives-hub/core';

/** One validation run's GET evidence, isolated by URL, headers and redirect policy. */
export class HttpSnapshot implements HttpClient {
  private readonly responses = new Map<string, Promise<HttpResponse>>();

  public constructor(private readonly http: HttpClient) {}

  public fetch(request: HttpRequest): Promise<HttpResponse> {
    if ((request.method ?? 'GET') !== 'GET' || request.body !== undefined) {
      return this.http.fetch(request);
    }
    // Headers include Accept and credentials: never share evidence across identities.
    // This in-memory key must never be logged or persisted.
    const key = JSON.stringify([request.url, request.maxRedirects,
      Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]).toSorted()]);
    let pending = this.responses.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => this.http.fetch(request));
      this.responses.set(key, pending);
      void pending.then((response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          this.responses.delete(key);
        }
      }, () => this.responses.delete(key));
    }
    return pending;
  }
}
