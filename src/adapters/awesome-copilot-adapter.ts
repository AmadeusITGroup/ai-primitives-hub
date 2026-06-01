/**
 * Awesome Copilot Collection Adapter
 *
 * Adapter for github/awesome-copilot style collection repositories.
 * Discovers .collection.yml files and exposes them as Prompt Registry bundles.
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
import {
  GitHubClient,
} from '../services/github-client';
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
  calculateBreakdown,
  CollectionManifest,
  mapCollectionToBundle,
  mapKindToType,
  parseCollectionYaml,
  titleCase,
} from './helpers/collection-parser';
import {
  RepositoryAdapter,
} from './repository-adapter';

/**
 * AwesomeCopilotAdapter Configuration
 */
export interface AwesomeCopilotConfig {
  /** Branch name (default: main) */
  branch?: string;
  /** Collections directory (default: collections) */
  collectionsPath?: string;
}

const CONCURRENCY_LIMIT = 5;

/**
 * AwesomeCopilotAdapter
 *
 * Fetches bundles from awesome-copilot style collection repositories.
 *
 * Features:
 * - Configurable repository URL (not hardcoded)
 * - Automatic collection discovery
 * - Content type mapping (prompt/instruction/chatmode/agent/skill)
 * - Cache for performance (5min TTL)
 * - GitHub API integration via GitHubClient
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
export class AwesomeCopilotAdapter extends RepositoryAdapter {
  public readonly type = 'awesome-copilot';
  private readonly config: Required<AwesomeCopilotConfig>;
  private readonly collectionsCache: Map<string, { bundles: Bundle[]; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  protected logger: Logger;
  private readonly client: GitHubClient;

  constructor(source: RegistrySource, client?: GitHubClient) {
    super(source);
    this.logger = Logger.getInstance();

    // Parse config
    const userConfig = source.config || {};
    this.config = {
      branch: userConfig.branch || 'main',
      collectionsPath: userConfig.collectionsPath || 'collections'
    };

    this.client = client ?? new GitHubClient({
      sourceUrl: source.url,
      explicitToken: source.token
    });

    this.logger.info(`AwesomeCopilotAdapter initialized for: ${source.url}`);
  }

  /**
   * List all .collection.yml files in collections directory
   */
  private async listCollectionFiles(): Promise<string[]> {
    const contents = await this.client.getContents(this.config.collectionsPath, this.config.branch);
    return contents
      .filter((f) => f.type === 'file' && f.name.endsWith('.collection.yml'))
      .map((f) => f.name);
  }

  /**
   * Parse a collection file into a Bundle
   * @param collectionFile
   */
  private async parseCollection(collectionFile: string): Promise<Bundle | null> {
    try {
      const filePath = `${this.config.collectionsPath}/${collectionFile}`;
      const buffer = await this.client.getFileContent(filePath, this.config.branch);
      const yamlContent = buffer.toString('utf8');
      const collection = parseCollectionYaml(yamlContent);

      // Extract MCP servers from either 'mcp.items' or 'mcpServers' field
      const mcpServers = collection.mcpServers || collection.mcp?.items;

      // Count items by kind (including MCP servers)
      const breakdown = calculateBreakdown(collection.items, mcpServers);

      // Map collection to bundle using shared helper
      const bundle = mapCollectionToBundle(collection, this.source.id, this.source.url);

      // Fill in URLs that mapCollectionToBundle leaves empty
      bundle.manifestUrl = this.getManifestUrl(collection.id);
      bundle.downloadUrl = this.getDownloadUrl(collection.id);

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

              const skillContents = await this.client.getContentsRecursive(skillDirPath, this.config.branch);
              const skillFiles = skillContents.filter((f) => f.type === 'file');
              this.logger.debug(`Found ${skillFiles.length} files in skill directory`);

              for (const file of skillFiles) {
                const content = await this.client.getFileContent(file.path, this.config.branch);
                archive.append(content, { name: file.path });
                this.logger.debug(`Added ${file.path} (${content.length} bytes)`);
              }
            } else {
              // For other types, fetch single file and put in prompts/ folder
              const content = await this.client.getFileContent(item.path, this.config.branch);
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
          name: titleCase(skillName.replace(/-/g, ' ')),
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
        name: titleCase(id.replace(/-/g, ' ')),
        description: `From ${collection.name}`,
        file: `prompts/${filename}`,
        type: mapKindToType(itemKind),
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
      author: collection.author || this.client.owner,
      repository: this.source.url,
      license: 'MIT',
      tags: collection.tags || [],
      prompts,
      ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {})
    };
  }

  /**
   * Build raw GitHub content URL
   * @param path
   */
  private buildRawUrl(path: string): string {
    return `https://raw.githubusercontent.com/${this.client.owner}/${this.client.repo}/${this.config.branch}/${path}`;
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
      const filePath = `${this.config.collectionsPath}/${collectionFile}`;
      const buffer = await this.client.getFileContent(filePath, this.config.branch);
      const yamlContent = buffer.toString('utf8');
      const collection = parseCollectionYaml(yamlContent);
      this.logger.debug(`Collection loaded: ${collection.name}, items: ${collection.items.length}`);

      // Create zip archive
      const archiveBuffer = await this.createBundleArchive(collection, collectionFile);
      this.logger.debug(`Archive created: ${archiveBuffer.length} bytes`);
      return archiveBuffer;
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
      const collectionFiles = await this.listCollectionFiles();

      return {
        name: `${this.client.owner}/${this.client.repo}`,
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
      // Check if collections directory exists and has .collection.yml files
      const contents = await this.client.getContents(this.config.collectionsPath, this.config.branch);
      const collectionFiles = contents.filter((f) => f.type === 'file' && f.name.endsWith('.collection.yml'));

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
   * Delegates to GitHubClient by resetting its auth state
   */
  public async forceAuthentication(): Promise<void> {
    this.logger.info('[AwesomeCopilotAdapter] Forcing re-authentication...');
    await this.client.forceReauthenticate();
  }
}
