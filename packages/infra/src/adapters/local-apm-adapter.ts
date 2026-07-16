/**
 * Local APM source adapter — discovers `apm.yml`-described packages from
 * a local directory (a single package at the root, and/or nested
 * packages in subdirectories) instead of installing them via the `apm`
 * CLI from GitHub. Useful for authoring and testing packages locally
 * before publishing.
 *
 * Ported from `src/adapters/local-apm-adapter.ts`. Manifest-to-`Bundle`
 * mapping duplicates `ApmAdapter`'s own small set of pure helpers
 * (`inferEnvironments`/`mapDependencies`/`formatDependencyCount`) rather
 * than sharing a module - matches every adapter ported so far being
 * self-contained (as `ApmAdapter`'s own module doc notes, this mirrors
 * dropping `main`'s separate `ApmPackageMapper` class in favor of
 * inlining it). All disk I/O goes through the injected `FileSystem`
 * port; uses the shared `resolveLocalPath`/`isValidLocalUrl` from
 * `./local-path`. No `apm`/`uvx` CLI involved - packages are already on
 * disk, so there's no `ProcessRunner`/runtime-detection dependency at
 * all, unlike the remote `ApmAdapter`.
 *
 * Deliberate deviations from `main`:
 * - No caching (`main`'s 5-minute `fetchBundles` cache), matching
 *   `LocalAdapter`'s own precedent - for a source explicitly meant for
 *   iterating on local edits, a stale cache actively works against the
 *   use case.
 * - `localPackagePath` is recovered by parsing `Bundle.downloadUrl`
 *   (`file://<packageDir>`) instead of an ad hoc `LocalApmBundle`
 *   subtype field that doesn't exist on `Bundle`'s real type - same fix
 *   pattern as every other ported adapter's `Bundle.downloadUrl`
 *   recovery.
 * - Not fixed: `getManifestUrl`/`getDownloadUrl` assume a bundle's
 *   directory name equals its `bundleId`, which only holds for a
 *   package whose `apm.yml` `name` happens to sanitize to its own
 *   folder name - a pre-existing `main` inaccuracy, and not fixable
 *   without either violating the (synchronous) `getManifestUrl`
 *   contract or introducing an id-to-path cache purely for these
 *   doc-link-only methods (per `IRepositoryAdapter`'s own docs, not
 *   used for the actual download - `downloadBundle` uses
 *   `Bundle.downloadUrl`, computed correctly at listing time).
 * @module adapters/local-apm-adapter
 */
import * as path from 'node:path';
import type {
  Bundle,
  Clock,
  FileSystem,
  RegistrySource,
  SourceMetadata,
  ValidationResult,
} from '@ai-primitives-hub/core';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import {
  BaseSourceAdapter,
} from './base-source-adapter';
import {
  isValidLocalUrl,
  resolveLocalPath,
} from './local-path';

const DEFAULT_MAX_DEPTH = 2;
const PROMPT_EXTENSIONS = ['.prompt.md', '.instructions.md', '.chatmode.md', '.agent.md'];
const SKIP_DIRECTORIES = ['node_modules', 'apm_modules', '.git', 'dist', 'build', 'out'];
const MAX_SCAN_DEPTH = 5;

const ENV_TAG_MAP: Record<string, string> = {
  azure: 'cloud',
  aws: 'cloud',
  gcp: 'cloud',
  frontend: 'web',
  backend: 'server',
  devops: 'infrastructure',
  testing: 'testing',
  security: 'security'
};

interface ApmManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  tags?: string[];
  license?: string;
  dependencies?: {
    apm?: string[];
    mcp?: string[];
  };
}

interface LocalApmConfig {
  scanSubdirectories?: boolean;
  maxDepth?: number;
}

function inferEnvironments(tags?: string[]): string[] {
  if (!tags || tags.length === 0) {
    return ['general'];
  }
  const environments = new Set<string>();
  for (const tag of tags) {
    const environment = ENV_TAG_MAP[tag.toLowerCase()];
    if (environment) {
      environments.add(environment);
    }
  }
  return environments.size > 0 ? [...environments] : ['general'];
}

function mapDependencies(apmDeps?: string[]): Bundle['dependencies'] {
  if (!apmDeps || apmDeps.length === 0) {
    return [];
  }
  return apmDeps.map((dep) => ({ bundleId: dep, versionRange: '*', optional: false }));
}

function formatDependencyCount(deps?: string[]): string {
  const count = deps?.length ?? 0;
  if (count === 0) {
    return 'No dependencies';
  }
  return `${count} dependenc${count === 1 ? 'y' : 'ies'}`;
}

function titleCase(value: string): string {
  return value
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function detectFileType(filename: string): 'prompt' | 'instructions' | 'chatmode' | 'agent' {
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

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

export class LocalApmAdapter extends BaseSourceAdapter {
  public readonly type = 'local-apm';

  private readonly scanSubdirectories: boolean;
  private readonly maxDepth: number;

  public constructor(
    source: RegistrySource,
    private readonly fs: FileSystem,
    private readonly clock: Clock
  ) {
    super(source);
    if (!isValidLocalUrl(source.url)) {
      throw new Error(`Invalid local path: ${source.url}. Use absolute path, ~/path, or file:// URL`);
    }
    const config = source.config as LocalApmConfig | undefined;
    this.scanSubdirectories = config?.scanSubdirectories ?? true;
    this.maxDepth = config?.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  private getLocalPath(): string {
    return resolveLocalPath(this.source.url);
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    if (!(await this.fs.exists(dirPath))) {
      return false;
    }
    return (await this.fs.stat(dirPath)).isDirectory;
  }

  private async readApmManifest(dir: string): Promise<ApmManifest | undefined> {
    try {
      return yaml.load(await this.fs.readFile(path.join(dir, 'apm.yml'))) as ApmManifest;
    } catch {
      return undefined;
    }
  }

  private buildBundleId(packageName: string): string {
    return `local-${sanitizeId(packageName)}`;
  }

  private manifestToBundle(manifest: ApmManifest, packageDir: string): Bundle {
    const packageName = manifest.name || path.basename(packageDir);
    const tags = (manifest.tags ? [...manifest.tags] : []).filter((tag) => tag !== 'apm');
    tags.push('apm', 'local');

    return {
      id: this.buildBundleId(packageName),
      name: manifest.name,
      version: manifest.version ?? '1.0.0',
      description: manifest.description ?? `Local APM package from ${packageDir}`,
      author: manifest.author ?? 'Local Developer',
      sourceId: this.source.id,
      environments: inferEnvironments(manifest.tags),
      tags,
      lastUpdated: this.clock.nowIso(),
      size: formatDependencyCount(manifest.dependencies?.apm),
      dependencies: mapDependencies(manifest.dependencies?.apm),
      license: manifest.license ?? 'MIT',
      manifestUrl: `file://${path.join(packageDir, 'apm.yml')}`,
      downloadUrl: `file://${packageDir}`,
      repository: `file://${this.getLocalPath()}`
    };
  }

  private async scanSubdirectoriesFor(baseDir: string, currentDepth: number): Promise<Bundle[]> {
    if (currentDepth > this.maxDepth) {
      return [];
    }

    let entries;
    try {
      entries = await this.fs.readDirEntries(baseDir);
    } catch {
      return [];
    }

    const bundles: Bundle[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.startsWith('.') || SKIP_DIRECTORIES.includes(entry.name)) {
        continue;
      }
      const subdir = path.join(baseDir, entry.name);
      const manifest = await this.readApmManifest(subdir);
      if (manifest) {
        bundles.push(this.manifestToBundle(manifest, subdir));
      } else if (currentDepth < this.maxDepth) {
        bundles.push(...(await this.scanSubdirectoriesFor(subdir, currentDepth + 1)));
      }
    }
    return bundles;
  }

  private async findPromptFiles(dir: string, recursive: boolean): Promise<string[]> {
    const files: string[] = [];
    const scan = async (currentDir: string, depth: number): Promise<void> => {
      if ((!recursive && depth > 0) || depth > MAX_SCAN_DEPTH) {
        return;
      }
      let entries;
      try {
        entries = await this.fs.readDirEntries(currentDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory) {
          if (!entry.name.startsWith('.') && !SKIP_DIRECTORIES.includes(entry.name)) {
            await scan(fullPath, depth + 1);
          }
        } else if (PROMPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    };
    await scan(dir, 0);
    return files;
  }

  private async listFilesRecursively(dirPath: string, relativePrefix = ''): Promise<string[]> {
    const entries = await this.fs.readDirEntries(dirPath);
    const results: string[] = [];
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        results.push(...(await this.listFilesRecursively(path.join(dirPath, entry.name), relativePath)));
      } else {
        results.push(relativePath);
      }
    }
    return results;
  }

  private async createDeploymentManifest(bundle: Bundle, packageDir: string): Promise<Record<string, unknown>> {
    const apmManifest = (await this.readApmManifest(packageDir)) ?? { name: bundle.name };
    const promptFiles = await this.findPromptFiles(packageDir, true);
    const prompts = promptFiles.map((file) => {
      const filename = path.basename(file);
      const id = filename.replace(/\.(prompt|instructions|agent|chatmode)\.md$/, '');
      return {
        id,
        name: titleCase(id.replace(/-/g, ' ')),
        description: `From ${bundle.name}`,
        file: `prompts/${filename}`,
        type: detectFileType(filename),
        tags: apmManifest.tags ?? []
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

  private async createBundleArchive(bundle: Bundle, packageDir: string): Promise<Buffer> {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));

    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(new Error(`Failed to create ZIP archive: ${err.message}`)));
    });

    archive.append(yaml.dump(await this.createDeploymentManifest(bundle, packageDir)), { name: 'deployment-manifest.yml' });

    const apmDir = path.join(packageDir, '.apm');
    if (await this.fs.exists(apmDir)) {
      for (const relativePath of await this.listFilesRecursively(apmDir)) {
        archive.append(await this.fs.readFile(path.join(apmDir, relativePath)), { name: `prompts/${relativePath}` });
      }
    }

    for (const file of await this.findPromptFiles(packageDir, false)) {
      archive.append(await this.fs.readFile(file), { name: `prompts/${path.basename(file)}` });
    }

    await archive.finalize();
    return finished;
  }

  public requiresAuthentication(): boolean {
    return false;
  }

  public async fetchBundles(): Promise<Bundle[]> {
    const localPath = this.getLocalPath();
    if (!(await this.directoryExists(localPath))) {
      throw new Error(`Local APM packages directory not found: ${localPath}`);
    }

    const bundles: Bundle[] = [];
    const rootManifest = await this.readApmManifest(localPath);
    if (rootManifest) {
      bundles.push(this.manifestToBundle(rootManifest, localPath));
    }
    if (this.scanSubdirectories) {
      bundles.push(...(await this.scanSubdirectoriesFor(localPath, 1)));
    }
    return bundles;
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const packageDir = bundle.downloadUrl.startsWith('file://') ? bundle.downloadUrl.slice('file://'.length) : bundle.downloadUrl;
    if (!(await this.directoryExists(packageDir))) {
      throw new Error(`Package directory not found: ${packageDir}`);
    }
    return this.createBundleArchive(bundle, packageDir);
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    const localPath = this.getLocalPath();
    if (!(await this.directoryExists(localPath))) {
      throw new Error(`Directory not found: ${localPath}`);
    }

    const bundles = await this.fetchBundles();
    const stats = await this.fs.stat(localPath);
    return {
      name: path.basename(localPath),
      description: `Local APM packages from ${localPath}`,
      bundleCount: bundles.length,
      lastUpdated: new Date(stats.mtimeMs).toISOString(),
      version: '1.0.0'
    };
  }

  public async validate(): Promise<ValidationResult> {
    const localPath = this.getLocalPath();
    if (!(await this.directoryExists(localPath))) {
      return { valid: false, errors: [`Directory does not exist: ${localPath}`], warnings: [], bundlesFound: 0 };
    }

    try {
      const bundles = await this.fetchBundles();
      return {
        valid: true,
        errors: [],
        warnings: bundles.length === 0 ? ['No apm.yml files found in directory'] : [],
        bundlesFound: bundles.length
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Validation failed: ${error instanceof Error ? error.message : error}`],
        warnings: [],
        bundlesFound: 0
      };
    }
  }

  public getManifestUrl(bundleId: string): string {
    return `file://${path.join(this.getLocalPath(), bundleId, 'apm.yml')}`;
  }

  public getDownloadUrl(bundleId: string): string {
    return this.getManifestUrl(bundleId);
  }
}
