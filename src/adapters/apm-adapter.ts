/**
 * ApmAdapter
 *
 * Fetches APM packages from GitHub repositories using GitHubClient.
 * Integrates with APM CLI for package installation.
 *
 * Security considerations:
 * - Validates GitHub URL format strictly
 * - Sanitizes all inputs
 * - Does not execute scripts from manifests
 * - Uses APM CLI for actual package operations
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import {
  ApmCliWrapper,
} from '../services/apm-cli-wrapper';
import {
  ApmRuntimeManager,
} from '../services/apm-runtime-manager';
import {
  GitHubClient,
  TreeEntry,
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
  ApmManifest,
  ApmPackageMapper,
} from './apm-package-mapper';
import {
  titleCase,
} from './helpers/collection-parser';
import {
  RepositoryAdapter,
} from './repository-adapter';

/**
 * Configuration options for ApmAdapter
 */
export interface ApmAdapterConfig {
  /** Branch to fetch from (default: 'main') */
  branch?: string;
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtl?: number;
  /** Enable virtual package support (default: true) */
  enableVirtualPackages?: boolean;
}

/**
 * GitHub URL validation pattern
 * Security: Only allow valid GitHub repository URLs
 */
const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(\.git)?$/;

/**
 * Prompt file types
 */
const PROMPT_EXTENSIONS = ['.prompt.md', '.instructions.md', '.chatmode.md', '.agent.md'];

/**
 * Directories to skip
 */
const SKIP_DIRECTORIES = ['node_modules', 'apm_modules', '.git', 'dist', 'build'];

/**
 * Default cache TTL (5 minutes)
 */
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;

/**
 * Extended bundle with APM-specific data
 */
interface ApmBundle extends Bundle {
  apmPackageRef: string;
}

/**
 * Cache entry
 */
interface CacheEntry {
  bundles: ApmBundle[];
  timestamp: number;
}

/**
 * ApmAdapter - Handles remote GitHub-based APM packages
 */
export class ApmAdapter extends RepositoryAdapter {
  public readonly type = 'apm';

  private readonly config: Required<ApmAdapterConfig>;
  private readonly mapper: ApmPackageMapper;
  private readonly runtime: ApmRuntimeManager;
  private readonly cli: ApmCliWrapper;
  private readonly client: GitHubClient;
  private readonly logger: Logger;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(source: RegistrySource, client?: GitHubClient) {
    super(source);

    // Validate URL format (strict security validation)
    if (!this.isValidGitHubUrl(source.url)) {
      throw new Error(`Invalid GitHub URL: ${source.url}. Use format: https://github.com/owner/repo`);
    }

    // Parse configuration
    const userConfig = (source.config || {}) as ApmAdapterConfig;
    this.config = {
      branch: userConfig.branch || 'main',
      cacheTtl: userConfig.cacheTtl || DEFAULT_CACHE_TTL,
      enableVirtualPackages: userConfig.enableVirtualPackages ?? true
    };

    this.mapper = new ApmPackageMapper();
    this.runtime = ApmRuntimeManager.getInstance();
    this.cli = new ApmCliWrapper();
    this.logger = Logger.getInstance();

    // Use provided client or create default
    this.client = client ?? new GitHubClient({
      sourceUrl: source.url,
      explicitToken: source.token
    });

    this.logger.info(`[ApmAdapter] Initialized for: ${source.url}`);
  }

  /**
   * Validate GitHub URL format
   * Security: Prevents URL injection attacks
   * @param url
   */
  private isValidGitHubUrl(url: string): boolean {
    return GITHUB_URL_PATTERN.test(url);
  }

  /**
   * Ensure APM runtime is available
   */
  private async ensureRuntime(): Promise<void> {
    const status = await this.runtime.getStatus();
    if (!status.installed && !status.uvxAvailable) {
      const success = await this.runtime.setupRuntime();
      if (!success) {
        throw new Error(
          'APM runtime is not available. Please install apm-cli or uv.'
        );
      }
    }
  }

  /**
   * Fetch packages from GitHub using GitHubClient tree API
   */
  private async fetchFromGitHub(): Promise<ApmBundle[]> {
    const bundles: ApmBundle[] = [];

    // Fetch git tree recursively (single API call)
    let tree: TreeEntry[];
    try {
      tree = await this.client.getTree(this.config.branch, true);
    } catch (error) {
      this.logger.warn(`[ApmAdapter] Failed to fetch git tree: ${error}`);
      return [];
    }

    // Find all apm.yml files in root or immediate subdirectories
    const manifestPaths = tree
      .filter((item) => {
        // Root apm.yml
        if (item.path === 'apm.yml') {
          return true;
        }

        // Immediate subdirectory apm.yml (e.g., package-a/apm.yml)
        const parts = item.path.split('/');
        return parts.length === 2 && parts[1] === 'apm.yml' && !SKIP_DIRECTORIES.includes(parts[0]);
      })
      .map((item) => item.path);

    // Fetch each manifest content via GitHubClient
    for (const manifestPath of manifestPaths) {
      const dir = path.dirname(manifestPath);
      const subpath = dir === '.' ? '' : dir;

      const manifest = await this.fetchApmManifest(manifestPath);
      if (manifest) {
        bundles.push(this.mapper.toBundle(manifest, {
          sourceId: this.source.id,
          owner: this.client.owner,
          repo: this.client.repo,
          path: subpath
        }));
      }
    }

    return bundles;
  }

  /**
   * Fetch apm.yml content via GitHubClient
   * @param filePath
   */
  private async fetchApmManifest(filePath: string): Promise<ApmManifest | null> {
    try {
      const content = await this.client.getFileContent(filePath, this.config.branch);
      return yaml.load(content.toString('utf8')) as ApmManifest;
    } catch {
      return null;
    }
  }

  /**
   * Create temporary directory
   */
  private async createTempDir(): Promise<string> {
    const tempBase = path.join(os.tmpdir(), 'prompt-registry-apm');
    await fs.promises.mkdir(tempBase, { recursive: true });
    return fs.promises.mkdtemp(path.join(tempBase, 'install-'));
  }

  /**
   * Cleanup temporary directory
   * @param dir
   */
  private async cleanupTempDir(dir: string): Promise<void> {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      this.logger.warn(`[ApmAdapter] Failed to cleanup: ${dir}`);
    }
  }

  /**
   * Create ZIP archive from installed APM package
   * @param bundle
   * @param installDir
   */
  private createBundleArchive(bundle: Bundle, installDir: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];

      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('finish', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      this.populateArchive(archive, bundle, installDir)
        .then(() => archive.finalize())
        .catch(reject);
    });
  }

  /**
   * Populate archive with manifest and prompt files
   * @param archive
   * @param bundle
   * @param installDir
   */
  private async populateArchive(
    archive: archiver.Archiver,
    bundle: Bundle,
    installDir: string
  ): Promise<void> {
    // Create deployment manifest
    const manifest = await this.createDeploymentManifest(bundle, installDir);
    archive.append(yaml.dump(manifest), { name: 'deployment-manifest.yml' });

    // Add .apm directory if exists
    const apmDir = path.join(installDir, '.apm');
    if (fs.existsSync(apmDir)) {
      archive.directory(apmDir, 'prompts');
    }

    // Add apm_modules content if exists
    const modulesDir = path.join(installDir, 'apm_modules');
    if (fs.existsSync(modulesDir)) {
      const promptFiles = await this.findPromptFiles(modulesDir);
      for (const file of promptFiles) {
        const content = await fs.promises.readFile(file, 'utf8');
        archive.append(content, { name: `prompts/${path.basename(file)}` });
      }
    }

    // Add root-level prompt files
    const rootPrompts = await this.findPromptFiles(installDir, false);
    for (const file of rootPrompts) {
      const content = await fs.promises.readFile(file, 'utf8');
      archive.append(content, { name: `prompts/${path.basename(file)}` });
    }
  }

  /**
   * Create deployment manifest
   * @param bundle
   * @param installDir
   */
  private async createDeploymentManifest(bundle: Bundle, installDir: string): Promise<any> {
    const apmManifestPath = path.join(installDir, 'apm.yml');
    let apmManifest: ApmManifest = { name: bundle.name };

    if (fs.existsSync(apmManifestPath)) {
      const content = await fs.promises.readFile(apmManifestPath, 'utf8');
      apmManifest = yaml.load(content) as ApmManifest || { name: bundle.name };
    }

    const promptFiles = await this.findPromptFiles(installDir);

    const prompts = promptFiles.map((file) => {
      const filename = path.basename(file);
      const id = filename.replace(/\.(prompt|instructions|agent|chatmode)\.md$/, '');

      return {
        id,
        name: titleCase(id.replace(/-/g, ' ')),
        description: `From ${bundle.name}`,
        file: `prompts/${filename}`,
        type: this.detectFileType(filename),
        tags: apmManifest.tags || []
      };
    });

    return {
      metadata: {
        manifest_version: '1.0.0',
        description: bundle.description,
        author: bundle.author
      },
      common: {
        directories: ['prompts'],
        files: [],
        include_patterns: ['**/*.md'],
        exclude_patterns: []
      },
      bundle_settings: {
        include_common_in_environment_bundles: true,
        create_common_bundle: true,
        compression: 'zip' as const,
        naming: {
          common_bundle: bundle.id,
          environment_bundle: `${bundle.id}-{{environment}}`
        }
      },
      prompts
    };
  }

  /**
   * Find prompt files
   * @param dir
   * @param recursive
   */
  private async findPromptFiles(dir: string, recursive = true): Promise<string[]> {
    const files: string[] = [];

    const scan = async (currentDir: string, depth = 0) => {
      if (!recursive && depth > 0) {
        return;
      }
      if (depth > 5) {
        return;
      }

      try {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && !SKIP_DIRECTORIES.includes(entry.name)) {
              await scan(fullPath, depth + 1);
            }
          } else if (PROMPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip unreadable directories
      }
    };

    await scan(dir);
    return files;
  }

  /**
   * Detect file type from extension
   * @param filename
   */
  private detectFileType(filename: string): 'prompt' | 'instructions' | 'chatmode' | 'agent' {
    if (filename.endsWith('.instructions.md')) {
      return 'instructions';
    }
    if (filename.endsWith('.chatmode.md')) {
      return 'chatmode';
    }
    if (filename.endsWith('.agent.md')) {
      return 'agent';
    }
    return 'prompt';
  }

  /**
   * Fetch available bundles from GitHub repository
   */
  public async fetchBundles(): Promise<Bundle[]> {
    this.logger.debug('[ApmAdapter] Fetching bundles...');

    // Check cache
    const cacheKey = this.source.url;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtl) {
      this.logger.debug('[ApmAdapter] Using cached bundles');
      return cached.bundles;
    }

    await this.ensureRuntime();

    try {
      const bundles = await this.fetchFromGitHub();
      this.cache.set(cacheKey, { bundles, timestamp: Date.now() });
      return bundles;
    } catch (error) {
      this.logger.error('[ApmAdapter] Failed to fetch bundles', error as Error);
      throw error;
    }
  }

  /**
   * Download a bundle by installing via APM CLI
   * @param bundle
   */
  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    this.logger.debug(`[ApmAdapter] Downloading: ${bundle.id}`);

    await this.ensureRuntime();

    const packageRef = (bundle as ApmBundle).apmPackageRef || bundle.id;
    const tempDir = await this.createTempDir();

    try {
      // Install using APM CLI (pass source token for private repo access)
      const result = await this.cli.install(packageRef, tempDir, this.source.token);

      if (!result.success) {
        throw new Error(`Failed to install package: ${result.error}`);
      }

      // Create archive from installed package
      return await this.createBundleArchive(bundle, tempDir);
    } finally {
      await this.cleanupTempDir(tempDir);
    }
  }

  /**
   * Fetch source metadata
   */
  public async fetchMetadata(): Promise<SourceMetadata> {
    const bundles = await this.fetchBundles();
    const runtimeStatus = await this.runtime.getStatus();

    return {
      name: `${this.client.owner}/${this.client.repo}`,
      description: `APM packages from ${this.source.url}`,
      bundleCount: bundles.length,
      lastUpdated: new Date().toISOString(),
      version: runtimeStatus.version || '1.0.0'
    };
  }

  /**
   * Validate source
   */
  public async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check runtime
    const runtimeStatus = await this.runtime.getStatus();
    if (!runtimeStatus.installed) {
      errors.push('APM CLI is not installed. Install with: pip install apm-cli');
      return { valid: false, errors, warnings, bundlesFound: 0 };
    }

    // Try to fetch packages
    try {
      const bundles = await this.fetchBundles();
      return {
        valid: true,
        errors: [],
        warnings: bundles.length === 0 ? ['No APM packages found'] : [],
        bundlesFound: bundles.length
      };
    } catch (error) {
      errors.push(`Failed to fetch packages: ${(error as Error).message}`);
      return { valid: false, errors, warnings, bundlesFound: 0 };
    }
  }

  public getManifestUrl(_bundleId: string, _version?: string): string {
    return `https://raw.githubusercontent.com/${this.client.owner}/${this.client.repo}/${this.config.branch}/apm.yml`;
  }

  public getDownloadUrl(bundleId: string, version?: string): string {
    return this.getManifestUrl(bundleId, version);
  }
}
