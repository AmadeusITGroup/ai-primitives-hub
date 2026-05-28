/**
 * GitHub repository adapter
 * Fetches bundles from GitHub repositories
 */

import {
  exec,
} from 'node:child_process';
import * as https from 'node:https';
import {
  promisify,
} from 'node:util';
import * as vscode from 'vscode';
import {
  Bundle,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '../types/registry';
import {
  formatByteSize,
  generateGitHubBundleId,
} from '../utils/bundle-name-utils';
import {
  CONCURRENCY_CONSTANTS,
} from '../utils/constants';
import {
  Logger,
} from '../utils/logger';
import {
  RepositoryAdapter,
} from './repository-adapter';

const execAsync = promisify(exec);

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
export class GitHubAdapter extends RepositoryAdapter {
  public readonly type = 'github';
  private readonly apiBase = 'https://api.github.com';
  private authToken: string | undefined;
  private authMethod: 'vscode' | 'gh-cli' | 'explicit' | 'none' = 'none';
  private readonly logger: Logger;
  private readonly attemptedMethods: Set<string> = new Set();
  /**
   * Maximum authentication attempts to prevent infinite retry loops.
   * Tries: explicit token → VS Code auth → gh CLI
   */
  private readonly maxAuthAttempts = 3;
  /**
   * Promise for ongoing authentication attempt to prevent race conditions.
   * Multiple parallel requests will wait for the same authentication promise.
   */
  private authPromise?: Promise<string | undefined>;

  /**
   * Cache for downloaded manifest content to avoid duplicate downloads.
   * Key is the asset URL, value is the parsed manifest object.
   */
  private readonly manifestCache: Map<string, any> = new Map();

  constructor(source: RegistrySource) {
    super(source);
    this.logger = Logger.getInstance();

    if (!this.isValidGitHubUrl(source.url)) {
      throw new Error(`Invalid GitHub URL: ${source.url}`);
    }
  }

  /**
   * Validate GitHub URL (supports both HTTPS and SSH formats)
   * @param url
   */
  private isValidGitHubUrl(url: string): boolean {
    // HTTPS format: https://github.com/owner/repo
    if (url.startsWith('https://')) {
      return url.includes('github.com');
    }
    // SSH format: git@github.com:owner/repo.git
    if (url.startsWith('git@')) {
      return url.includes('github.com:');
    }
    return false;
  }

  /**
   * Parse GitHub URL to extract owner and repo
   */
  private parseGitHubUrl(): { owner: string; repo: string } {
    const url = this.source.url.replace(/\.git$/, '');
    const match = url.match(/github\.com[/:]([^/]+)\/([^/]+)/);

    if (!match) {
      throw new Error(`Invalid GitHub URL format: ${this.source.url}`);
    }

    return {
      owner: match[1],
      repo: match[2]
    };
  }

  /**
   * Get authentication token using fallback chain:
   * 1. Explicit token from source configuration
   * 2. VSCode GitHub API (if user is logged in)
   * 3. gh CLI (if installed and authenticated)
   * 4. No authentication
   *
   * Uses promise memoization to prevent race conditions when multiple
   * parallel requests attempt authentication simultaneously.
   */
  private async getAuthenticationToken(): Promise<string | undefined> {
    // Return cached token if already resolved
    if (this.authToken !== undefined) {
      this.logger.debug(`[GitHubAdapter] Using cached token (method: ${this.authMethod})`);
      return this.authToken;
    }

    // If authentication is already in progress, wait for it
    if (this.authPromise) {
      this.logger.debug('[GitHubAdapter] Authentication in progress, waiting...');
      return this.authPromise;
    }

    // Check if we've exceeded max attempts
    if (this.attemptedMethods.size >= this.maxAuthAttempts) {
      this.logger.error(`[GitHubAdapter] Maximum authentication attempts (${this.maxAuthAttempts}) exceeded`);
      this.logger.error(`[GitHubAdapter] Attempted methods: ${Array.from(this.attemptedMethods).join(', ')}`);
      return undefined;
    }

    // Start new authentication attempt and cache the promise
    this.authPromise = this.performAuthentication();

    try {
      const token = await this.authPromise;
      this.authToken = token;
      return token;
    } finally {
      // Clear the promise once authentication completes (success or failure)
      this.authPromise = undefined;
    }
  }

  /**
   * Perform the actual authentication attempt through the fallback chain.
   * This is separated from getAuthenticationToken to enable promise memoization.
   */
  private async performAuthentication(): Promise<string | undefined> {
    this.logger.info('[GitHubAdapter] Attempting authentication...');

    // Try explicit token from source configuration first
    if (this.attemptedMethods.has('explicit')) {
      this.logger.debug('[GitHubAdapter] Skipping explicit token (already attempted)');
    } else {
      const explicitToken = this.getAuthToken();
      if (explicitToken && explicitToken.trim().length > 0) {
        this.authMethod = 'explicit';
        this.logger.info('[GitHubAdapter] ✓ Using explicit token from configuration');
        const token = explicitToken.trim();
        this.logger.debug(`[GitHubAdapter] Token preview: ${token.substring(0, 8)}...`);
        return token;
      }
      this.logger.debug('[GitHubAdapter] No explicit token configured');
    }

    // Try VSCode GitHub authentication second
    if (this.attemptedMethods.has('vscode')) {
      this.logger.debug('[GitHubAdapter] Skipping VSCode auth (already attempted)');
    } else {
      try {
        this.logger.debug('[GitHubAdapter] Trying VSCode GitHub authentication...');
        const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
        if (session) {
          this.authMethod = 'vscode';
          this.logger.info('[GitHubAdapter] ✓ Using VSCode GitHub authentication');
          this.logger.debug(`[GitHubAdapter] Token preview: ${session.accessToken.substring(0, 8)}...`);
          return session.accessToken;
        }
        this.logger.debug('[GitHubAdapter] VSCode auth session not found');
      } catch (error) {
        this.logger.warn(`[GitHubAdapter] VSCode auth failed: ${error}`);
      }
    }

    // Try gh CLI authentication third
    if (this.attemptedMethods.has('gh-cli')) {
      this.logger.debug('[GitHubAdapter] Skipping gh CLI (already attempted)');
    } else {
      try {
        this.logger.debug('[GitHubAdapter] Trying gh CLI authentication...');
        const { stdout } = await execAsync('gh auth token');
        const token = stdout.trim();
        if (token && token.length > 0) {
          this.authMethod = 'gh-cli';
          this.logger.info('[GitHubAdapter] ✓ Using gh CLI authentication');
          this.logger.debug(`[GitHubAdapter] Token preview: ${token.substring(0, 8)}...`);
          return token;
        }
        this.logger.debug('[GitHubAdapter] gh CLI returned empty token');
      } catch (error) {
        this.logger.warn(`[GitHubAdapter] gh CLI auth failed: ${error}`);
      }
    }

    // No authentication available
    this.authMethod = 'none';
    if (this.attemptedMethods.size > 0) {
      this.logger.error('[GitHubAdapter] ✗ All authentication methods exhausted');
      this.logger.error(`[GitHubAdapter] Attempted methods: ${Array.from(this.attemptedMethods).join(', ')}`);
    } else {
      this.logger.warn('[GitHubAdapter] ✗ No authentication available - API rate limits will apply and private repos will be inaccessible');
    }
    return undefined;
  }

  /**
   * Validate response Content-Type and detect HTML error pages
   * @param res
   * @param data
   */
  private validateResponse(res: any, data: string): { isValid: boolean; error?: string } {
    const contentType = res.headers['content-type'] || '';

    // Check if response is HTML (common for authentication errors)
    if (contentType.includes('text/html')) {
      this.logger.warn(`[GitHubAdapter] Received HTML response instead of JSON (Content-Type: ${contentType})`);

      // Try to extract error information from HTML
      let htmlError = 'HTML error page received';

      // Simple HTML parsing to extract text content
      const bodyMatch = data.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) {
        // Remove HTML tags and get text content
        const bodyText = bodyMatch[1]
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (bodyText.length > 0) {
          htmlError = bodyText.substring(0, 200);
        }
      }

      return {
        isValid: false,
        error: `Received HTML error page instead of JSON response. This typically indicates an authentication or access issue. Error: ${htmlError}`
      };
    }

    // Check if response is JSON
    if (!contentType.includes('application/json') && !contentType.includes('application/octet-stream')) {
      this.logger.warn(`[GitHubAdapter] Unexpected Content-Type: ${contentType}`);
      return {
        isValid: false,
        error: `Unexpected Content-Type: ${contentType}. Expected application/json.`
      };
    }

    return { isValid: true };
  }

  /**
   * Make HTTP request to GitHub API with authentication and automatic retry on auth failures
   * Handles redirects (301/302) by following the Location header
   * @param url
   * @param retryCount
   * @param redirectDepth
   */
  private async makeRequest(url: string, retryCount = 0, redirectDepth = 0): Promise<any> {
    /**
     * Maximum redirect depth to prevent infinite loops.
     */
    const MAX_REDIRECTS = 10;
    if (redirectDepth >= MAX_REDIRECTS) {
      this.logger.error(`[GitHubAdapter] Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
      throw new Error(`Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
    }

    const headers = this.getHeaders();

    // Get authentication token using fallback chain
    const token = await this.getAuthenticationToken();
    if (token) {
      // Use token format for GitHub API
      headers.Authorization = `token ${token}`;
      this.logger.debug(`[GitHubAdapter] Request to ${url} with auth (method: ${this.authMethod})`);
    } else {
      this.logger.debug(`[GitHubAdapter] Request to ${url} WITHOUT auth`);
    }

    // Log headers (sanitized)
    const sanitizedHeaders = { ...headers };
    if (sanitizedHeaders.Authorization) {
      sanitizedHeaders.Authorization = sanitizedHeaders.Authorization.substring(0, 15) + '...';
    }
    this.logger.debug(`[GitHubAdapter] Request headers: ${JSON.stringify(sanitizedHeaders)}`);

    return new Promise((resolve, reject) => {
      https.get(url, { headers }, (res) => {
        // Handle redirects (301/302)
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.logger.debug(`[GitHubAdapter] Following redirect (depth ${redirectDepth + 1}) to: ${redirectUrl}`);
            this.makeRequest(redirectUrl, retryCount, redirectDepth + 1).then(resolve).catch(reject);
            return;
          }
        }

        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', async () => {
          if (res.statusCode && res.statusCode >= 400) {
            this.logger.error(`[GitHubAdapter] HTTP ${res.statusCode}: ${res.statusMessage}`);
            this.logger.error(`[GitHubAdapter] URL: ${url}`);
            this.logger.error(`[GitHubAdapter] Auth method: ${this.authMethod}`);
            this.logger.error(`[GitHubAdapter] Response: ${data.substring(0, 500)}`);

            // Validate response format before processing error

            const { isValid, error } = this.validateResponse(res, data);
            if (!isValid) {
              this.logger.error(`[GitHubAdapter] ${error}`);
            }

            // Check if this is an authentication error that should trigger retry
            const isAuthError = res.statusCode === 401 || res.statusCode === 403;
            const canRetry = retryCount < this.maxAuthAttempts && this.attemptedMethods.size < this.maxAuthAttempts;

            if (isAuthError && canRetry) {
              // Invalidate cache and retry with next auth method
              const reason = `${res.statusCode} ${res.statusMessage}`;
              this.logger.warn(`[GitHubAdapter] Authentication error detected, invalidating cache and retrying...`);
              this.invalidateAuthCache(reason);

              try {
                // Retry the request with next authentication method
                const result = await this.makeRequest(url, retryCount + 1);
                resolve(result);
                return;
              } catch (retryError) {
                // If retry also fails, fall through to error handling below
                this.logger.error(`[GitHubAdapter] Retry failed: ${retryError}`);
              }
            }

            // Provide helpful error messages
            let errorMsg = `GitHub API error: ${res.statusCode} ${res.statusMessage}`;

            // Include HTML error information if present
            if (!isValid && error) {
              errorMsg = error;
            } else {
              switch (res.statusCode) {
                case 404: {
                  errorMsg += ' - Repository not found or not accessible. Check authentication.';

                  break;
                }
                case 401: {
                  errorMsg += ' - Authentication failed. Token may be invalid or expired.';
                  if (this.attemptedMethods.size > 0) {
                    errorMsg += ` Attempted methods: ${Array.from(this.attemptedMethods).join(', ')}`;
                  }

                  break;
                }
                case 403: {
                  errorMsg += ' - Access forbidden. Token may lack required scopes (repo).';
                  if (this.attemptedMethods.size > 0) {
                    errorMsg += ` Attempted methods: ${Array.from(this.attemptedMethods).join(', ')}`;
                  }

                  break;
                }
 // No default
              }
            }
            reject(new Error(errorMsg));
            return;
          }

          // Validate response format for successful responses
          const validation = this.validateResponse(res, data);
          if (!validation.isValid) {
            this.logger.error(`[GitHubAdapter] ${validation.error}`);
            reject(new Error(validation.error));
            return;
          }

          this.logger.debug(`[GitHubAdapter] Response OK (${res.statusCode})`);
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            this.logger.error(`[GitHubAdapter] Failed to parse response: ${error}`);
            this.logger.error(`[GitHubAdapter] Response preview: ${data.substring(0, 200)}`);
            reject(new Error(`Failed to parse GitHub response as JSON: ${error}`));
          }
        });
      }).on('error', (error) => {
        this.logger.error(`[GitHubAdapter] Network error: ${error.message}`);
        reject(new Error(`GitHub API request failed: ${error.message}`));
      });
    });
  }

  /**
   * Download file from URL with authentication
   * Handles redirects recursively with depth tracking and selective auth preservation
   * @param url
   * @param redirectDepth
   */
  private async downloadFile(url: string, redirectDepth = 0): Promise<Buffer> {
    /**
     * Maximum redirect depth to prevent infinite loops.
     * GitHub typically uses 1-2 redirects for asset downloads.
     */
    const MAX_REDIRECTS = 10;
    if (redirectDepth >= MAX_REDIRECTS) {
      this.logger.error(`[GitHubAdapter] Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
      throw new Error(`Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
    }

    // Check if URL is a GitHub domain (github.com or githubusercontent.com)
    const isGitHubDomain = (urlString: string): boolean => {
      try {
        const urlObj = new URL(urlString);
        return urlObj.hostname.includes('github.com')
          || urlObj.hostname.includes('githubusercontent.com');
      } catch {
        return false;
      }
    };

    // Check if URL is a GitHub API endpoint
    const isGitHubApiUrl = (urlString: string): boolean => {
      return urlString.startsWith(this.apiBase);
    };

    // Include authentication for private repos, but only for GitHub domains
    const token = await this.getAuthenticationToken();
    const headers: any = {
      'User-Agent': 'Prompt-Registry-VSCode-Extension'
    };

    // For GitHub API asset downloads, use Accept header to get binary content
    if (isGitHubApiUrl(url)) {
      headers.Accept = 'application/octet-stream';
    }

    // Only add auth headers for GitHub domains
    if (token && isGitHubDomain(url)) {
      headers.Authorization = `token ${token}`;
      this.logger.debug(`[GitHubAdapter] Downloading ${url} with auth (method: ${this.authMethod})`);
    } else if (token && !isGitHubDomain(url)) {
      this.logger.debug(`[GitHubAdapter] Downloading ${url} WITHOUT auth (non-GitHub domain)`);
    } else {
      this.logger.debug(`[GitHubAdapter] Downloading ${url} WITHOUT auth`);
    }

    return new Promise((resolve, reject) => {
      https.get(url, { headers }, (res) => {
        // Handle redirects (GitHub may redirect downloads)
        if (res.statusCode === 302 || res.statusCode === 301) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.logger.debug(`[GitHubAdapter] Following redirect (depth ${redirectDepth + 1}) to: ${redirectUrl}`);
            // Recursive call to follow redirect with incremented depth
            this.downloadFile(redirectUrl, redirectDepth + 1).then(resolve).catch(reject);
            return;
          }
        }

        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            this.logger.error(`[GitHubAdapter] Download failed: HTTP ${res.statusCode}`);
            this.logger.error(`[GitHubAdapter] URL: ${url}`);
            this.logger.error(`[GitHubAdapter] Auth method: ${this.authMethod}`);
            reject(new Error(`Download failed: ${res.statusCode} ${res.statusMessage}`));
            return;
          }
          const totalBytes = Buffer.concat(chunks).length;
          this.logger.debug(`[GitHubAdapter] Download complete: ${chunks.length} chunks, ${totalBytes} bytes`);
          resolve(Buffer.concat(chunks));
        });
      }).on('error', (error) => {
        this.logger.error(`[GitHubAdapter] Download error: ${error.message}`);
        reject(new Error(`Download failed: ${error.message}`));
      });
    });
  }

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
      repository: this.source.url
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
    const manifestContent = await this.downloadFile(url);
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
   * Invalidate the cached authentication token
   * This forces the adapter to re-authenticate on the next request
   * @param reason - Optional reason for invalidation (e.g., "401 Unauthorized")
   */
  private invalidateAuthCache(reason?: string): void {
    const previousMethod = this.authMethod;
    this.logger.info(`[GitHubAdapter] Invalidating authentication cache${reason ? `: ${reason}` : ''}`);
    if (previousMethod !== 'none') {
      this.logger.debug(`[GitHubAdapter] Previous auth method: ${previousMethod}`);
      this.attemptedMethods.add(previousMethod);
    }
    this.authToken = undefined;
    this.authMethod = 'none';
  }

  /**
   * Fetch bundles from GitHub releases
   * Scans all releases in the repository and creates Bundle objects for those
   * that contain both a deployment manifest and a bundle archive.
   *
   * Uses parallel manifest downloads with caching for improved performance.
   * @returns Promise resolving to array of Bundle objects
   * @throws {Error} if GitHub API request fails or authentication issues occur
   */
  public async fetchBundles(): Promise<Bundle[]> {
    const { owner, repo } = this.parseGitHubUrl();
    const url = `${this.apiBase}/repos/${owner}/${repo}/releases`;

    try {
      const releases: GitHubRelease[] = await this.makeRequest(url);

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

      // Download manifests in parallel with concurrency limit
      const concurrency = CONCURRENCY_CONSTANTS.MANIFEST_DOWNLOAD_CONCURRENCY;
      const bundles: Bundle[] = [];

      for (let i = 0; i < validReleases.length; i += concurrency) {
        const batch = validReleases.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
          batch.map((release) => this.processSingleRelease(release, owner, repo))
        );

        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value) {
            bundles.push(result.value);
          }
        }
      }

      return bundles;
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
      return await this.downloadFile(bundle.downloadUrl);
    } catch (error) {
      throw new Error(`Failed to download bundle: ${error}`);
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
      const repoData: any = await this.makeRequest(url);
      const releasesUrl = `${this.apiBase}/repos/${owner}/${repo}/releases`;
      const releases: GitHubRelease[] = await this.makeRequest(releasesUrl);

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
   * Validate GitHub repository accessibility
   * Checks if the repository exists and is accessible with current authentication.
   * @returns Promise resolving to ValidationResult with status and any errors/warnings
   */
  public async validate(): Promise<ValidationResult> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      const url = `${this.apiBase}/repos/${owner}/${repo}`;

      await this.makeRequest(url);

      // Try to fetch releases
      const releasesUrl = `${this.apiBase}/repos/${owner}/${repo}/releases`;
      const releases: GitHubRelease[] = await this.makeRequest(releasesUrl);

      return {
        valid: true,
        errors: [],
        warnings: releases.length === 0 ? ['No releases found in repository'] : [],
        bundlesFound: releases.length
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`GitHub validation failed: ${error}`],
        warnings: [],
        bundlesFound: 0
      };
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
