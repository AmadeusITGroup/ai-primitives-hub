/**
 * Canonical collection inventory from enabled collection sources. Deployment
 * bundles, skills and APM packages are not collection definitions.
 * @module governance/hub-source-collection-index
 */
import type {
  GovernanceCollection,
  HubCollectionIndex,
  HubCollectionInventory,
  RegistrySource,
  SourceAdapter,
} from '@ai-primitives-hub/core';
import {
  describeFailure,
} from './failure-reasons';
import type {
  GitHubReleaseLookup,
} from './github-release-lookup';

/**
 * Defence in depth for text passed through from a lookup: strip URL credentials and queries, redact tokens.
 * @param text
 */
function safeText(text: string): string {
  return text
    .replaceAll(/(https?:\/\/)[^\s/@]+@/gi, '$1')
    .replaceAll(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1')
    .replaceAll(/\b(token|access_token|sig|signature|key)=\S+/gi, '$1=[redacted]')
    .slice(0, 600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode source data without coercing malformed ids into canonical identities.
 * @param value
 * @param sourceId
 */
function collectionIdentity(value: unknown, sourceId: string): GovernanceCollection {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new Error('Invalid collection identity.');
  }
  const collection: GovernanceCollection = { id: value.id, sourceId };
  for (const key of ['name', 'repository', 'file'] as const) {
    const field = value[key];
    if (field !== undefined) {
      if (typeof field !== 'string') {
        throw new Error('Invalid collection provenance.');
      }
      collection[key] = field;
    }
  }
  return collection;
}

const TIMEOUT = {
  message: 'Reading this source did not finish within the overall time limit.',
  hint: 'Retry the check; if it repeats, the source may have very many releases or GitHub may be rate limiting.'
};

export interface HubSourceCollectionIndexOptions {
  /**
   * Sources read in full (every release manifest). Others are context only and are read
   * ids-only (one release per tag family). Omit to read every source in full.
   */
  fullSourceIds?: ReadonlySet<string>;
  /** Sources read at the same time. Default 8. */
  concurrency?: number;
  /** Overall time limit; unfinished sources become unverified. Default 5 minutes. */
  deadlineMs?: number;
}

export type HubSourceProgressEvent = {
  phase: 'start' | 'complete'; sourceId: string; index: number; total: number; collections?: number; unverified?: boolean;
};

export class HubSourceCollectionIndex implements HubCollectionIndex {
  public constructor(
    private readonly sources: readonly RegistrySource[],
    private readonly adapterForSource: (source: RegistrySource) => SourceAdapter,
    private readonly releases: Pick<GitHubReleaseLookup, 'listCollections'>,
    private readonly onProgress?: (event: HubSourceProgressEvent) => void,
    private readonly options: HubSourceCollectionIndexOptions = {}
  ) {}

  private async readSource(source: RegistrySource): Promise<HubCollectionInventory> {
    switch (source.type) {
      case 'github': {
        // The release lookup reads manifest ids; runtime release bundle ids
        // contain repository/version prefixes and cannot establish uniqueness.
        const idsOnly = this.options.fullSourceIds !== undefined && !this.options.fullSourceIds.has(source.id);
        return this.releases.listCollections(source.url, source.id, { idsOnly });
      }
      case 'awesome-copilot':
      case 'local-awesome-copilot': {
        const adapter = this.adapterForSource(source);
        if (adapter.fetchBundlesStrict === undefined) {
          throw new Error('Source does not provide a strict collection catalog.');
        }
        const bundles = await adapter.fetchBundlesStrict();
        if (!Array.isArray(bundles)) {
          throw new Error('Invalid collection catalog.');
        }
        const collections = bundles.map((bundle): GovernanceCollection => {
          if (!isRecord(bundle)) {
            throw new Error('Invalid collection catalog entry.');
          }
          // Awesome adapters already expose raw ids. Keep the definition's
          // manifest URL as file provenance instead of inventing a bundle id.
          return collectionIdentity({
            id: bundle.id,
            name: bundle.name,
            repository: bundle.repository ?? source.url,
            file: bundle.manifestUrl
          }, source.id);
        });
        return { collections, unverifiedSources: [] };
      }
      case 'skills':
      case 'local-skills':
      case 'apm':
      case 'local-apm':
      case 'azure-devops':
      case 'local': {
        // Local deployment manifests describe bundles, not collections.
        return { collections: [], unverifiedSources: [] };
      }
      default: {
        throw new Error('Unsupported collection source type.');
      }
    }
  }

  private async readOne(source: RegistrySource, index: number, total: number): Promise<HubCollectionInventory> {
    const sourceInventory: HubCollectionInventory = { collections: [], unverifiedSources: [] };
    this.onProgress?.({ phase: 'start', sourceId: source.id, index, total });
    try {
      const result = await this.readSource(source);
      if (!isRecord(result) || !Array.isArray(result.collections) || !Array.isArray(result.unverifiedSources)) {
        throw new Error('Invalid collection inventory.');
      }
      // Validate the entire source before committing it. Deduplicate versions
      // only inside this source, retaining cross-source identity collisions.
      const collections = result.collections.map((value: unknown) => collectionIdentity(value, source.id));
      const byId = new Map(collections.map((collection) => [collection.id, collection]));
      sourceInventory.collections.push(...byId.values());
      // Reasons from the release lookup are built from known fields, never copied from responses.
      for (const entry of result.unverifiedSources as unknown[]) {
        const record = isRecord(entry) ? entry : {};
        sourceInventory.unverifiedSources.push({ sourceId: source.id,
          message: typeof record.message === 'string' ? safeText(record.message) : 'The collection list could not be read.',
          hint: typeof record.hint === 'string' ? safeText(record.hint) : undefined });
      }
    } catch (error) {
      // Never expose raw URLs, HTTP bodies, tokens or parser diagnostics: classify instead.
      const failure = error instanceof Error && /^Invalid collection|^Source does not provide|^Unsupported collection/.test(error.message)
        ? { reason: `The source's collection definitions could not be read: ${error.message}`, hint: 'Fix the collection definitions in the source repository.' }
        : describeFailure(error);
      sourceInventory.unverifiedSources.push({ sourceId: source.id, message: failure.reason, hint: failure.hint });
    }
    this.onProgress?.({ phase: 'complete', sourceId: source.id, index, total,
      collections: sourceInventory.collections.length,
      unverified: sourceInventory.unverifiedSources.length > 0 });
    return sourceInventory;
  }

  public async read(): Promise<HubCollectionInventory> {
    const sources = this.sources.filter((source) => source.enabled).toSorted((left, right) => left.id < right.id ? -1 : (left.id > right.id ? 1 : 0));
    const results: (HubCollectionInventory | undefined)[] = Array.from({ length: sources.length });
    const concurrency = Math.max(1, this.options.concurrency ?? 8);
    let next = 0;
    let stopped = false;
    // A worker pool: one slow source no longer stalls a whole batch.
    const worker = async (): Promise<void> => {
      while (!stopped && next < sources.length) {
        const position = next++;
        results[position] = await this.readOne(sources[position], position + 1, sources.length);
      }
    };
    const workers = Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, () => worker()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.deadlineMs ?? 5 * 60 * 1000);
      // Never keep the process alive for the deadline alone.
      (timer as { unref?: () => void }).unref?.();
    });
    await Promise.race([workers, deadline]);
    stopped = true;
    clearTimeout(timer);
    // Snapshot now: sources still in flight after the deadline are reported unverified.
    const settled = [...results];
    // Merge in source order, not completion order, for deterministic reports.
    const inventory: HubCollectionInventory = { collections: [], unverifiedSources: [] };
    for (const [position, result] of settled.entries()) {
      if (result === undefined) {
        inventory.unverifiedSources.push({ sourceId: sources[position].id, ...TIMEOUT });
        continue;
      }
      inventory.collections.push(...result.collections);
      inventory.unverifiedSources.push(...result.unverifiedSources);
    }
    return inventory;
  }
}
