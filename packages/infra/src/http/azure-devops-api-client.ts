/**
 * `AzureDevOpsApi` port implementation, backed by an injected `HttpClient`.
 *
 * Azure DevOps REST API uses HTTP Basic authentication with a Personal
 * Access Token: `Authorization: Basic base64(:<pat>)` (empty username,
 * PAT as password). Token resolution is delegated to the injected
 * `TokenProvider`, keeping delivery-specific auth strategy (env var,
 * secure storage, VS Code session) out of this layer.
 * @module http/azure-devops-api-client
 */
import type { AzureDevOpsApi, HttpClient, TokenProvider } from '@ai-primitives-hub/core';

export interface AzureDevOpsApiClientOptions {
  /** Resolves a PAT for each request. Required for private repositories. */
  tokenProvider?: TokenProvider;
  /** ADO org base URL, e.g. `https://dev.azure.com/myorg`. Defaults to `https://dev.azure.com`. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://dev.azure.com';

export class AzureDevOpsApiClient implements AzureDevOpsApi {
  public constructor(
    private readonly http: HttpClient,
    private readonly options: AzureDevOpsApiClientOptions = {}
  ) {}

  private resolveUrl(pathOrUrl: string): string {
    return /^https?:\/\//.test(pathOrUrl)
      ? pathOrUrl
      : `${this.options.baseUrl ?? DEFAULT_BASE_URL}${pathOrUrl}`;
  }

  private async buildHeaders(url: string, accept: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: accept };
    const host = new URL(url).hostname;
    const token = await this.options.tokenProvider?.getToken(host);
    if (token) {
      const encoded = Buffer.from(`:${token}`).toString('base64');
      headers.Authorization = `Basic ${encoded}`;
    }
    return headers;
  }

  private assertOk(response: { statusCode: number }, url: string): void {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(this.describeError(response.statusCode, url));
    }
  }

  private describeError(statusCode: number, url: string): string {
    switch (statusCode) {
      case 401: { 
        return `Azure DevOps: unauthorized (401) — check that a valid PAT is configured for ${url}`;
      }
      case 403: { 
        return `Azure DevOps: forbidden (403) — PAT may lack the required scope for ${url}`;
      }
      case 404: {
        return `Azure DevOps: not found (404) — ${url}`; 
      }
      default: {
        return `Azure DevOps: unexpected status ${String(statusCode)} from ${url}`;
      }
    }
  }

  public async getJson<T>(pathOrUrl: string): Promise<T> {
    const url = this.resolveUrl(pathOrUrl);
    const headers = await this.buildHeaders(url, 'application/json');
    const response = await this.http.fetch({ url, headers });
    this.assertOk(response, url);
    return JSON.parse(Buffer.from(response.body).toString('utf8')) as T;
  }

  public async getText(pathOrUrl: string): Promise<string> {
    const url = this.resolveUrl(pathOrUrl);
    const headers = await this.buildHeaders(url, 'text/plain');
    const response = await this.http.fetch({ url, headers });
    this.assertOk(response, url);
    return Buffer.from(response.body).toString('utf8');
  }

  public async download(pathOrUrl: string): Promise<Uint8Array> {
    const url = this.resolveUrl(pathOrUrl);
    const headers = await this.buildHeaders(url, 'application/octet-stream');
    const response = await this.http.fetch({ url, headers });
    this.assertOk(response, url);
    return response.body;
  }
}
