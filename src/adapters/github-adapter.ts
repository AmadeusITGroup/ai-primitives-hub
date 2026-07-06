/**
 * GitHub repository adapter
 * Fetches bundles from GitHub repositories
 */

import {
  Bundle,
  SourceMetadata,
} from '../types/registry';
import {
  formatByteSize,
  generateGitHubBundleId,
} from '../utils/bundle-name-utils';
import {
  CONCURRENCY_CONSTANTS,
} from '../utils/constants';
import {
  GitHubBackedAdapter,
} from './github-backed-adapter';

/**
 * GitHub API response types
 */
interface GitHubRelease {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  tag_name: string;
  name: string;
  body: string;
  assets: {
    name: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
    browser_download_url: string;
    url: string; // API endpoint for downloading the asset
    size: number;
  }[];
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  published_at: string;
}

/**
 * GitHub repository adapter implementation
 */
export class GitHubAdapter extends GitHubBackedAdapter {
  public readonly type = 'github';

  /**
   * Cache for downloaded manifest content to avoid duplicate downloads.
   * Key is the asset URL, value is the parsed manifest object.
   */
  private readonly manifestCache: Map<string, any> = new Map();

  /**
   * Process a single release to create a Bundle object.
   * Downloads and parses the manifest, using cache to avoid duplicate downloads.
   * @param release - GitHub release object
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns Bundle object or null if processing fails
   */
  private async processSingleRelease(
    release: GitHubRelease,
    owner: string,
    repo: string
  ): Promise<Bundle | null> {
    const manifestAsset = release.assets.find((a) =>
      a.name === 'deployment-manifest.yml'
      || a.name === 'deployment-manifest.yaml'
      || a.name === 'deployment-manifest.json'
    );

    const bundleAsset = release.assets.find((a) =>
      a.name.endsWith('.zip')
      || a.name.endsWith('.tar.gz')
    );

    if (!manifestAsset || !bundleAsset) {
      return null;
    }

    // Fetch deployment manifest with caching
    let manifest: any = null;
    try {
      manifest = await this.fetchManifestWithCache(manifestAsset.url, manifestAsset.name);
    } catch (manifestError) {
      this.logger.warn(`Failed to fetch manifest for ${release.tag_name}: ${manifestError}`);
      // Continue without manifest data - use fallback values
    }

    // Locate the README release asset by the filename recorded in the manifest.
    // GitHub names each release asset after its file basename, and collections
    // can declare any README path, so we cannot guess a fixed filename.
    const readmeAsset = manifest?.readme
      ? release.assets.find((a) => a.name === manifest.readme)
      : undefined;

    // Create bundle metadata
    const bundleId = generateGitHubBundleId(
      owner,
      repo,
      release.tag_name,
      manifest?.id,
      manifest?.version
    );

    const bundle: Bundle = {
      id: bundleId,
      name: manifest?.name || release.name || `${repo} ${release.tag_name}`,
      version: manifest?.version || release.tag_name.replace(/^v/, ''),
      description: manifest?.description || this.extractDescription(release.body),
      author: manifest?.author || owner,
      sourceId: this.source.id,
      environments: manifest?.environments || this.extractEnvironments(release.body),
      tags: manifest?.tags || this.extractTags(release.body),
      lastUpdated: release.published_at,
      size: formatByteSize(bundleAsset.size),
      dependencies: manifest?.dependencies || [],
      license: manifest?.license || 'Unknown',
      manifestUrl: manifestAsset.url,
      downloadUrl: bundleAsset.url,
      repository: this.source.url,
      readmeUrl: readmeAsset ? readmeAsset.url : undefined,
      // Readme assets are scoped to a release, so the tag identifies the cached readme's revision
      readmeRevision: readmeAsset ? release.tag_name : undefined
    };

    // Attach prompts array from manifest for content breakdown display
    if (manifest?.prompts && Array.isArray(manifest.prompts)) {
      (bundle as any).prompts = manifest.prompts;
    }

    // Attach MCP servers from manifest for content breakdown display
    if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') {
      (bundle as any).mcpServers = manifest.mcpServers;
    }

    return bundle;
  }

  /**
   * Fetch and parse a manifest file with caching.
   * Avoids duplicate downloads of the same manifest URL.
   * @param url - Manifest asset URL
   * @param filename - Manifest filename (for determining parse format)
   * @returns Parsed manifest object
   */
  private async fetchManifestWithCache(url: string, filename: string): Promise<any> {
    // Check cache first
    if (this.manifestCache.has(url)) {
      this.logger.debug(`[GitHubAdapter] Using cached manifest for ${url}`);
      return this.manifestCache.get(url);
    }

    // Download and parse manifest
    const manifestContent = await this.getBuffer(url);
    const manifestText = manifestContent.toString('utf8');

    let manifest: any;
    if (filename.endsWith('.json')) {
      manifest = JSON.parse(manifestText);
    } else {
      // Assume YAML for .yml or .yaml
      const yaml = await import('js-yaml');
      manifest = yaml.default.load(manifestText);
    }

    // Cache the parsed manifest
    this.manifestCache.set(url, manifest);
    this.logger.debug(`[GitHubAdapter] Cached manifest for ${url}`);

    return manifest;
  }

  /**
   * Extract description from release body
   * @param body
   */
  private extractDescription(body: string): string {
    if (!body) {
      return '';
    }

    // Take first paragraph
    const lines = body.split('\n');
    const descLines = [];

    for (const line of lines) {
      if (line.trim() === '' && descLines.length > 0) {
        break;
      }
      if (line.trim()) {
        descLines.push(line.trim());
      }
    }

    return descLines.join(' ').substring(0, 200);
  }

  /**
   * Extract environments from release body
   * @param body
   */
  private extractEnvironments(body: string): string[] {
    const envs = [];
    const envRegex = /(?:environments?|platforms?):\s*([^\n]+)/i;
    const match = body?.match(envRegex);

    if (match) {
      const envString = match[1];
      envs.push(...envString.split(/[,\s]+/).filter((e) => e.trim()));
    }

    return envs.length > 0 ? envs : ['vscode']; // Default to vscode
  }

  /**
   * Extract tags from release body
   * @param body
   */
  private extractTags(body: string): string[] {
    const tags = [];
    const tagRegex = /(?:tags?):\s*([^\n]+)/i;
    const match = body?.match(tagRegex);

    if (match) {
      const tagString = match[1];
      tags.push(...tagString.split(/[,\s]+/).filter((t) => t.trim()));
    }

    return tags;
  }

  /**
   * Fetch bundles from GitHub releases
   * Scans all releases in the repository and creates Bundle objects for those
   * that contain both a deployment manifest and a bundle archive.
   *
   * Downloads manifests in parallel chunks (with caching); after each chunk the
   * optional callback receives a growing snapshot so the UI can render progressively.
   * @param onPartialBundles Optional callback invoked with a growing snapshot after each chunk
   * @returns Promise resolving to array of Bundle objects
   * @throws {Error} if GitHub API request fails or authentication issues occur
   */
  public async fetchBundles(
    onPartialBundles?: (bundles: Bundle[]) => void | Promise<void>
  ): Promise<Bundle[]> {
    const { owner, repo } = this.parseGitHubUrl();
    const url = `${this.apiBase}/repos/${owner}/${repo}/releases`;

    try {
      const releases = await this.getJson<GitHubRelease[]>(url);

      // Filter releases that have both manifest and bundle assets
      const validReleases = releases.filter((release) => {
        const hasManifest = release.assets.some((a) =>
          a.name === 'deployment-manifest.yml'
          || a.name === 'deployment-manifest.yaml'
          || a.name === 'deployment-manifest.json'
        );
        const hasBundle = release.assets.some((a) =>
          a.name.endsWith('.zip')
          || a.name.endsWith('.tar.gz')
        );
        return hasManifest && hasBundle;
      });

      return await this.processInChunks(
        validReleases,
        CONCURRENCY_CONSTANTS.MANIFEST_DOWNLOAD_CONCURRENCY,
        (release) => this.processSingleRelease(release, owner, repo),
        onPartialBundles
      );
    } catch (error) {
      throw new Error(`Failed to fetch bundles from GitHub: ${error}`);
    }
  }

  /**
   * Clear the manifest cache.
   * Should be called when sources are re-synced to ensure fresh data.
   */
  public clearManifestCache(): void {
    this.manifestCache.clear();
    this.logger.debug('[GitHubAdapter] Manifest cache cleared');
  }

  /**
   * Download a bundle from GitHub release assets
   * @param bundle - Bundle object containing downloadUrl
   * @returns Promise resolving to Buffer containing bundle ZIP file
   * @throws {Error} if download fails or network issues occur
   */
  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    try {
      return await this.getBuffer(bundle.downloadUrl);
    } catch (error) {
      throw new Error(`Failed to download bundle: ${error}`);
    }
  }

  /**
   * Download readme file from GitHub release assets
   * @param bundle - Bundle object containing readmeUrl
   * @returns Promise resolving to string content of README file
   * @throws {Error} if download fails or network issues occur
   */
  public async downloadReadme(bundle: Bundle): Promise<string | null> {
    if (!bundle.readmeUrl) {
      return null;
    }
    try {
      const data = await this.getBuffer(bundle.readmeUrl);
      return data.toString('utf8');
    } catch (error) {
      this.logger.warn(`Failed to download README for ${bundle.id}: ${error}`);
      return null;
    }
  }

  /**
   * Fetch repository metadata from GitHub API
   * Retrieves repository information including name, description, and release count.
   * @returns Promise resolving to SourceMetadata object
   * @throws {Error} if repository not found or API request fails
   */
  public async fetchMetadata(): Promise<SourceMetadata> {
    const { owner, repo } = this.parseGitHubUrl();
    const url = `${this.apiBase}/repos/${owner}/${repo}`;

    try {
      const repoData = await this.getJson<any>(url);
      const releasesUrl = `${this.apiBase}/repos/${owner}/${repo}/releases`;
      const releases = await this.getJson<GitHubRelease[]>(releasesUrl);

      return {
        name: repoData.name,
        description: repoData.description || '',
        bundleCount: releases.length,
        lastUpdated: repoData.updated_at,
        version: '1.0.0' // Could extract from latest release
      };
    } catch (error) {
      throw new Error(`Failed to fetch GitHub metadata: ${error}`);
    }
  }

  /**
   * Get manifest URL for a bundle
   * Constructs the GitHub release asset URL for the deployment manifest.
   * @param bundleId - Bundle identifier (not used, URL based on repo)
   * @param version - Optional version tag (defaults to 'latest')
   * @returns URL string pointing to deployment-manifest.json in release assets
   */
  public getManifestUrl(bundleId: string, version?: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    const tag = version ? `v${version}` : 'latest';
    return `https://github.com/${owner}/${repo}/releases/download/${tag}/deployment-manifest.json`;
  }

  /**
   * Get download URL for a bundle
   * Constructs the GitHub release asset URL for the bundle ZIP file.
   * @param bundleId - Bundle identifier (not used, URL based on repo)
   * @param version - Optional version tag (defaults to 'latest')
   * @returns URL string pointing to bundle.zip in release assets
   */
  public getDownloadUrl(bundleId: string, version?: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    const tag = version ? `v${version}` : 'latest';
    return `https://github.com/${owner}/${repo}/releases/download/${tag}/bundle.zip`;
  }
}
