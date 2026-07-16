/**
 * GitHub source adapter — fetches bundles from a repository's GitHub
 * Releases.
 *
 * Ported from `src/adapters/github-adapter.ts`. The biggest structural
 * change: all raw HTTP (redirects, auth headers, error parsing) moves to
 * an injected `GitHubApi` (backed by `GitHubApiClient` + `NodeHttpClient`
 * in production), so this class only ever deals with GitHub's REST API
 * shapes. See `http/github-api-client.ts`'s module doc for the two
 * behaviors deliberately not ported (HTML-error scraping, multi-strategy
 * auth retry) and why.
 *
 * Ported, deliberately unchanged in shape from `main`: the ad hoc
 * `(bundle as any).prompts`/`.mcpServers` attachment the Marketplace
 * webview's content-breakdown UI reads (`ui/marketplace-view-provider.ts`'s
 * `getContentBreakdown`). Neither field is part of `Bundle`'s real type
 * (see `src/types/registry.ts`'s `DeploymentManifest`, not `Bundle`) — kept
 * as the same ad hoc cast rather than promoted to a real `Bundle` field,
 * to land this as a pure behavior-parity fix, not a type-system change.
 * @module adapters/github-adapter
 */
import type {
  Bundle,
  GitHubApi,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '@ai-primitives-hub/core';
import {
  generateGitHubReleaseBundleId,
} from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import {
  BaseSourceAdapter,
} from './base-source-adapter';

/**
 * Manifest downloads are fetched in parallel, this many at a time, to
 * bound concurrent outbound requests. Mirrors
 * `CONCURRENCY_CONSTANTS.MANIFEST_DOWNLOAD_CONCURRENCY` from
 * `src/utils/constants.ts` (GitHub's authenticated rate limit is 5000
 * requests/hour, so this is about throughput, not staying under it).
 */
const MANIFEST_DOWNLOAD_CONCURRENCY = 10;

interface GitHubReleaseAsset {
  name: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  browser_download_url: string;
  /** API endpoint for downloading the asset (requires Accept: application/octet-stream). */
  url: string;
  size: number;
}

interface GitHubRelease {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  tag_name: string;
  name: string;
  body: string;
  assets: GitHubReleaseAsset[];
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  published_at: string;
}

interface GitHubRepo {
  name: string;
  description: string | null;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  updated_at: string;
}

interface DeploymentManifest {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  environments?: string[];
  tags?: string[];
  dependencies?: Bundle['dependencies'];
  license?: string;
  /** Read only for the Marketplace webview's content-breakdown UI - see this module's own doc. */
  prompts?: unknown[];
  /** Read only for the Marketplace webview's content-breakdown UI - see this module's own doc. */
  mcpServers?: Record<string, unknown>;
}

function isManifestAssetName(name: string): boolean {
  return name === 'deployment-manifest.yml' || name === 'deployment-manifest.yaml' || name === 'deployment-manifest.json';
}

function isBundleAssetName(name: string): boolean {
  return name.endsWith('.zip') || name.endsWith('.tar.gz');
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * First non-empty paragraph of a release body, truncated for use as a description.
 * @param body - Release body (markdown).
 */
function extractDescription(body: string): string {
  if (!body) {
    return '';
  }
  const descLines: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '' && descLines.length > 0) {
      break;
    }
    if (line.trim()) {
      descLines.push(line.trim());
    }
  }
  return descLines.join(' ').substring(0, 200);
}

function extractListField(body: string, fieldPattern: RegExp): string[] {
  const match = body?.match(fieldPattern);
  if (!match) {
    return [];
  }
  return match[1].split(/[,\s]+/).filter((value) => value.trim());
}

const ENVIRONMENTS_PATTERN = /(?:environments?|platforms?):\s*([^\n]+)/i;
const TAGS_PATTERN = /(?:tags?):\s*([^\n]+)/i;

/**
 * Unlike tags, environments fall back to `['vscode']` when the release body declares none.
 * @param body - Release body (markdown).
 */
function extractEnvironments(body: string): string[] {
  const environments = extractListField(body, ENVIRONMENTS_PATTERN);
  return environments.length > 0 ? environments : ['vscode'];
}

function extractTags(body: string): string[] {
  return extractListField(body, TAGS_PATTERN);
}

export class GitHubAdapter extends BaseSourceAdapter {
  public readonly type = 'github';

  private readonly manifestCache = new Map<string, DeploymentManifest>();

  public constructor(
    source: RegistrySource,
    private readonly githubApi: GitHubApi
  ) {
    super(source);
    if (!GitHubAdapter.isValidGitHubUrl(source.url)) {
      throw new Error(`Invalid GitHub URL: ${source.url}`);
    }
  }

  private static isValidGitHubUrl(url: string): boolean {
    if (url.startsWith('https://')) {
      return url.includes('github.com');
    }
    if (url.startsWith('git@')) {
      return url.includes('github.com:');
    }
    return false;
  }

  private parseGitHubUrl(): { owner: string; repo: string } {
    const url = this.source.url.replace(/\.git$/, '');
    const match = /github\.com[/:]([^/]+)\/([^/]+)/.exec(url);
    if (!match) {
      throw new Error(`Invalid GitHub URL format: ${this.source.url}`);
    }
    return { owner: match[1], repo: match[2] };
  }

  private async fetchManifestWithCache(asset: GitHubReleaseAsset): Promise<DeploymentManifest | undefined> {
    const cached = this.manifestCache.get(asset.url);
    if (cached) {
      return cached;
    }
    const text = await this.githubApi.getText(asset.url);
    const manifest = (asset.name.endsWith('.json') ? JSON.parse(text) : yaml.load(text)) as DeploymentManifest;
    this.manifestCache.set(asset.url, manifest);
    return manifest;
  }

  private async processRelease(release: GitHubRelease, owner: string, repo: string): Promise<Bundle | undefined> {
    const manifestAsset = release.assets.find((asset) => isManifestAssetName(asset.name));
    const bundleAsset = release.assets.find((asset) => isBundleAssetName(asset.name));
    if (!manifestAsset || !bundleAsset) {
      return undefined;
    }

    let manifest: DeploymentManifest | undefined;
    try {
      manifest = await this.fetchManifestWithCache(manifestAsset);
    } catch {
      // Continue without manifest data - the release still counts as a
      // bundle, just with fallback metadata derived from the release itself.
    }

    const bundleId = generateGitHubReleaseBundleId(owner, repo, release.tag_name, manifest?.id, manifest?.version);

    const bundle: Bundle = {
      id: bundleId,
      name: manifest?.name ?? release.name ?? `${repo} ${release.tag_name}`,
      version: manifest?.version ?? release.tag_name.replace(/^v/, ''),
      description: manifest?.description ?? extractDescription(release.body),
      author: manifest?.author ?? owner,
      sourceId: this.source.id,
      environments: manifest?.environments ?? extractEnvironments(release.body),
      tags: manifest?.tags ?? extractTags(release.body),
      lastUpdated: release.published_at,
      size: formatByteSize(bundleAsset.size),
      dependencies: manifest?.dependencies ?? [],
      license: manifest?.license ?? 'Unknown',
      manifestUrl: manifestAsset.url,
      downloadUrl: bundleAsset.url,
      repository: this.source.url
    };

    // Attach prompts/mcpServers from the manifest for the Marketplace
    // webview's content-breakdown UI. Not part of `Bundle`'s real type -
    // see this module's own doc.
    if (manifest?.prompts && Array.isArray(manifest.prompts)) {
      (bundle as Bundle & { prompts?: unknown }).prompts = manifest.prompts;
    }
    if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') {
      (bundle as Bundle & { mcpServers?: unknown }).mcpServers = manifest.mcpServers;
    }

    return bundle;
  }

  public async fetchBundles(): Promise<Bundle[]> {
    const { owner, repo } = this.parseGitHubUrl();

    let releases: GitHubRelease[];
    try {
      releases = await this.githubApi.getJson<GitHubRelease[]>(`/repos/${owner}/${repo}/releases`);
    } catch (error) {
      throw new Error(`Failed to fetch bundles from GitHub: ${error instanceof Error ? error.message : error}`);
    }

    const validReleases = releases.filter(
      (release) => release.assets.some((asset) => isManifestAssetName(asset.name))
        && release.assets.some((asset) => isBundleAssetName(asset.name))
    );

    const bundles: Bundle[] = [];
    for (let i = 0; i < validReleases.length; i += MANIFEST_DOWNLOAD_CONCURRENCY) {
      const batch = validReleases.slice(i, i + MANIFEST_DOWNLOAD_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((release) => this.processRelease(release, owner, repo)));
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          bundles.push(result.value);
        }
      }
    }
    return bundles;
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    try {
      const bytes = await this.githubApi.download(bundle.downloadUrl);
      return Buffer.from(bytes);
    } catch (error) {
      throw new Error(`Failed to download bundle: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    const { owner, repo } = this.parseGitHubUrl();
    try {
      const repoData = await this.githubApi.getJson<GitHubRepo>(`/repos/${owner}/${repo}`);
      const releases = await this.githubApi.getJson<GitHubRelease[]>(`/repos/${owner}/${repo}/releases`);
      return {
        name: repoData.name,
        description: repoData.description ?? '',
        bundleCount: releases.length,
        lastUpdated: repoData.updated_at,
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch GitHub metadata: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async validate(): Promise<ValidationResult> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      await this.githubApi.getJson(`/repos/${owner}/${repo}`);
      const releases = await this.githubApi.getJson<GitHubRelease[]>(`/repos/${owner}/${repo}/releases`);
      return {
        valid: true,
        errors: [],
        warnings: releases.length === 0 ? ['No releases found in repository'] : [],
        bundlesFound: releases.length
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`GitHub validation failed: ${error instanceof Error ? error.message : error}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  public getManifestUrl(_bundleId: string, version?: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    const tag = version ? `v${version}` : 'latest';
    return `https://github.com/${owner}/${repo}/releases/download/${tag}/deployment-manifest.json`;
  }

  public getDownloadUrl(_bundleId: string, version?: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    const tag = version ? `v${version}` : 'latest';
    return `https://github.com/${owner}/${repo}/releases/download/${tag}/bundle.zip`;
  }

  /**
   * Clear the manifest cache. Called by consumers (e.g. a manual,
   * user-initiated source re-sync) that need to guarantee fresh data
   * rather than whatever was cached from an earlier `fetchBundles` call.
   */
  public clearManifestCache(): void {
    this.manifestCache.clear();
  }
}
