/**
 * Composite BundleProvider for indexing multiple configured sources.
 * @module harvest/bundle-providers/composite-bundle-provider
 */
import type {
  BundleManifest,
  BundleProvider,
  BundleRef,
} from '@ai-primitives-hub/core';

export interface CompositeBundleProviderEntry {
  sourceId: string;
  provider: BundleProvider;
}

export interface CompositeBundleProviderOptions {
  /** Called when one source cannot enumerate its bundles. */
  onSourceError?: (sourceId: string, error: unknown) => void;
}

/** An error encountered while enumerating one configured source. */
export interface CompositeBundleProviderSourceError {
  sourceId: string;
  error: unknown;
}

/**
 * Routes each BundleRef to the provider responsible for its source.
 */
export class CompositeBundleProvider implements BundleProvider {
  private readonly entries: readonly CompositeBundleProviderEntry[];
  private readonly bySource: ReadonlyMap<string, BundleProvider>;
  private readonly onSourceError?: CompositeBundleProviderOptions['onSourceError'];
  private sourceErrors: CompositeBundleProviderSourceError[] = [];

  public constructor(
    entries: readonly CompositeBundleProviderEntry[],
    options: CompositeBundleProviderOptions = {}
  ) {
    const bySource = new Map<string, BundleProvider>();
    for (const entry of entries) {
      if (bySource.has(entry.sourceId)) {
        throw new Error(`Multiple bundle providers configured for source ${entry.sourceId}`);
      }
      bySource.set(entry.sourceId, entry.provider);
    }
    this.entries = [...entries];
    this.bySource = bySource;
    this.onSourceError = options.onSourceError;
  }

  private providerFor(ref: BundleRef): BundleProvider {
    const provider = this.bySource.get(ref.sourceId);
    if (!provider) {
      throw new Error(`No bundle provider configured for source ${ref.sourceId}`);
    }
    return provider;
  }

  /** Source IDs configured for this index lifecycle operation. */
  public getSourceIds(): readonly string[] {
    return this.entries.map((entry) => entry.sourceId);
  }

  /** Enumeration failures observed during the latest bundle traversal. */
  public getSourceErrors(): readonly CompositeBundleProviderSourceError[] {
    return this.sourceErrors;
  }

  public async* listBundles(): AsyncIterable<BundleRef> {
    this.sourceErrors = [];
    for (const entry of this.entries) {
      try {
        for await (const ref of entry.provider.listBundles()) {
          yield ref;
        }
      } catch (error) {
        this.sourceErrors.push({ sourceId: entry.sourceId, error });
        this.onSourceError?.(entry.sourceId, error);
      }
    }
  }

  public readManifest(ref: BundleRef): Promise<BundleManifest> {
    return this.providerFor(ref).readManifest(ref);
  }

  public readFile(ref: BundleRef, relPath: string): Promise<string> {
    return this.providerFor(ref).readFile(ref, relPath);
  }
}
