/**
 * Local folder BundleProvider.
 *
 * Assumes a directory layout where each immediate subfolder is a bundle root
 * containing `deployment-manifest.yml` (or a legacy `collection.yml`).
 *
 * This is the provider the CLI uses to build an index from a cloned hub
 * or a local bundle cache — no VS Code required.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
} from '../../search/types';

const MANIFEST_CANDIDATES = ['deployment-manifest.yml', 'deployment-manifest.yaml', 'collection.yml'];

export interface LocalFolderProviderOptions {
  root: string;
  sourceId?: string;
  sourceType?: string;
  /** Mark all bundles as installed (default true for local folders). */
  installed?: boolean;
}

export class LocalFolderBundleProvider implements BundleProvider {
  private readonly root: string;
  private readonly sourceId: string;
  private readonly sourceType: string;
  private readonly installed: boolean;

  public constructor(opts: LocalFolderProviderOptions) {
    this.root = path.resolve(opts.root);
    this.sourceId = opts.sourceId ?? path.basename(this.root);
    this.sourceType = opts.sourceType ?? 'local';
    this.installed = opts.installed ?? true;
  }

  private bundleDir(ref: BundleRef): string {
    return path.join(this.root, ref.bundleId);
  }

  private findManifest(dir: string): string | null {
    for (const name of MANIFEST_CANDIDATES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async generator required by BundleProvider interface; this implementation is sync.
  public async* listBundles(): AsyncIterable<BundleRef> {
    if (!fs.existsSync(this.root)) {
      return;
    }
    const entries = fs.readdirSync(this.root, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) {
        continue;
      }
      const bundleDir = path.join(this.root, ent.name);
      const manifestPath = this.findManifest(bundleDir);
      if (!manifestPath) {
        continue;
      }
      const manifest = readManifestFile(manifestPath);
      yield {
        sourceId: this.sourceId,
        sourceType: this.sourceType,
        bundleId: (typeof manifest.id === 'string' && manifest.id) || ent.name,
        bundleVersion: (typeof manifest.version === 'string' && manifest.version) || 'latest',
        installed: this.installed
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async required by BundleProvider interface; this implementation reads synchronously.
  public async readManifest(ref: BundleRef): Promise<BundleManifest> {
    const dir = this.bundleDir(ref);
    const manifestPath = this.findManifest(dir);
    if (!manifestPath) {
      throw new Error(`No manifest found in ${dir}`);
    }
    return readManifestFile(manifestPath);
  }

  public readFile(ref: BundleRef, relPath: string): Promise<string> {
    const dir = this.bundleDir(ref);
    const full = path.join(dir, relPath);
    // Prevent path traversal outside the bundle.
    if (!full.startsWith(dir + path.sep)) {
      return Promise.reject(new Error(`Refusing to read outside bundle: ${relPath}`));
    }
    return fs.promises.readFile(full, 'utf8');
  }
}

function readManifestFile(manifestPath: string): BundleManifest {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid manifest: ${manifestPath}`);
  }
  return parsed as BundleManifest;
}
