/**
 * Awesome Copilot Collection Adapter
 *
 * Adapter for github/awesome-copilot style collection repositories.
 * Discovers .collection.yml files and exposes them as AI Primitives Hub bundles.
 *
 * Collection Format:
 * ```yaml
 * id: azure-cloud-development
 * name: Azure & Cloud Development
 * description: Comprehensive Azure cloud development tools...
 * tags: [azure, cloud, infrastructure]
 * items:
 *   - path: prompts/azure-resource-health.prompt.md
 *     kind: prompt
 *   - path: instructions/bicep-best-practices.instructions.md
 *     kind: instruction
 *   - path: chatmodes/azure-architect.chatmode.md
 *     kind: chat-mode
 * ```
 */

import {
  exec,
} from 'node:child_process';
import * as https from 'node:https';
import {
  promisify,
} from 'node:util';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import {
  Bundle,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';
import {
  RepositoryAdapter,
} from './repository-adapter';

const execAsync = promisify(exec);

/**
 * Awesome Copilot Collection Schema
 */
interface CollectionManifest {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  items: CollectionItem[];
  display?: {
    ordering?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
    show_badge?: boolean;
  };
  mcp?: {
    items?: Record<string, any>;
  };
  mcpServers?: Record<string, any>;
}

interface CollectionItem {
  path: string;
  kind: 'prompt' | 'instruction' | 'chat-mode' | 'agent' | 'skill';
}

/**
 * GitHub API response for directory listing
 */
interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  download_url: string;
}

/**
 * AwesomeCopilotAdapter Configuration
 */
export interface AwesomeCopilotConfig {
  /** Branch name (default: main) */
  branch?: string;
  /** Collections directory (default: collections) */
  collectionsPath?: string;
}

/**
 * AwesomeCopilotAdapter
 *
 * Fetches bundles from awesome-copilot style collection repositories.
 *
 * Features:
 * - Configurable repository URL (not hardcoded)
 * - Automatic collection discovery
 * - Content type mapping (prompt/instruction/chatmode/agent)
 * - Cache for performance
 * - GitHub API integration
 *
 * Usage:
 * ```typescript
 * const source: RegistrySource = {
 *   id: 'awesome-copilot',
 *   name: 'Awesome Copilot',
 *   url: 'https://github.com/github/awesome-copilot',
 *   type: 'awesome-copilot',
 *   config: { branch: 'main', collectionsPath: 'collections' }
 * };
 * const adapter = new AwesomeCopilotAdapter(source);
 * const bundles = await adapter.listBundles();
 * ```
 */
export class AwesomeCopilotAdapter extends RepositoryAdapter {
  public readonly type = 'awesome-copilot';
  private readonly config: Required<AwesomeCopilotConfig>;
  private readonly collectionsCache: Map<string, { bundles: Bundle[]; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  protected logger: Logger;
  private authToken: string | undefined;
  private authMethod: 'vscode' | 'gh-cli' | 'explicit' | 'none' = 'none';

  constructor(source: RegistrySource) {
    super(source);
    this.logger = Logger.getInstance();

    // Parse config
    const userConfig = (source as any).config || {};
    this.config = {
      branch: userConfig.branch || 'main',
      collectionsPath: userConfig.collectionsPath || 'collections'
    };

    this.logger.info(`AwesomeCopilotAdapter initialized for: ${source.url}`);
  }

  /**
   * List all .collection.yml files in collections directory
   */
  private async listCollectionFiles(): Promise<string[]> {
    const apiUrl = this.buildApiUrl(`${this.config.collectionsPath}`);
    const content = await this.fetchUrl(apiUrl);

    const files = JSON.parse(content) as GitHubContent[];
    return files
      .filter((f) => f.type === 'file' && f.name.endsWith('.collection.yml'))
      .map((f) => f.name);
  }

  /**
   * Parse a collection file into a Bundle
   * @param collectionFile
   */
  private async parseCollection(collectionFile: string): Promise<Bundle | null> {
    try {
      const collectionUrl = this.buildRawUrl(`${this.config.collectionsPath}/${collectionFile}`);
      const yamlContent = await this.fetchUrl(collectionUrl);
      const collection = yaml.load(yamlContent) as CollectionManifest;

      // Extract MCP servers from either 'mcp.items' or 'mcpServers' field
      const mcpServers = collection.mcpServers || collection.mcp?.items;

      // Count items by kind (including MCP servers)
      const breakdown = this.calculateBreakdown(collection.items, mcpServers);

      const bundle: Bundle = {
        id: collection.id,
        name: collection.name,
        version: collection.version || '1.0.0',
        description: collection.description,
        author: collection.author || this.extractRepoOwner(),
        repository: this.source.url,
        tags: collection.tags || [],
        environments: this.inferEnvironments(collection.tags || []),
        sourceId: this.source.id,
        manifestUrl: this.buildRawUrl(`${this.config.collectionsPath}/${collectionFile}`),
        downloadUrl: this.buildRawUrl(`${this.config.collectionsPath}/${collectionFile}`),
        lastUpdated: new Date().toISOString(),
        size: `${collection.items.length} items`,
        dependencies: [],
        license: 'MIT'
      };

      // Store collection file name for download
      (bundle as any).collectionFile = collectionFile;
      (bundle as any).breakdown = breakdown;

      // Attach MCP servers for pre-installation display
      if (mcpServers && Object.keys(mcpServers).length > 0) {
        (bundle as any).mcpServers = mcpServers;
      }

      return bundle;
    } catch (error) {
      this.logger.error(`Failed to parse collection ${collectionFile}`, error as Error);
      return null;
    }
  }

  /**
   * Create a zip archive containing collection files
   * @param collection
   * @param _collectionFile
   */
  private async createBundleArchive(collection: CollectionManifest, _collectionFile: string): Promise<Buffer> {
    this.logger.debug(`Creating archive for collection: ${collection.name}`);

    return new Promise<Buffer>((resolve, reject) => {
      // Use IIFE to handle async operations within Promise executor
      void (async () => {
        try {
          const archive = archiver('zip', { zlib: { level: 9 } });
          const chunks: Buffer[] = [];

          // Collect data chunks
          archive.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });

          // Resolve when archive is finalized
          archive.on('finish', () => {
            const buffer = Buffer.concat(chunks);
            this.logger.debug(`Archive finalized: ${buffer.length} bytes (${chunks.length} chunks)`);
            resolve(buffer);
          });

          // Handle errors
          archive.on('error', (err: Error) => {
            this.logger.error('Archive error', err);
            reject(err);
          });

          // Log warnings
          archive.on('warning', (warning: Error) => {
            this.logger.warn('Archive warning', warning);
          });

          // Add deployment-manifest.yml
          const manifest = this.createDeploymentManifest(collection);
          const manifestYaml = yaml.dump(manifest);
          archive.append(manifestYaml, { name: 'deployment-manifest.yml' });
          this.logger.debug(`Added manifest (${manifestYaml.length} bytes)`);

          // Add each item file
          for (const item of collection.items) {
            // For skills, preserve directory structure and fetch ALL files in the skill directory
            if (item.kind === 'skill') {
              // item.path is like skills/my-skill/SKILL.md
              // We need to fetch the entire skill directory, not just SKILL.md
              const skillDirPath = item.path.substring(0, item.path.lastIndexOf('/'));
              this.logger.debug(`Fetching all files in skill directory: ${skillDirPath}`);

              const skillFiles = await this.listDirectoryContentsRecursively(skillDirPath);
              this.logger.debug(`Found ${skillFiles.length} files in skill directory: ${skillFiles.join(', ')}`);

              for (const filePath of skillFiles) {
                const fileUrl = this.buildRawUrl(filePath);
                const content = await this.fetchUrl(fileUrl);
                archive.append(content, { name: filePath });
                this.logger.debug(`Added ${filePath} (${content.length} bytes)`);
              }
            } else {
              // For other types, fetch single file and put in prompts/ folder
              const itemUrl = this.buildRawUrl(item.path);
              const content = await this.fetchUrl(itemUrl);
              const filename = item.path.split('/').pop() || 'unknown';
              archive.append(content, { name: `prompts/${filename}` });
              this.logger.debug(`Added ${filename} (${content.length} bytes)`);
            }
          }

          // Finalize the archive (this triggers 'finish' event when complete)
          this.logger.debug('Finalizing archive...');
          void archive.finalize();
        } catch (error) {
          this.logger.error('Failed to create archive', error as Error);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejection value is handled by caller
          reject(error);
        }
      })();
    });
  }

  /**
   * Create deployment manifest from collection
   * @param collection
   */
  private createDeploymentManifest(collection: CollectionManifest): any {
    const prompts = collection.items.map((item) => {
      const itemKind = item.kind;
      const itemPath = item.path;

      // For skills, preserve the full path (skills/skill-name/SKILL.md)
      if (itemKind === 'skill') {
        // Extract skill name from path like skills/my-skill/SKILL.md
        const skillMatch = itemPath.match(/skills\/([^/]+)\/SKILL\.md/);
        const skillName = skillMatch ? skillMatch[1] : 'unknown-skill';
        return {
          id: skillName,
          name: this.titleCase(skillName.replace(/-/g, ' ')),
          description: `Skill from ${collection.name}`,
          file: itemPath, // Preserve full path for skills
          type: 'skill' as const,
          tags: collection.tags || []
        };
      }

      // For other types, use prompts/ folder
      const filename = itemPath.split('/').pop() || 'unknown';
      const id = filename.replace(/\.(prompt|instructions|chatmode|agent)\.md$/, '');

      return {
        id,
        name: this.titleCase(id.replace(/-/g, ' ')),
        description: `From ${collection.name}`,
        file: `prompts/${filename}`,
        type: this.mapKindToType(itemKind),
        tags: collection.tags || []
      };
    });

    // Extract MCP servers from either 'mcp.items' or 'mcpServers' field
    const mcpServers = collection.mcpServers || collection.mcp?.items;

    return {
      id: collection.id,
      name: collection.name,
      version: collection.version || '1.0.0',
      description: collection.description,
      author: collection.author || this.extractRepoOwner(),
      repository: this.source.url,
      license: 'MIT',
      tags: collection.tags || [],
      prompts,
      ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {})
    };
  }

  /**
   * Map collection kind to AI Primitives Hub type
   * @param kind
   */
  private mapKindToType(kind: string): 'prompt' | 'instructions' | 'chatmode' | 'agent' | 'skill' {
    const kindMap: Record<string, 'prompt' | 'instructions' | 'chatmode' | 'agent' | 'skill'> = {
      prompt: 'prompt',
      instruction: 'instructions',
      'chat-mode': 'chatmode',
      agent: 'agent',
      skill: 'skill'
    };
    return kindMap[kind] || 'prompt';
  }

  /**
   * Calculate content breakdown from items
   * @param items
   * @param mcpServers
   */
  private calculateBreakdown(items: CollectionItem[], mcpServers?: Record<string, any>): Record<string, number> {
    const breakdown = {
      prompts: 0,
      instructions: 0,
      chatmodes: 0,
      agents: 0,
      skills: 0,
      mcpServers: mcpServers ? Object.keys(mcpServers).length : 0
    };

    for (const item of items) {
      switch (item.kind) {
        case 'prompt': {
          breakdown.prompts++;
          break;
        }
        case 'instruction': {
          breakdown.instructions++;
          break;
        }
        case 'chat-mode': {
          breakdown.chatmodes++;
          break;
        }
        case 'agent': {
          breakdown.agents++;
          break;
        }
        case 'skill': {
          breakdown.skills++;
          break;
        }
      }
    }

    return breakdown;
  }

  /**
   * Infer environments from tags
   * @param tags
   */
  private inferEnvironments(tags: string[]): string[] {
    const envMap: Record<string, string> = {
      azure: 'cloud',
      aws: 'cloud',
      gcp: 'cloud',
      frontend: 'web',
      backend: 'server',
      database: 'data',
      devops: 'infrastructure',
      testing: 'testing'
    };

    const environments = new Set<string>();
    for (const tag of tags) {
      const env = envMap[tag.toLowerCase()];
      if (env) {
        environments.add(env);
      }
    }

    return environments.size > 0 ? Array.from(environments) : ['general'];
  }

  /**
   * Build GitHub API URL
   * @param path
   */
  private buildApiUrl(path: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${this.config.branch}`;
  }

  /**
   * List all files in a directory recursively via GitHub API
   * @param dirPath - Directory path in the repository
   * @returns Array of file paths relative to repo root
   */
  private async listDirectoryContentsRecursively(dirPath: string): Promise<string[]> {
    const filePaths: string[] = [];

    try {
      const apiUrl = this.buildApiUrl(dirPath);
      const response = await this.fetchUrl(apiUrl);
      const contents = JSON.parse(response) as GitHubContent[];

      for (const item of contents) {
        if (item.type === 'file') {
          filePaths.push(item.path);
        } else if (item.type === 'dir') {
          // Recursively list subdirectory
          const subFiles = await this.listDirectoryContentsRecursively(item.path);
          filePaths.push(...subFiles);
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to list directory ${dirPath}: ${(error as Error).message}`);
    }

    return filePaths;
  }

  /**
   * Build raw GitHub content URL
   * @param path
   */
  private buildRawUrl(path: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `https://raw.githubusercontent.com/${owner}/${repo}/${this.config.branch}/${path}`;
  }

  /**
   * Parse GitHub URL
   */
  private parseGitHubUrl(): { owner: string; repo: string } {
    const url = this.source.url.replace(/\.git$/, '');
    const match = url.match(/github\.com[/:]([^/]+)\/([^/]+)/);

    if (!match) {
      throw new Error(`Invalid GitHub URL: ${this.source.url}`);
    }

    return { owner: match[1], repo: match[2] };
  }

  /**
   * Extract repository owner
   */
  private extractRepoOwner(): string {
    const { owner } = this.parseGitHubUrl();
    return owner;
  }

  /**
   * Get authentication token using fallback chain:
   * 1. VSCode GitHub API (if user is logged in)
   * 2. gh CLI (if installed and authenticated)
   * 3. Explicit token from source configuration
   */
  private async getAuthenticationToken(): Promise<string | undefined> {
    // Return cached token if already resolved
    if (this.authToken !== undefined) {
      this.logger.debug(`[AwesomeCopilotAdapter] Using cached token (method: ${this.authMethod})`);
      return this.authToken;
    }

    this.logger.info('[AwesomeCopilotAdapter] Attempting authentication...');

    // Try VSCode GitHub authentication first
    try {
      this.logger.debug('[AwesomeCopilotAdapter] Trying VSCode GitHub authentication...');
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      if (session) {
        this.authToken = session.accessToken;
        this.authMethod = 'vscode';
        this.logger.info('[AwesomeCopilotAdapter] ✓ Using VSCode GitHub authentication');
        this.logger.debug(`[AwesomeCopilotAdapter] Token preview: ${this.authToken.substring(0, 8)}...`);
        return this.authToken;
      }
      this.logger.debug('[AwesomeCopilotAdapter] VSCode auth session not found');
    } catch (error) {
      this.logger.warn(`[AwesomeCopilotAdapter] VSCode auth failed: ${error}`);
    }

    // Try gh CLI authentication
    try {
      this.logger.debug('[AwesomeCopilotAdapter] Trying gh CLI authentication...');
      const { stdout } = await execAsync('gh auth token');
      const token = stdout.trim();
      if (token && token.length > 0) {
        this.authToken = token;
        this.authMethod = 'gh-cli';
        this.logger.info('[AwesomeCopilotAdapter] ✓ Using gh CLI authentication');
        this.logger.debug(`[AwesomeCopilotAdapter] Token preview: ${this.authToken.substring(0, 8)}...`);
        return this.authToken;
      }
      this.logger.debug('[AwesomeCopilotAdapter] gh CLI returned empty token');
    } catch (error) {
      this.logger.warn(`[AwesomeCopilotAdapter] gh CLI auth failed: ${error}`);
    }

    // Fall back to explicit token from source configuration
    const explicitToken = this.getAuthToken();
    if (explicitToken) {
      this.authToken = explicitToken;
      this.authMethod = 'explicit';
      this.logger.info('[AwesomeCopilotAdapter] ✓ Using explicit token from configuration');
      this.logger.debug(`[AwesomeCopilotAdapter] Token preview: ${this.authToken.substring(0, 8)}...`);
      return this.authToken;
    }

    // No authentication available
    this.authMethod = 'none';
    this.logger.warn('[AwesomeCopilotAdapter] ✗ No authentication available - API rate limits will apply and private repos will be inaccessible');
    return undefined;
  }

  /**
   * Fetch URL content with authentication
   * Handles redirects (301/302) by following the Location header
   * @param url
   * @param redirectDepth
   */
  private async fetchUrl(url: string, redirectDepth = 0): Promise<string> {
    /**
     * Maximum redirect depth to prevent infinite loops.
     */
    const MAX_REDIRECTS = 10;
    if (redirectDepth >= MAX_REDIRECTS) {
      this.logger.error(`[AwesomeCopilotAdapter] Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
      throw new Error(`Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
    }

    const token = await this.getAuthenticationToken();
    const headers: Record<string, string> = {
      'User-Agent': 'VSCode-Prompt-Registry'
    };

    if (token) {
      headers.Authorization = `token ${token}`;
      this.logger.debug(`[AwesomeCopilotAdapter] Request to ${url} with auth (method: ${this.authMethod})`);
    } else {
      this.logger.debug(`[AwesomeCopilotAdapter] Request to ${url} WITHOUT auth`);
    }

    // Log headers (sanitized)
    const sanitizedHeaders = { ...headers };
    if (sanitizedHeaders.Authorization) {
      sanitizedHeaders.Authorization = sanitizedHeaders.Authorization.substring(0, 15) + '...';
    }
    this.logger.debug(`[AwesomeCopilotAdapter] Request headers: ${JSON.stringify(sanitizedHeaders)}`);

    return new Promise((resolve, reject) => {
      https.get(url, { headers }, (res) => {
        // Handle redirects (301/302)
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            this.logger.debug(`[AwesomeCopilotAdapter] Following redirect (depth ${redirectDepth + 1}) to: ${redirectUrl}`);
            this.fetchUrl(redirectUrl, redirectDepth + 1).then(resolve).catch(reject);
            return;
          }
        }

        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            this.logger.debug(`[AwesomeCopilotAdapter] Response OK (${res.statusCode}), ${data.length} bytes`);
            resolve(data);
          } else {
            this.logger.error(`[AwesomeCopilotAdapter] HTTP ${res.statusCode}: ${res.statusMessage}`);
            this.logger.error(`[AwesomeCopilotAdapter] URL: ${url}`);
            this.logger.error(`[AwesomeCopilotAdapter] Auth method: ${this.authMethod}`);
            this.logger.error(`[AwesomeCopilotAdapter] Response: ${data.substring(0, 500)}`);

            // Provide helpful error messages
            let errorMsg = `HTTP ${res.statusCode}: ${res.statusMessage}`;
            switch (res.statusCode) {
              case 404: {
                errorMsg += ' - Repository not found or not accessible. Check authentication.';

                break;
              }
              case 401: {
                errorMsg += ' - Authentication failed. Token may be invalid or expired.';

                break;
              }
              case 403: {
                errorMsg += ' - Access forbidden. Token may lack required scopes (repo).';

                break;
              }
                        // No default
            }
            reject(new Error(errorMsg));
          }
        });
      }).on('error', (error) => {
        this.logger.error(`[AwesomeCopilotAdapter] Network error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Convert kebab-case to Title Case
   * @param str
   */
  private titleCase(str: string): string {
    return str
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Fetch list of available bundles from the source
   * Scans the collections directory for .collection.yml files and creates Bundle objects.
   * Results are cached for 5 minutes to reduce API calls.
   * @returns Promise resolving to array of Bundle objects from collection files
   * @throws {Error} if GitHub API fails or collection parsing fails
   */
  public async fetchBundles(): Promise<Bundle[]> {
    this.logger.debug('Listing bundles from awesome-copilot repository');

    // Check cache
    const cacheKey = `${this.source.url}-${this.config.branch}`;
    const cached = this.collectionsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logger.debug('Using cached collections');
      return cached.bundles;
    }

    try {
      // Step 1: List .collection.yml files
      const collectionFiles = await this.listCollectionFiles();
      this.logger.debug(`Found ${collectionFiles.length} collection files`);

      // Step 2: Parse each collection (with concurrency limit)
      const bundles: Bundle[] = [];
      const CONCURRENCY_LIMIT = 5;

      for (let i = 0; i < collectionFiles.length; i += CONCURRENCY_LIMIT) {
        const chunk = collectionFiles.slice(i, i + CONCURRENCY_LIMIT);
        this.logger.debug(`Processing chunk ${i / CONCURRENCY_LIMIT + 1}/${Math.ceil(collectionFiles.length / CONCURRENCY_LIMIT)}`);

        const chunkResults = await Promise.all(chunk.map(async (file) => {
          try {
            return await this.parseCollection(file);
          } catch (error) {
            this.logger.warn(`Failed to parse collection ${file}:`, error);
            return null;
          }
        }));

        for (const bundle of chunkResults) {
          if (bundle) {
            bundles.push(bundle);
          }
        }
      }

      // Cache results
      this.collectionsCache.set(cacheKey, { bundles, timestamp: Date.now() });

      return bundles;
    } catch (error) {
      this.logger.error('Failed to list bundles', error as Error);
      throw new Error(`Failed to list awesome-copilot collections: ${(error as Error).message}`);
    }
  }

  /**
   * Download a bundle as a dynamically-created zip archive
   * Fetches all items referenced in the collection and creates a ZIP file on the fly.
   * The archive includes prompts, instructions, and a deployment manifest.
   * @param bundle - Bundle object containing collection metadata
   * @returns Promise resolving to Buffer containing the ZIP archive
   * @throws {Error} if collection fetch fails or archive creation fails
   */
  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    this.logger.debug(`Downloading bundle: ${bundle.id}`);

    try {
      // Find collection file from bundle metadata
      const collectionFile = (bundle as any).collectionFile || `${bundle.id}.collection.yml`;
      this.logger.debug(`Collection file: ${collectionFile}`);

      // Parse collection
      const collectionUrl = this.buildRawUrl(`${this.config.collectionsPath}/${collectionFile}`);
      this.logger.debug(`Fetching collection from: ${collectionUrl}`);
      const yamlContent = await this.fetchUrl(collectionUrl);
      const collection = yaml.load(yamlContent) as CollectionManifest;
      this.logger.debug(`Collection loaded: ${collection.name}, items: ${collection.items.length}`);

      // Create zip archive
      const buffer = await this.createBundleArchive(collection, collectionFile);
      this.logger.debug(`Archive created: ${buffer.length} bytes`);
      return buffer;
    } catch (error) {
      this.logger.error('Failed to download bundle', error as Error);
      throw new Error(`Failed to download bundle: ${(error as Error).message}`);
    }
  }

  /**
   * Fetch repository metadata
   * Retrieves information about the awesome-copilot repository including collection count.
   * @returns Promise resolving to SourceMetadata with repository info
   * @throws {Error} if repository access fails or collection listing fails
   */
  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      const collectionFiles = await this.listCollectionFiles();

      return {
        name: `${owner}/${repo}`,
        description: `Awesome Copilot collections from ${this.source.url}`,
        bundleCount: collectionFiles.length,
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch metadata: ${(error as Error).message}`);
    }
  }

  /**
   * Get manifest URL for a bundle
   * Returns the raw GitHub URL to the collection YAML file.
   * @param bundleId - Bundle identifier matching the collection filename
   * @param _version - Optional version (not used, always uses configured branch)
   * @returns URL string pointing to collection .yml file on GitHub raw content
   */
  public getManifestUrl(bundleId: string, _version?: string): string {
    const collectionFile = `${bundleId}.collection.yml`;
    return this.buildRawUrl(`${this.config.collectionsPath}/${collectionFile}`);
  }

  /**
   * Get download URL for a bundle
   * Returns the collection YAML URL (bundles are created dynamically, not pre-packaged).
   * @param bundleId - Bundle identifier matching the collection filename
   * @param version - Optional version (not used, always uses configured branch)
   * @returns URL string pointing to collection .yml file on GitHub raw content
   */
  public getDownloadUrl(bundleId: string, version?: string): string {
    // For awesome-copilot, download URL is same as manifest URL
    // (we download and package on the fly)
    return this.getManifestUrl(bundleId, version);
  }

  /**
   * Validate repository structure
   * Checks if the collections directory exists and contains at least one collection file.
   * @returns Promise resolving to ValidationResult with status and any errors/warnings
   */
  public async validate(): Promise<ValidationResult> {
    try {
      // Check if collections directory exists
      const apiUrl = this.buildApiUrl(`${this.config.collectionsPath}`);
      const content = await this.fetchUrl(apiUrl);

      const files = JSON.parse(content) as GitHubContent[];
      const collectionFiles = files.filter((f) => f.type === 'file' && f.name.endsWith('.collection.yml'));

      if (collectionFiles.length === 0) {
        return {
          valid: false,
          errors: ['No .collection.yml files found in collections directory'],
          warnings: [],
          bundlesFound: 0
        };
      }

      return {
        valid: true,
        errors: [],
        warnings: [],
        bundlesFound: collectionFiles.length
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Failed to validate repository: ${(error as Error).message}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  /**
   * Force re-authentication
   * Clears cached token and forces new VS Code session
   */
  public async forceAuthentication(): Promise<void> {
    this.logger.info('[AwesomeCopilotAdapter] Forcing re-authentication...');

    // Clear current state
    this.authToken = undefined;
    this.authMethod = 'none';

    // Force new session with VS Code
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], {
        forceNewSession: true
      });

      if (session) {
        this.authToken = session.accessToken;
        this.authMethod = 'vscode';
        this.logger.info('[AwesomeCopilotAdapter] ✓ Re-authentication successful');
      }
    } catch (error) {
      this.logger.error(`[AwesomeCopilotAdapter] Re-authentication failed: ${error}`);
      throw error;
    }
  }
}
