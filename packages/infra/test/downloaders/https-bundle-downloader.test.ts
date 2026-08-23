import type {
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HttpClient,
  HttpRequest,
  HttpResponse,
  Installable,
  TokenProvider,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  HttpsBundleDownloader,
} from '../../src/downloaders/https-bundle-downloader';

class RecordingHttpClient implements HttpClient {
  public request: HttpRequest | undefined;

  public async fetch(request: HttpRequest): Promise<HttpResponse> {
    this.request = request;
    return {
      statusCode: 200,
      body: new Uint8Array([1, 2, 3]),
      finalUrl: request.url,
      headers: {}
    };
  }
}

class RecordingTokenProvider implements TokenProvider {
  public host: string | undefined;
  public target: GitHubRepositoryTarget | undefined;

  public async getToken(host: string, target?: GitHubRepositoryTarget): Promise<string | undefined> {
    this.host = host;
    this.target = target;
    return 'token';
  }
}

class EmptyTokenProvider implements TokenProvider {
  public async getToken(): Promise<string | undefined> {
    return undefined;
  }
}

describe('HttpsBundleDownloader', () => {
  it('passes the source repository target for release asset downloads', async () => {
    const http = new RecordingHttpClient();
    const tokens = new RecordingTokenProvider();
    const target: GitHubRepositoryTarget = {
      host: 'github.com',
      owner: 'owner',
      repository: 'repo'
    };
    const downloader = new HttpsBundleDownloader(http, tokens, target);

    await downloader.download({
      downloadUrl: 'https://api.github.com/repos/owner/repo/releases/assets/1'
    } as Installable);

    expect(tokens.host).toBe('api.github.com');
    expect(tokens.target).toEqual(target);
    expect(http.request?.headers?.Authorization).toBe('Bearer token');
  });

  it('does not invoke credentials for a public-anonymous download', async () => {
    const http = new RecordingHttpClient();
    const tokens = new RecordingTokenProvider();
    const category: GitHubSourceAuthCategory = 'public-anonymous';
    const downloader = new HttpsBundleDownloader(http, tokens, undefined, category);

    await downloader.download({
      downloadUrl: 'https://github.com/owner/repo/archive.zip'
    } as Installable);

    expect(tokens.host).toBeUndefined();
    expect(http.request?.headers?.Authorization).toBeUndefined();
  });

  it('does not make an anonymous request for a public-generic download when its token is unavailable', async () => {
    const http = new RecordingHttpClient();
    const downloader = new HttpsBundleDownloader(http, new EmptyTokenProvider(), undefined, 'public-generic');

    await expect(downloader.download({
      downloadUrl: 'https://github.com/owner/repo/archive.zip'
    } as Installable)).rejects.toMatchObject({ code: 'GH_PUBLIC_GENERIC_TOKEN_UNAVAILABLE' });
    expect(http.request).toBeUndefined();
  });
});
