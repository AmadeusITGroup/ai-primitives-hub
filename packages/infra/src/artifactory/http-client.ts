/* eslint-disable @typescript-eslint/member-ordering, @stylistic/max-len, @stylistic/max-statements-per-line, @stylistic/no-mixed-operators, unicorn/no-nested-ternary -- small transport implementation keeps policy together */
import {
  type HttpClient,
  type HttpCredentialProvider,
  type HttpResponse,
  type PublishedObject,
  RegistryError,
  type SourceRequestContext,
} from '@ai-primitives-hub/core';
import {
  isWithinSourceRoot,
  normalizeSourceRoot,
  resolveConfinedObject,
} from './published-object-url';

export interface ConditionalJsonResult<T> { status: 'fresh' | 'not-modified'; value?: T; etag?: string; finalUrl: string }
export interface ArtifactoryHttpClientOptions { maxRetries?: number; maxIndexBytes?: number; maxObjectBytes?: number; sleep?: (ms: number) => Promise<void> }
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const transient = new Set([408, 429, 502, 503, 504]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

export class ArtifactoryHttpClient {
  private readonly root: URL;
  private readonly options: Required<Pick<ArtifactoryHttpClientOptions, 'maxRetries' | 'maxIndexBytes' | 'maxObjectBytes'>> & Pick<ArtifactoryHttpClientOptions, 'sleep'>;
  public constructor(private readonly http: HttpClient, private readonly credentials: HttpCredentialProvider, sourceRoot: string | URL, options: ArtifactoryHttpClientOptions = {}) {
    this.root = typeof sourceRoot === 'string' ? normalizeSourceRoot(sourceRoot) : normalizeSourceRoot(sourceRoot.toString());
    this.options = { maxRetries: options.maxRetries ?? 3, maxIndexBytes: options.maxIndexBytes ?? 5 * 1024 * 1024, maxObjectBytes: options.maxObjectBytes ?? 100 * 1024 * 1024, sleep: options.sleep };
  }

  public async getIndex(indexPath = 'index-v1.json', etag?: string): Promise<ConditionalJsonResult<unknown>> {
    const url = resolveConfinedObject(this.root, indexPath);
    const response = await this.request(url, 'application/json', etag, this.options.maxIndexBytes);
    if (response.statusCode === 304) {
      return { status: 'not-modified', etag, finalUrl: response.finalUrl };
    }
    try {
      return { status: 'fresh', value: JSON.parse(Buffer.from(response.body).toString('utf8')), etag: response.headers.etag, finalUrl: response.finalUrl };
    } catch (cause) {
      throw new RegistryError({ code: 'ARTIFACTORY.INDEX_INVALID', message: 'Artifactory index is not valid JSON.', cause });
    }
  }

  public async getText(object: PublishedObject): Promise<string> {
    return Buffer.from(await this.getBytes(object)).toString('utf8');
  }

  public async getBytes(object: PublishedObject): Promise<Uint8Array> {
    const url = resolveConfinedObject(this.root, object.path);
    return this.getBytesAt(url.href, object.mediaType);
  }

  /**
   * Fetch an already-resolved URL while retaining source-root confinement.
   * @param url
   * @param mediaType
   */
  public async getBytesAt(url: string, mediaType = '*/*'): Promise<Uint8Array> {
    const target = new URL(url);
    if (!isWithinSourceRoot(this.root, target)) {
      throw new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message: 'Artifactory URL is outside the source root.' });
    }
    const response = await this.request(target, mediaType, undefined, this.options.maxObjectBytes);
    return response.body;
  }

  public urlFor(path: string): string {
    return resolveConfinedObject(this.root, path).href;
  }

  private async fetchWithConfinedRedirects(url: URL, headers: Record<string, string>): Promise<HttpResponse> {
    let target = url;
    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await this.http.fetch({ url: target.href, headers, followRedirects: false });
      if (!isWithinSourceRoot(this.root, new URL(response.finalUrl))) {
        throw new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message: 'Artifactory response redirected outside the source root.' });
      }
      const location = response.headers.location;
      if (!redirectStatuses.has(response.statusCode) || !location) {
        return response;
      }
      let next: URL;
      try {
        next = new URL(location, target);
      } catch (cause) {
        throw new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message: 'Artifactory response redirected outside the source root.', cause });
      }
      if (!isWithinSourceRoot(this.root, next)) {
        throw new RegistryError({ code: 'ARTIFACTORY.PATH_ESCAPE', message: 'Artifactory response redirected outside the source root.' });
      }
      if (redirectCount >= MAX_REDIRECTS) {
        throw new RegistryError({ code: 'ARTIFACTORY.REQUEST_FAILED', message: `Maximum redirect count exceeded fetching ${url.href}` });
      }
      target = next;
    }
  }

  private async request(url: URL, accept: string, etag: string | undefined, maxBytes: number): Promise<HttpResponse> {
    const context: SourceRequestContext = { sourceId: this.root.href, trustedOrigin: this.root.origin, trustedPathPrefix: this.root.pathname };
    let headers: Record<string, string> = { Accept: accept, ...(await this.credentials.headersFor(url.href, context)) };
    if (etag) {
      headers = { ...headers, 'If-None-Match': etag };
    }
    for (let attempt = 0; ; attempt += 1) {
      let response: HttpResponse;
      try {
        response = await this.fetchWithConfinedRedirects(url, headers);
      } catch (cause) {
        if (cause instanceof RegistryError) {
          throw cause;
        }
        if (attempt < this.options.maxRetries) {
          await (this.options.sleep ?? wait)(Math.min(100 * 2 ** attempt, 2000)); continue;
        } throw new RegistryError({ code: 'ARTIFACTORY.TRANSIENT', message: 'Artifactory request failed.', cause });
      }
      if (response.statusCode >= 200 && response.statusCode < 300 || response.statusCode === 304) {
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new RegistryError({ code: 'ARTIFACTORY.INDEX_TOO_LARGE', message: 'Artifactory response exceeds the permitted size.' });
        }
        if (response.body.byteLength > maxBytes) {
          throw new RegistryError({ code: 'ARTIFACTORY.INDEX_TOO_LARGE', message: 'Artifactory response exceeds the permitted size.' });
        }
        return response;
      }
      if (transient.has(response.statusCode) && attempt < this.options.maxRetries) {
        const retry = Number(response.headers['retry-after']); await (this.options.sleep ?? wait)(Math.min(Number.isFinite(retry) ? retry * 1000 : 100 * 2 ** attempt, 2000)); continue;
      }
      const code = response.statusCode === 401 ? 'ARTIFACTORY.AUTHENTICATION_FAILED' : response.statusCode === 403 ? 'ARTIFACTORY.ACCESS_DENIED' : response.statusCode === 404 ? 'ARTIFACTORY.OBJECT_NOT_FOUND' : transient.has(response.statusCode) ? 'ARTIFACTORY.TRANSIENT' : 'ARTIFACTORY.REQUEST_FAILED';
      throw new RegistryError({ code, message: `Artifactory request failed with HTTP ${String(response.statusCode)}.` });
    }
  }
}
