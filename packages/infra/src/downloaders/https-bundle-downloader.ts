/**
 * HttpsBundleDownloader — `BundleDownloader` port implementation.
 *
 * Downloads bundle bytes over HTTP(S) via the injected `HttpClient`,
 * attaching a bearer token (from `TokenProvider`, keyed by the download
 * URL's hostname and optional originating repository target) when one is
 * available — release assets on private repositories need it, public ones
 * may omit it. When `Installable`
 * already carries `inlineBytes` (synthesized bundles — awesome-copilot,
 * skills), the network call is skipped entirely and the digest is
 * computed directly over those bytes.
 * @module downloaders/https-bundle-downloader
 */
import {
  createHash,
} from 'node:crypto';
import type {
  BundleDownloader,
  DownloadResult,
  GitHubRepositoryTarget,
  GitHubSourceAuthCategory,
  HttpClient,
  Installable,
  TokenProvider,
} from '@ai-primitives-hub/core';

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export class HttpsBundleDownloader implements BundleDownloader {
  public constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenProvider,
    private readonly repositoryTarget?: GitHubRepositoryTarget,
    private readonly authenticationCategory?: GitHubSourceAuthCategory
  ) {}

  public async download(installable: Installable): Promise<DownloadResult> {
    if (installable.inlineBytes !== undefined) {
      return {
        bytes: installable.inlineBytes,
        sha256: sha256Hex(installable.inlineBytes)
      };
    }

    const host = new URL(installable.downloadUrl).hostname;
    const headers: Record<string, string> = { Accept: 'application/octet-stream' };
    if (this.authenticationCategory !== 'public-anonymous') {
      const token = await this.tokens.getToken(host, this.repositoryTarget);
      if (token === undefined && this.authenticationCategory === 'public-generic') {
        throw authenticationRequiredError(
          'GH_PUBLIC_GENERIC_TOKEN_UNAVAILABLE',
          'A generic GitHub token is required for public source downloads.'
        );
      }
      if (token === undefined && this.authenticationCategory === 'app-authenticated') {
        throw authenticationRequiredError(
          'GH_APP_AUTH_TOKEN_UNAVAILABLE',
          'A repository-scoped GitHub App token is required for source downloads.'
        );
      }
      if (token !== undefined) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const response = await this.http.fetch({ url: installable.downloadUrl, headers });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Failed to download bundle: HTTP ${String(response.statusCode)} from ${installable.downloadUrl}`);
    }

    return {
      bytes: response.body,
      sha256: sha256Hex(response.body)
    };
  }
}

function authenticationRequiredError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
