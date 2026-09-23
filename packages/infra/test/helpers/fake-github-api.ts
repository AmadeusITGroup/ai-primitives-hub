/**
 * Hand-written `GitHubApi` test double, keyed by exact path/URL.
 *
 * Shared across `github-adapter.test.ts` today and (once ported)
 * `skills-adapter.test.ts` — both consume the same `GitHubApi` port.
 */
import type {
  EtaggedResult,
  GitHubApi,
} from '@ai-primitives-hub/core';

export class FakeGitHubApi implements GitHubApi {
  private readonly jsonByPath = new Map<string, unknown>();
  private readonly textByPath = new Map<string, string>();
  private readonly bytesByPath = new Map<string, Uint8Array>();
  private readonly etagByPath = new Map<string, string>();

  /**
   * Seed a JSON response, optionally tagged with an ETag so
   * `getJsonWithEtag` can simulate a 304 when the caller passes the same
   * etag back in.
   * @param pathOrUrl
   * @param value
   * @param etag
   */
  public seedJson(pathOrUrl: string, value: unknown, etag?: string): this {
    this.jsonByPath.set(pathOrUrl, value);
    if (etag !== undefined) {
      this.etagByPath.set(pathOrUrl, etag);
    }
    return this;
  }

  public seedText(pathOrUrl: string, value: string): this {
    this.textByPath.set(pathOrUrl, value);
    return this;
  }

  public seedBytes(pathOrUrl: string, value: Uint8Array): this {
    this.bytesByPath.set(pathOrUrl, value);
    return this;
  }

  public getJson<T>(pathOrUrl: string): Promise<T> {
    if (!this.jsonByPath.has(pathOrUrl)) {
      return Promise.reject(new Error(`GitHub API error: 404 - not seeded: ${pathOrUrl}`));
    }
    return Promise.resolve(this.jsonByPath.get(pathOrUrl) as T);
  }

  public async getJsonWithHeaders<T>(pathOrUrl: string): Promise<{ value: T; headers: Record<string, string> }> {
    return { value: await this.getJson<T>(pathOrUrl), headers: {} };
  }

  public getText(pathOrUrl: string): Promise<string> {
    const text = this.textByPath.get(pathOrUrl);
    if (text === undefined) {
      return Promise.reject(new Error(`GitHub API error: 404 - not seeded: ${pathOrUrl}`));
    }
    return Promise.resolve(text);
  }

  public download(pathOrUrl: string): Promise<Uint8Array> {
    const bytes = this.bytesByPath.get(pathOrUrl);
    if (bytes === undefined) {
      return Promise.reject(new Error(`GitHub API error: 404 - not seeded: ${pathOrUrl}`));
    }
    return Promise.resolve(bytes);
  }

  public async getJsonWithEtag<T>(pathOrUrl: string, etag?: string): Promise<EtaggedResult<T>> {
    const current = this.etagByPath.get(pathOrUrl);
    if (etag !== undefined && current !== undefined && etag === current) {
      return { status: 'notModified' };
    }
    return { status: 'ok', value: await this.getJson<T>(pathOrUrl), etag: current };
  }
}
