/**
 * LocalApmAdapter
 *
 * Fetches APM packages from local filesystem directories.
 * Useful for testing packages before publishing.
 *
 * Directory Structure (single package):
 * ```
 * /home/user/my-apm-package/
 *   apm.yml
 *   .apm/
 *     prompts/
 *       my-prompt.prompt.md
 *     instructions/
 *       my-rules.instructions.md
 * ```
 *
 * Directory Structure (monorepo):
 * ```
 * /home/user/apm-packages/
 *   package-a/
 *     apm.yml
 *     .apm/...
 *   package-b/
 *     apm.yml
 *     .apm/...
 * ```
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import {
  Bundle,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '../types/registry';
import {
  generateSanitizedId,
} from '../utils/bundle-name-utils';
import {
  ApmManifest,
  ApmPackageMapper,
} from './apm-package-mapper';
import {
  RepositoryAdapter,
} from './repository-adapter';

/**
 * Configuration options for LocalApmAdapter
 */
export interface LocalApmConfig {
  /** Scan subdirectories for multiple packages (default: true) */
  scanSubdirectories?: boolean;
  /** Maximum scan depth for subdirectories (default: 2) */
  maxDepth?: number;
}

/**
 * Extended bundle type with local path information
 */
interface LocalApmBundle extends Bundle {
  localPackagePath: string;
}

/**
 * Prompt file types supported by APM
 */
const PROMPT_EXTENSIONS = ['.prompt.md', '.instructions.md', '.chatmode.md', '.agent.md'];

/**
 * Directories to skip when scanning
 */
const SKIP_DIRECTORIES = ['node_modules', 'apm_modules', '.git', 'dist', 'build', 'out'];

/**
 * Cache TTL in milliseconds (5 minutes)
 */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * LocalApmAdapter - Handles local filesystem APM packages
 */
export class LocalApmAdapter extends RepositoryAdapter {
  public readonly type = 'local-apm';

  private readonly config: Required<LocalApmConfig>;
  private readonly mapper: ApmPackageMapper;
  private readonly cache: Map<string, { bundles: LocalApmBundle[]; timestamp: number }> = new Map();

  constructor(source: RegistrySource) {
    super(source);

    // Validate URL format
    if (!this.isValidLocalPath(source.url)) {
      throw new Error(`Invalid local path: ${source.url}. Use absolute path, ~/path, or file:// URL`);
    }

    // Parse configuration
    const userConfig = (source.config || {}) as LocalApmConfig;
    this.config = {
      scanSubdirectories: userConfig.scanSubdirectories ?? true,
      maxDepth: userConfig.maxDepth ?? 2
    };

    this.mapper = new ApmPackageMapper();
  }

  /**
   * Validate that URL is a valid local path format
   * Security: Only allow local filesystem paths
   * @param url
   */
  private isValidLocalPath(url: string): boolean {
    return url.startsWith('file://')
      || path.isAbsolute(url)
      || url.startsWith('~/')
      || url.startsWith('./');
  }

  /**
   * Get normalized local directory path from URL
   * Security: Normalizes path to prevent traversal
   */
  private getLocalPath(): string {
    let localPath = this.source.url;

    // Handle file:// URLs
    if (localPath.startsWith('file://')) {
      localPath = localPath.substring(7);
    }

    // Expand ~ to home directory
    if (localPath.startsWith('~/')) {
      localPath = path.join(os.homedir(), localPath.substring(2));
    }

    // Normalize to prevent path traversal
    return path.normalize(localPath);
  }

  /**
   * Check if directory exists and is accessible
   * @param dirPath
   */
  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      await fs.promises.access(dirPath, fs.constants.R_OK);
      const stats = await fs.promises.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Scan subdirectories for APM packages
   * Security: Skips hidden directories and known non-package directories
   * @param baseDir
   * @param currentDepth
   */
  private async scanSubdirectories(
    baseDir: string,
    currentDepth: number
  ): Promise<LocalApmBundle[]> {
    if (currentDepth > this.config.maxDepth) {
      return [];
    }

    const bundles: LocalApmBundle[] = [];

    try {
      const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip non-directories
        if (!entry.isDirectory()) {
          continue;
        }

        // Security: Skip hidden directories
        if (entry.name.startsWith('.')) {
          continue;
        }

        // Security: Skip known non-package directories
        if (SKIP_DIRECTORIES.includes(entry.name)) {
          continue;
        }

        const subdir = path.join(baseDir, entry.name);
        const manifest = await this.readApmManifest(subdir);

        if (manifest) {
          const relativePath = path.relative(this.getLocalPath(), subdir);
          bundles.push(this.manifestToBundle(manifest, subdir, relativePath));
        } else if (currentDepth < this.config.maxDepth) {
          // Recurse into subdirectory
          const nested = await this.scanSubdirectories(subdir, currentDepth + 1);
          bundles.push(...nested);
        }
      }
    } catch {
      // Silently skip directories we can't read
    }

    return bundles;
  }

  /**
   * Read and parse apm.yml from a directory
   * @param dir
   */
  private async readApmManifest(dir: string): Promise<ApmManifest | null> {
    const manifestPath = path.join(dir, 'apm.yml');

    try {
      const content = await fs.promises.readFile(manifestPath, 'utf8');
      return yaml.load(content) as ApmManifest;
    } catch {
      return null;
    }
  }

  /**
   * Convert APM manifest to Bundle with local path info
   * @param manifest
   * @param packageDir
   * @param relativePath
   */
  private manifestToBundle(
    manifest: ApmManifest,
    packageDir: string,
    relativePath: string
  ): LocalApmBundle {
    const localPath = this.getLocalPath();
    const packageName = manifest.name || path.basename(packageDir);

    // Create context for mapper (use local- prefix for owner)
    const context = {
      sourceId: this.source.id,
      owner: 'local',
      repo: generateSanitizedId(packageName),
      path: relativePath
    };

    // Get base bundle from mapper
    const baseBundle = this.mapper.toBundle(manifest, context);

    // Override URLs with local file:// paths
    const localBundle: LocalApmBundle = {
      ...baseBundle,
      // Override with local-specific values
      tags: [...(baseBundle.tags.filter((t) => t !== 'apm')), 'apm', 'local'],
      downloadUrl: `file://${packageDir}`,
      manifestUrl: `file://${path.join(packageDir, 'apm.yml')}`,
      repository: `file://${localPath}`,
      localPackagePath: packageDir
    };

    return localBundle;
  }

  /**
   * Create ZIP archive from local APM package
   * @param bundle
   * @param packageDir
   */
  private createBundleArchive(bundle: Bundle, packageDir: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const chunks: Buffer[] = [];

      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('finish', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      // Process archive asynchronously
      this.populateArchive(archive, bundle, packageDir)
        .then(() => archive.finalize())
        .catch(reject);
    });
  }

  /**
   * Populate archive with deployment manifest and prompt files
   * @param archive
   * @param bundle
   * @param packageDir
   */
  private async populateArchive(
    archive: archiver.Archiver,
    bundle: Bundle,
    packageDir: string
  ): Promise<void> {
    // Create deployment manifest
    const deploymentManifest = await this.createDeploymentManifest(bundle, packageDir);
    archive.append(yaml.dump(deploymentManifest), { name: 'deployment-manifest.yml' });

    // Add .apm directory contents
    const apmDir = path.join(packageDir, '.apm');
    if (fs.existsSync(apmDir)) {
      archive.directory(apmDir, 'prompts');
    }

    // Add root-level prompt files
    const rootPrompts = await this.findPromptFiles(packageDir, false);
    for (const file of rootPrompts) {
      const content = await fs.promises.readFile(file, 'utf8');
      archive.append(content, { name: `prompts/${path.basename(file)}` });
    }
  }

  /**
   * Create deployment manifest from APM manifest
   * @param bundle
   * @param packageDir
   */
  private async createDeploymentManifest(bundle: Bundle, packageDir: string): Promise<any> {
    const apmManifest: ApmManifest = await this.readApmManifest(packageDir) || { name: bundle.name };
    const promptFiles = await this.findPromptFiles(packageDir, true);

    const prompts = promptFiles.map((file) => {
      const filename = path.basename(file);
      const id = filename.replace(/\.(prompt|instructions|agent|chatmode)\.md$/, '');

      return {
        id,
        name: this.titleCase(id.replace(/-/g, ' ')),
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
   * Find all prompt files in package directory
   * @param dir Directory to search
   * @param recursive Whether to search recursively
   */
  private async findPromptFiles(dir: string, recursive: boolean): Promise<string[]> {
    const files: string[] = [];

    const scan = async (currentDir: string, depth = 0) => {
      if (!recursive && depth > 0) {
        return;
      }
      if (depth > 5) {
        return;
      } // Limit recursion depth for safety

      try {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            // Security: Skip hidden and excluded directories
            if (!entry.name.startsWith('.')
              && !SKIP_DIRECTORIES.includes(entry.name)) {
              await scan(fullPath, depth + 1);
            }
          } else if (PROMPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
            files.push(fullPath);
          }
        }
      } catch {
        // Silently skip directories we can't read
      }
    };

    await scan(dir);
    return files;
  }

  /**
   * Detect file type from filename
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
   * Convert string to title case
   * @param str
   */
  private titleCase(str: string): string {
    return str.split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Fetch list of available bundles from local filesystem
   */
  public async fetchBundles(): Promise<Bundle[]> {
    const cacheKey = this.source.url;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.bundles;
    }

    const localPath = this.getLocalPath();

    // Validate directory exists
    const exists = await this.directoryExists(localPath);
    if (!exists) {
      throw new Error(`Local APM packages directory not found: ${localPath}`);
    }

    const bundles: LocalApmBundle[] = [];

    // Check if root has apm.yml (single package)
    const rootManifest = await this.readApmManifest(localPath);
    if (rootManifest) {
      const bundle = this.manifestToBundle(rootManifest, localPath, '');
      bundles.push(bundle);
    }

    // Scan subdirectories if enabled
    if (this.config.scanSubdirectories) {
      const subdirBundles = await this.scanSubdirectories(localPath, 1);
      bundles.push(...subdirBundles);
    }

    this.cache.set(cacheKey, { bundles, timestamp: Date.now() });
    return bundles;
  }

  /**
   * Download a bundle by creating ZIP from local directory
   * @param bundle
   */
  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const packageDir = (bundle as LocalApmBundle).localPackagePath;

    if (!packageDir) {
      throw new Error(`No local path for bundle: ${bundle.id}`);
    }

    const exists = await this.directoryExists(packageDir);
    if (!exists) {
      throw new Error(`Package directory not found: ${packageDir}`);
    }

    return this.createBundleArchive(bundle, packageDir);
  }

  /**
   * Fetch source metadata
   */
  public async fetchMetadata(): Promise<SourceMetadata> {
    const localPath = this.getLocalPath();

    const exists = await this.directoryExists(localPath);
    if (!exists) {
      throw new Error(`Directory not found: ${localPath}`);
    }

    const bundles = await this.fetchBundles();

    let lastModified = new Date().toISOString();
    try {
      const stats = await fs.promises.stat(localPath);
      lastModified = stats.mtime.toISOString();
    } catch {
      // Use current time if stat fails
    }

    return {
      name: path.basename(localPath),
      description: `Local APM packages from ${localPath}`,
      bundleCount: bundles.length,
      lastUpdated: lastModified,
      version: '1.0.0'
    };
  }

  /**
   * Validate local directory
   */
  public async validate(): Promise<ValidationResult> {
    const localPath = this.getLocalPath();

    const exists = await this.directoryExists(localPath);
    if (!exists) {
      return {
        valid: false,
        errors: [`Directory does not exist: ${localPath}`],
        warnings: [],
        bundlesFound: 0
      };
    }

    try {
      const bundles = await this.fetchBundles();

      return {
        valid: true,
        errors: [],
        warnings: bundles.length === 0
          ? ['No apm.yml files found in directory']
          : [],
        bundlesFound: bundles.length
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Validation failed: ${(error as Error).message}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  public getManifestUrl(bundleId: string, _version?: string): string {
    const localPath = this.getLocalPath();
    return `file://${path.join(localPath, bundleId, 'apm.yml')}`;
  }

  public getDownloadUrl(bundleId: string, version?: string): string {
    return this.getManifestUrl(bundleId, version);
  }
}
