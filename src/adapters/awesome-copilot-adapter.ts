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
  GitHubBackedAdapter,
} from './github-backed-adapter';

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
  readme?: {
    path: string;
  };
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
 * - GitHub API integration (via GitHubBackedAdapter)
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
 * const bundles = await adapter.fetchBundles();
 * ```
 */
export class AwesomeCopilotAdapter extends GitHubBackedAdapter {
  public readonly type = 'awesome-copilot';
  private readonly config: Required<AwesomeCopilotConfig>;
  private readonly collectionsCache: Map<string, { bundles: Bundle[]; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(source: RegistrySource) {
    super(source);

    // Parse config
    const userConfig = source.config || {};
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
    const files = await this.getJson<GitHubContent[]>(this.buildCollectionsApiUrl());
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
      const collectionUrl = this.buildRepoRawUrl(`${this.config.collectionsPath}/${collectionFile}`);
      const yamlContent = await this.getText(collectionUrl);
      const collection = yaml.load(yamlContent) as CollectionManifest;

      this.logger.debug(`[AwesomeCopilot]: Here is the parsed collection ${collection.readme?.path}`);

      // Extract MCP servers from either 'mcp.items' or 'mcpServers' field
      const mcpServers = collection.mcpServers || collection.mcp?.items;

      // Count items by kind (including MCP servers)
      const breakdown = this.calculateBreakdown(collection.items, mcpServers);

      const readmeUrl = collection.readme?.path ? this.buildRepoRawUrl(collection.readme.path) : undefined;

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
        manifestUrl: this.buildRepoRawUrl(`${this.config.collectionsPath}/${collectionFile}`),
        downloadUrl: this.buildRepoRawUrl(`${this.config.collectionsPath}/${collectionFile}`),
        lastUpdated: new Date().toISOString(),
        size: `${collection.items.length} items`,
        dependencies: [],
        license: 'MIT',
        readmeUrl: readmeUrl
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

    //  errors after await are manually routed to reject via try/catch. Should be refactored to separate the event-based stream promise from the async fetch loop.
    // eslint-disable-next-line no-async-promise-executor -- async executor is intentional;
    return new Promise<Buffer>(async (resolve, reject) => {
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
              const fileUrl = this.buildRepoRawUrl(filePath);
              const content = await this.getText(fileUrl);
              archive.append(content, { name: filePath });
              this.logger.debug(`Added ${filePath} (${content.length} bytes)`);
            }
          } else {
            // For other types, fetch single file and put in prompts/ folder
            const itemUrl = this.buildRepoRawUrl(item.path);
            const content = await this.getText(itemUrl);
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
   * Build GitHub Contents API URL for the collections directory (pinned to branch).
   */
  private buildCollectionsApiUrl(): string {
    const { owner, repo } = this.parseGitHubUrl();
    return this.buildContentsUrl(owner, repo, this.config.collectionsPath, this.config.branch);
  }

  /**
   * Build a raw githubusercontent URL for a repo-relative path at the configured branch.
   * @param path
   */
  private buildRepoRawUrl(path: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    return this.buildRawUrl(owner, repo, this.config.branch, path);
  }

  /**
   * Fetch the head commit sha of the configured branch.
   * Used as the readme revision so cached readmes are re-downloaded when the branch advances.
   * @returns The commit sha, or undefined if it cannot be resolved (callers fall back to always-download)
   */
  private async fetchBranchSha(): Promise<string | undefined> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      const apiUrl = `${this.apiBase}/repos/${owner}/${repo}/commits/${this.config.branch}`;
      const commit = await this.getJson<{ sha?: string }>(apiUrl);
      return commit.sha;
    } catch (error) {
      this.logger.warn(`Failed to resolve branch sha for readme revision: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * List all files in a directory recursively via GitHub API
   * @param dirPath - Directory path in the repository
   * @returns Array of file paths relative to repo root
   */
  private async listDirectoryContentsRecursively(dirPath: string): Promise<string[]> {
    const filePaths: string[] = [];

    try {
      const { owner, repo } = this.parseGitHubUrl();
      const apiUrl = this.buildContentsUrl(owner, repo, dirPath, this.config.branch);
      const contents = await this.getJson<GitHubContent[]>(apiUrl);

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
   * Extract repository owner
   */
  private extractRepoOwner(): string {
    const { owner } = this.parseGitHubUrl();
    return owner;
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
   * Results are cached for 5 minutes to reduce API calls. Each parse chunk streams a growing
   * snapshot to the optional callback so the UI can render progressively during large syncs.
   * @param onPartialBundles Optional callback invoked with a growing snapshot after each chunk
   * @returns Promise resolving to array of Bundle objects from collection files
   * @throws {Error} if GitHub API fails or collection parsing fails
   */
  public async fetchBundles(
    onPartialBundles?: (bundles: Bundle[]) => void | Promise<void>
  ): Promise<Bundle[]> {
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

      // Step 2: Parse each collection in bounded-size chunks, streaming partial results
      const bundles = await this.processInChunks(
        collectionFiles,
        5,
        (file) => this.parseCollection(file).catch((error) => {
          this.logger.warn(`Failed to parse collection ${file}:`, error);
          return null;
        }),
        onPartialBundles
      );

      // Stamp the branch head sha as the readme revision so cached readmes are refreshed
      // when the branch advances (the raw readme URL is stable across commits)
      const branchSha = await this.fetchBranchSha();
      if (branchSha) {
        for (const bundle of bundles) {
          if (bundle.readmeUrl) {
            bundle.readmeRevision = branchSha;
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
      const collectionUrl = this.buildRepoRawUrl(`${this.config.collectionsPath}/${collectionFile}`);
      this.logger.debug(`Fetching collection from: ${collectionUrl}`);
      const yamlContent = await this.getText(collectionUrl);
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

  public async downloadReadme(bundle: Bundle): Promise<string | null> {
    if (!bundle.readmeUrl) {
      return null;
    }
    try {
      return await this.getText(bundle.readmeUrl);
    } catch (error) {
      this.logger.error('Failed to download readme', error as Error);
      return null;
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
    return this.buildRepoRawUrl(`${this.config.collectionsPath}/${collectionFile}`);
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
      const files = await this.getJson<GitHubContent[]>(this.buildCollectionsApiUrl());
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
    this.invalidateAuthCache('force re-authentication');

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
