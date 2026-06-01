/**
 * GitHub repository adapter
 * Fetches bundles from GitHub repositories using GitHubClient
 */

import {
  GitHubClient,
  GitHubRelease,
} from '../services/github-client';
import {
  GitHubAuthError,
  GitHubClientError,
  GitHubNotFoundError,
} from '../services/github-client-errors';
import {
  Bundle,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '../types/registry';
import {
  CONCURRENCY_CONSTANTS,
} from '../utils/constants';
import {
  Logger,
} from '../utils/logger';
import {
  hasValidBundleAssets,
  mapReleaseToBundle,
} from './helpers/release-mapper';
import {
  RepositoryAdapter,
} from './repository-adapter';

/**
 * GitHub repository adapter implementation
 */
export class GitHubAdapter extends RepositoryAdapter {
  public readonly type = 'github';
  private readonly client: GitHubClient;
  private readonly logger: Logger;
  private readonly manifestCache: Map<string, any> = new Map();

  constructor(source: RegistrySource, client?: GitHubClient) {
    super(source);
    this.logger = Logger.getInstance();
    this.client = client ?? new GitHubClient({ sourceUrl: source.url, explicitToken: source.token });
  }

  private async processSingleRelease(release: GitHubRelease): Promise<Bundle | null> {
    const manifestAsset = release.assets.find((a) =>
      a.name === 'deployment-manifest.yml'
      || a.name === 'deployment-manifest.yaml'
      || a.name === 'deployment-manifest.json'
    );

    if (!manifestAsset) {
      return null;
    }

    let manifest: any = null;
    try {
      manifest = await this.fetchManifestWithCache(manifestAsset.url, manifestAsset.name);
    } catch (manifestError) {
      this.logger.warn(`Failed to fetch manifest for ${release.tag_name}: ${manifestError}`);
    }

    return mapReleaseToBundle(
      release,
      manifest,
      this.client.owner,
      this.client.repo,
      this.source.id,
      this.source.url
    );
  }

  private async fetchManifestWithCache(url: string, filename: string): Promise<any> {
    if (this.manifestCache.has(url)) {
      return this.manifestCache.get(url);
    }

    const content = await this.client.downloadAsset(url);
    const text = content.toString('utf8');

    let manifest: any;
    if (filename.endsWith('.json')) {
      manifest = JSON.parse(text);
    } else {
      const yaml = await import('js-yaml');
      manifest = yaml.default.load(text);
    }

    this.manifestCache.set(url, manifest);
    return manifest;
  }

  private wrapErrorMessage(error: unknown): string {
    if (error instanceof GitHubNotFoundError) {
      return `GitHub API error: 404 Not Found - Repository not found or not accessible. Check authentication.`;
    }
    if (error instanceof GitHubAuthError) {
      const code = error.statusCode ?? 401;
      if (code === 403) {
        return `GitHub API error: 403 Forbidden - Access forbidden. Token may lack required scopes (repo).`;
      }
      return `GitHub API error: 401 Unauthorized - Authentication failed. Token may be invalid or expired.`;
    }
    if (error instanceof GitHubClientError) {
      return error.message;
    }
    return String(error);
  }

  public async fetchBundles(): Promise<Bundle[]> {
    try {
      const releases = await this.client.listReleases();
      const validReleases = releases.filter((release) => hasValidBundleAssets(release));

      const concurrency = CONCURRENCY_CONSTANTS.MANIFEST_DOWNLOAD_CONCURRENCY;
      const bundles: Bundle[] = [];

      for (let i = 0; i < validReleases.length; i += concurrency) {
        const batch = validReleases.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
          batch.map((release) => this.processSingleRelease(release))
        );
        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value) {
            bundles.push(result.value);
          }
        }
      }

      return bundles;
    } catch (error) {
      throw new Error(`Failed to fetch bundles from GitHub: ${this.wrapErrorMessage(error)}`);
    }
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    try {
      return await this.client.downloadAsset(bundle.downloadUrl);
    } catch (error) {
      throw new Error(`Failed to download bundle: ${this.wrapErrorMessage(error)}`);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const repoData = await this.client.getRepository();
      const releases = await this.client.listReleases();

      return {
        name: repoData.name,
        description: repoData.description || '',
        bundleCount: releases.length,
        lastUpdated: repoData.updatedAt,
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch GitHub metadata: ${this.wrapErrorMessage(error)}`);
    }
  }

  public async validate(): Promise<ValidationResult> {
    try {
      await this.client.getRepository();
      const releases = await this.client.listReleases();

      return {
        valid: true,
        errors: [],
        warnings: releases.length === 0 ? ['No releases found in repository'] : [],
        bundlesFound: releases.length
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`GitHub validation failed: ${this.wrapErrorMessage(error)}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  public getManifestUrl(bundleId: string, version?: string): string {
    const tag = version ? `v${version}` : 'latest';
    return `https://github.com/${this.client.owner}/${this.client.repo}/releases/download/${tag}/deployment-manifest.json`;
  }

  public getDownloadUrl(bundleId: string, version?: string): string {
    const tag = version ? `v${version}` : 'latest';
    return `https://github.com/${this.client.owner}/${this.client.repo}/releases/download/${tag}/bundle.zip`;
  }

  public clearManifestCache(): void {
    this.manifestCache.clear();
    this.logger.debug('[GitHubAdapter] Manifest cache cleared');
  }
}
