/**
 * Hand-written `AzureDevOpsApi` test double, keyed by exact path/URL.
 *
 * Mirrors `FakeGitHubApi` — seed responses before calling adapter
 * methods, and any unseeded path throws a 404-style error so tests fail
 * fast on unexpected calls rather than silently returning `undefined`.
 */
import type { AzureDevOpsApi } from '@ai-primitives-hub/core';

export class FakeAzureDevOpsApi implements AzureDevOpsApi {
  private readonly jsonByPath = new Map<string, unknown>();
  private readonly textByPath = new Map<string, string>();
  private readonly bytesByPath = new Map<string, Uint8Array>();

  public seedJson(pathOrUrl: string, response: unknown): this {
    this.jsonByPath.set(pathOrUrl, response);
    return this;
  }

  public seedText(pathOrUrl: string, response: string): this {
    this.textByPath.set(pathOrUrl, response);
    return this;
  }

  public seedBytes(pathOrUrl: string, data: Uint8Array): this {
    this.bytesByPath.set(pathOrUrl, data);
    return this;
  }

  public getJson<T>(pathOrUrl: string): Promise<T> {
    if (!this.jsonByPath.has(pathOrUrl)) {
      throw new Error(`AzureDevOpsApi error: 404 - not seeded: ${pathOrUrl}`);
    }
    return Promise.resolve(this.jsonByPath.get(pathOrUrl) as T);
  }

  public getText(pathOrUrl: string): Promise<string> {
    const text = this.textByPath.get(pathOrUrl);
    if (text === undefined) {
      throw new Error(`AzureDevOpsApi error: 404 - not seeded: ${pathOrUrl}`);
    }
    return Promise.resolve(text);
  }

  public download(pathOrUrl: string): Promise<Uint8Array> {
    const bytes = this.bytesByPath.get(pathOrUrl);
    if (bytes === undefined) {
      throw new Error(`AzureDevOpsApi error: 404 - not seeded: ${pathOrUrl}`);
    }
    return Promise.resolve(bytes);
  }
}
