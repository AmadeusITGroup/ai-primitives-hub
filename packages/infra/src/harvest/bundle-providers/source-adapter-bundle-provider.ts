/**
 * BundleProvider bridge for catalog-style SourceAdapters.
 *
 * SourceAdapter exposes rich bundle metadata and downloadable archives,
 * whereas the primitive harvester needs a BundleProvider that can enumerate
 * refs and read manifest/files. This adapter keeps that translation in infra
 * so CLI and VS Code can share it.
 * @module harvest/bundle-providers/source-adapter-bundle-provider
 */
import type {
  Bundle,
  BundleExtractor,
  BundleManifest,
  BundleProvider,
  BundleRef,
  SourceAdapter,
} from '@ai-primitives-hub/core';
import {
  load as parseYaml,
} from 'js-yaml';
import {
  ZipBundleExtractor,
} from '../../extractors/zip-bundle-extractor';

const MANIFEST_CANDIDATES = [
  'deployment-manifest.yml',
  'deployment-manifest.yaml',
  'collection.yml'
] as const;

export interface SourceAdapterBundleProviderOptions {
  adapter: SourceAdapter;
  /** Optional extractor; defaults to the production ZIP extractor. */
  extractor?: BundleExtractor;
  /** Optional policy used to project current installation state onto refs. */
  isInstalled?: (bundle: Bundle) => boolean;
}

/**
 * Adapts one catalog source into a primitive-harvest provider.
 *
 * Archives are extracted once per bundle and retained for the lifetime of the
 * provider. A fresh provider should be created after a source sync so the
 * catalog and archive cache represent the same source revision.
 */
export class SourceAdapterBundleProvider implements BundleProvider {
  private readonly adapter: SourceAdapter;
  private readonly extractor: BundleExtractor;
  private readonly isInstalled: (bundle: Bundle) => boolean;
  private bundles?: Bundle[];
  private readonly extracted = new Map<string, ReadonlyMap<string, Uint8Array>>();

  public constructor(options: SourceAdapterBundleProviderOptions) {
    this.adapter = options.adapter;
    this.extractor = options.extractor ?? createDefaultExtractor();
    this.isInstalled = options.isInstalled ?? (() => false);
  }

  private async loadBundles(): Promise<Bundle[]> {
    this.bundles ??= await this.adapter.fetchBundles();
    return this.bundles;
  }

  private async loadFiles(ref: BundleRef): Promise<ReadonlyMap<string, Uint8Array>> {
    const key = bundleKey(ref);
    const cached = this.extracted.get(key);
    if (cached) {
      return cached;
    }

    const bundles = await this.loadBundles();
    const bundle = bundles.find((candidate) =>
      candidate.id === ref.bundleId && candidate.version === ref.bundleVersion
    );
    if (!bundle) {
      throw new Error(`Bundle ${ref.bundleId}@${ref.bundleVersion} is not available from source ${ref.sourceId}`);
    }

    const files = await this.extractor.extract(await this.adapter.downloadBundle(bundle));
    this.extracted.set(key, files);
    return files;
  }

  public async* listBundles(): AsyncIterable<BundleRef> {
    const bundles = await this.loadBundles();
    for (const bundle of bundles) {
      yield {
        sourceId: this.adapter.source.id,
        sourceType: this.adapter.source.type,
        bundleId: bundle.id,
        bundleVersion: bundle.version,
        installed: this.isInstalled(bundle)
      };
    }
  }

  public async readManifest(ref: BundleRef): Promise<BundleManifest> {
    const files = await this.loadFiles(ref);
    const raw = findFile(files, MANIFEST_CANDIDATES);
    if (!raw) {
      throw new Error(`Bundle ${ref.bundleId}@${ref.bundleVersion} has no deployment manifest`);
    }

    try {
      return parseManifest(raw);
    } catch (error) {
      throw new Error(
        `Failed to parse manifest for ${ref.bundleId}@${ref.bundleVersion}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  public async readFile(ref: BundleRef, relPath: string): Promise<string> {
    const normalized = normalizeRelativePath(relPath);
    const files = await this.loadFiles(ref);
    const raw = findFile(files, [normalized]);
    if (!raw) {
      throw new Error(`Bundle ${ref.bundleId}@${ref.bundleVersion} has no file ${relPath}`);
    }
    return new TextDecoder().decode(raw);
  }
}

function bundleKey(ref: BundleRef): string {
  return `${ref.sourceId}\u0000${ref.bundleId}\u0000${ref.bundleVersion}`;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Refusing to read unsafe bundle path: ${value}`);
  }

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(`Refusing to read unsafe bundle path: ${value}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new Error(`Refusing to read empty bundle path: ${value}`);
  }
  return segments.join('/');
}

function findFile(
  files: ReadonlyMap<string, Uint8Array>,
  requestedPaths: readonly string[]
): Uint8Array | undefined {
  const normalizedPaths = requestedPaths.map((value) => normalizeRelativePath(value));
  for (const requested of normalizedPaths) {
    const exact = files.get(requested);
    if (exact) {
      return exact;
    }

    const suffix = `/${requested}`;
    const matches = [...files.entries()].filter(([name]) => name.endsWith(suffix));
    if (matches.length === 1) {
      return matches[0][1];
    }
    if (matches.length > 1) {
      throw new Error(`Bundle contains multiple files matching ${requested}`);
    }
  }
  return undefined;
}

function parseManifest(raw: Uint8Array): BundleManifest {
  const parsed = parseYaml(new TextDecoder().decode(raw));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('manifest must contain a YAML object');
  }
  return parsed as BundleManifest;
}

function createDefaultExtractor(): BundleExtractor {
  return new ZipBundleExtractor();
}
