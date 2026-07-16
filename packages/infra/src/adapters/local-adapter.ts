/**
 * Local filesystem source adapter.
 *
 * Re-implementation of `src/adapters/local-adapter.ts`'s behavior against
 * `@ai-primitives-hub/core`'s `SourceAdapter` port and `FileSystem` port —
 * no direct `node:fs` access, so the whole adapter is testable with an
 * in-memory double (`test/helpers/in-memory-filesystem.ts`). `node:path` is
 * used directly: pure path arithmetic has no state to mock.
 *
 * One behavioral difference from `main`: `downloadBundle` builds the ZIP by
 * reading each file through the injected `FileSystem` (text-mode) rather
 * than pointing `archiver` at a real directory on disk. This keeps the
 * whole adapter unit-testable without a real filesystem, at the cost of
 * not yet supporting binary files in a bundle — everything in the
 * `prompt`/`instruction`/`chat-mode`/`agent`/`skill` primitive kinds is
 * text today. Revisit (add a binary-safe `FileSystem.readFileBuffer`) if a
 * real bundle ever needs one.
 * @module adapters/local-adapter
 */
import * as path from 'node:path';
import type {
  Bundle,
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

interface LocalManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  environments?: string[];
  tags?: string[];
  size?: string;
  dependencies?: {
    bundleId: string;
    versionRange: string;
    optional: boolean;
  }[];
  license?: string;
}

const MANIFEST_FILE_NAME = 'deployment-manifest.yml';
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

export class LocalAdapter extends BaseSourceAdapter {
  public readonly type = 'local';

  public constructor(
    source: RegistrySource,
    private readonly fs: FileSystem
  ) {
    super(source);
    if (!LocalAdapter.isValidLocalUrl(source.url)) {
      throw new Error(`Invalid local path: ${source.url}`);
    }
  }

  private getLocalPath(): string {
    return path.normalize(stripFileProtocol(this.source.url));
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    if (!(await this.fs.exists(dirPath))) {
      return false;
    }
    const stats = await this.fs.stat(dirPath);
    return stats.isDirectory;
  }

  private async getBundleDirectories(): Promise<string[]> {
    const localPath = this.getLocalPath();
    if (!(await this.directoryExists(localPath))) {
      throw new Error(`Cannot access local directory: ${localPath}`);
    }

    const entries = await this.fs.readDirEntries(localPath);
    const bundleDirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory) {
        continue;
      }
      const bundleDir = path.join(localPath, entry.name);
      if (await this.fs.exists(path.join(bundleDir, MANIFEST_FILE_NAME))) {
        bundleDirs.push(bundleDir);
      }
    }
    return bundleDirs;
  }

  /**
   * Relative file paths (POSIX-style `/` separators) under `dirPath`.
   * @param dirPath - Directory to walk, as an absolute path.
   * @param relativePrefix - Path prefix accumulated so far during recursion;
   * callers should omit this and let recursive calls populate it.
   */
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

  private async calculateDirectorySize(dirPath: string): Promise<number> {
    const relativeFilePaths = await this.listFilesRecursively(dirPath);
    let totalSize = 0;
    for (const relativePath of relativeFilePaths) {
      const stats = await this.fs.stat(path.join(dirPath, relativePath));
      totalSize += stats.size;
    }
    return totalSize;
  }

  /**
   * Check if a URL/path is an acceptable local-adapter source: a `file://`
   * URL, an absolute path, or a `~/`/`./`-relative path.
   * @param url - Candidate source URL.
   */
  public static isValidLocalUrl(url: string): boolean {
    return url.startsWith('file://') || path.isAbsolute(url) || url.startsWith('~/') || url.startsWith('./');
  }

  public requiresAuthentication(): boolean {
    return false;
  }

  public getManifestUrl(bundleId: string): string {
    return `file://${path.join(this.getLocalPath(), bundleId, MANIFEST_FILE_NAME)}`;
  }

  public getDownloadUrl(bundleId: string): string {
    return `file://${path.join(this.getLocalPath(), bundleId)}`;
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    const localPath = this.getLocalPath();
    if (!(await this.directoryExists(localPath))) {
      throw new Error(`Directory does not exist: ${localPath}`);
    }

    const bundleDirs = await this.getBundleDirectories();
    let metadata = {
      name: path.basename(localPath),
      description: 'Local bundle registry',
      version: '1.0.0'
    };

    const registryPath = path.join(localPath, 'registry.json');
    if (await this.fs.exists(registryPath)) {
      const registryData = await this.fs.readJson<Partial<typeof metadata>>(registryPath);
      metadata = {
        name: registryData.name ?? metadata.name,
        description: registryData.description ?? metadata.description,
        version: registryData.version ?? metadata.version
      };
    }

    const stats = await this.fs.stat(localPath);
    return {
      name: metadata.name,
      description: metadata.description,
      bundleCount: bundleDirs.length,
      lastUpdated: new Date(stats.mtimeMs).toISOString(),
      version: metadata.version
    };
  }

  public async fetchBundles(): Promise<Bundle[]> {
    const bundleDirs = await this.getBundleDirectories();
    const bundles: Bundle[] = [];

    for (const bundleDir of bundleDirs) {
      const manifestPath = path.join(bundleDir, MANIFEST_FILE_NAME);
      try {
        const manifest = yaml.load(await this.fs.readFile(manifestPath)) as LocalManifest;
        // Stat the manifest file, not the bundle directory: directory mtime
        // is unreliable (many filesystems only bump it when entries are
        // added/removed, not when a nested file's contents change).
        const stats = await this.fs.stat(manifestPath);
        const size = await this.calculateDirectorySize(bundleDir);
        const declaredSize = manifest.size;

        bundles.push({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author,
          sourceId: this.source.id,
          environments: manifest.environments ?? [],
          tags: manifest.tags ?? [],
          lastUpdated: new Date(stats.mtimeMs).toISOString(),
          size: declaredSize !== undefined && declaredSize !== '' ? declaredSize : formatSize(size),
          dependencies: manifest.dependencies ?? [],
          license: manifest.license ?? 'Unknown',
          downloadUrl: `file://${bundleDir}`,
          manifestUrl: `file://${manifestPath}`
        });
      } catch {
        // Skip bundles with an unreadable/malformed manifest; other bundles
        // in the same source should still load.
        continue;
      }
    }

    return bundles;
  }

  public async validate(): Promise<ValidationResult> {
    const localPath = this.getLocalPath();
    if (!(await this.directoryExists(localPath))) {
      return { valid: false, errors: [`Directory does not exist: ${localPath}`], warnings: [] };
    }

    const bundleDirs = await this.getBundleDirectories();
    if (bundleDirs.length === 0) {
      return { valid: true, errors: [], warnings: ['No bundles found in directory'] };
    }

    return { valid: true, errors: [], warnings: [] };
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const bundlePath = stripFileProtocol(bundle.downloadUrl);
    if (!(await this.directoryExists(bundlePath))) {
      throw new Error(`Bundle directory not found: ${bundlePath}`);
    }

    const relativeFilePaths = await this.listFilesRecursively(bundlePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));

    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(new Error(`Failed to create ZIP archive: ${err.message}`)));
    });

    for (const relativePath of relativeFilePaths) {
      const contents = await this.fs.readFile(path.join(bundlePath, relativePath));
      archive.append(contents, { name: relativePath });
    }
    await archive.finalize();

    return finished;
  }
}

function stripFileProtocol(url: string): string {
  return url.startsWith('file://') ? url.slice('file://'.length) : url;
}

function formatSize(bytes: number): string {
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${SIZE_UNITS[unitIndex]}`;
}
