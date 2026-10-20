/**
 * Build-index use case.
 *
 * Orchestrates `PrimitiveIndex` construction + persistence for the CLI.
 * Kept logic-free: all search/indexing concerns stay in `@ai-primitives-hub/infra`.
 * @module search/build-index
 */
import type {
  BundleProvider,
  PrimitiveIndexKey,
  PrimitiveIndexStore,
} from '@ai-primitives-hub/core';
import {
  PrimitiveIndex,
  saveIndex,
  tryLoadIndex,
} from '@ai-primitives-hub/infra';
import {
  resolveIndexPath,
} from './index-location';
import type {
  SourceCoverage,
} from './primitive-search';
import {
  createEmbeddingProvider,
  getSearchProfile,
  type SearchProfileId,
} from './search-profile';

interface SourceCoverageProvider extends BundleProvider {
  getSourceIds(): readonly string[];
  getSourceErrors(): readonly { sourceId: string; error: unknown }[];
  filterSources?(sourceIds: ReadonlySet<string>): BundleProvider;
}

type SourceOutcome = {
  bundles: number;
  primitives: number;
  state?: 'indexed' | 'skipped';
  error?: unknown;
};

/**
 * Options for building a local primitive index.
 */
export interface BuildIndexOptions {
  /** Bundle provider to harvest primitives from. */
  provider: BundleProvider;
  /** Destination file path for the persisted index (legacy override). */
  outFile?: string;
  /** Shared namespaced index location resolver. */
  indexStore?: PrimitiveIndexStore;
  /** Compatibility key used by `indexStore`. */
  indexKey?: PrimitiveIndexKey;
  /** Optional hub/source identifier stored in index metadata. */
  hubId?: string;
  /** Optional per-source revision map (sourceId -> revision) used for incremental source diffing. */
  sourceRevisions?: Readonly<Record<string, string>>;
  /** Optional explicit path to a prior index snapshot to diff against. */
  previousIndexPath?: string;
  /**
   * When true, forces a full harvest and embedding recomputation even if a
   * matching snapshot already exists or previous embeddings are available.
   */
  force?: boolean;
  /** When true, embed primitive text using the local ternlight model. */
  embed?: boolean;
  /** Embedding strategy when `embed` is true. */
  embedStrategy?: 'single' | 'dual';
  /** Optional shared profile; takes precedence over embed/embedStrategy. */
  profile?: SearchProfileId;
  /** Optional progress/diagnostic log sink. */
  onLog?: (msg: string) => void;
  /** Persist an empty result. Defaults to true for explicit empty-index builds. */
  persistEmpty?: boolean;
}

/**
 * Result of a successful index build.
 */
export interface BuildIndexResult {
  outFile: string;
  primitives: number;
  bundles: number;
  embeddings?: { provider: string; dim: number };
  report: BuildReport;
}

/** Structured outcome of one explicit or scheduled index lifecycle build. */
export interface BuildReport {
  state: 'ready' | 'partial';
  sourceCoverage: SourceCoverage[];
  primitives: number;
  bundles: number;
  elapsedMs: number;
  /** True when an existing matching indexKey snapshot was reused without rebuilding. */
  shortCircuited?: boolean;
}

function isSourceCoverageProvider(provider: BundleProvider): provider is SourceCoverageProvider {
  return 'getSourceIds' in provider
    && typeof provider.getSourceIds === 'function'
    && 'getSourceErrors' in provider
    && typeof provider.getSourceErrors === 'function';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildReport(
  provider: BundleProvider,
  harvestProvider: BundleProvider,
  primitives: number,
  bundles: number,
  elapsedMs: number,
  outcomes: ReadonlyMap<string, SourceOutcome>,
  shortCircuited = false
): BuildReport {
  if (!isSourceCoverageProvider(provider)) {
    return {
      state: 'ready',
      sourceCoverage: [],
      primitives,
      bundles,
      elapsedMs,
      ...(shortCircuited ? { shortCircuited: true } : {})
    };
  }

  const harvestErrors = isSourceCoverageProvider(harvestProvider)
    ? harvestProvider.getSourceErrors()
    : provider.getSourceErrors();
  const errors = new Map(harvestErrors.map(({ sourceId, error }) => [sourceId, error]));
  const sourceCoverage = provider.getSourceIds().map((sourceId) => {
    const outcome = outcomes.get(sourceId);
    const error = errors.get(sourceId) ?? outcome?.error;
    return error === undefined
      ? {
        sourceId,
        state: (outcome?.state ?? 'indexed'),
        bundles: outcome?.bundles ?? 0,
        primitives: outcome?.primitives ?? 0
      }
      : {
        sourceId,
        state: 'failed' as const,
        bundles: outcome?.bundles ?? 0,
        primitives: outcome?.primitives ?? 0,
        message: errorMessage(error)
      };
  });
  return {
    state: sourceCoverage.some(({ state }) => state === 'failed') ? 'partial' : 'ready',
    sourceCoverage,
    primitives,
    bundles,
    elapsedMs,
    ...(shortCircuited ? { shortCircuited: true } : {})
  };
}

function isMatchingIndexSnapshot(
  index: PrimitiveIndex,
  key: PrimitiveIndexKey,
  expectedProfileId: string | undefined
): boolean {
  const stats = index.stats();
  if (stats.primitives === 0) {
    return false;
  }
  const meta = index.toJSON() as {
    hubId?: string;
    sourceRevision?: string | null;
    searchProfileId?: string | null;
  };
  if (meta.hubId && meta.hubId !== key.hubId) {
    return false;
  }
  if (meta.sourceRevision !== key.sourceRevision) {
    return false;
  }
  const targetProfile = expectedProfileId ?? key.searchProfileId;
  if (targetProfile && meta.searchProfileId && meta.searchProfileId !== targetProfile) {
    return false;
  }
  return true;
}

async function resolvePreviousIndex(
  options: BuildIndexOptions,
  outFile: string,
  profileId: string | undefined
): Promise<PrimitiveIndex | undefined> {
  if (options.force) {
    return undefined;
  }
  if (options.previousIndexPath) {
    const explicit = tryLoadIndex(options.previousIndexPath);
    if (explicit) {
      return explicit;
    }
  }
  const atOutFile = tryLoadIndex(outFile);
  if (atOutFile && atOutFile.stats().primitives > 0) {
    return atOutFile;
  }
  if (options.indexStore?.findLatestIndexPath && options.indexKey?.hubId) {
    const targetProfile = profileId ?? options.indexKey.searchProfileId;
    const sourceIds = isSourceCoverageProvider(options.provider)
      ? options.provider.getSourceIds()
      : (options.sourceRevisions ? Object.keys(options.sourceRevisions) : undefined);
    const latestPath = await options.indexStore.findLatestIndexPath(
      options.indexKey.hubId,
      targetProfile,
      sourceIds
    );
    if (latestPath) {
      return tryLoadIndex(latestPath) ?? undefined;
    }
  }
  return undefined;
}

function computeCarryOverSourceOutcomes(
  previousIndex: PrimitiveIndex,
  carriedSourceIds: Iterable<string>
): Map<string, SourceOutcome> {
  const outcomes = new Map<string, SourceOutcome>();
  const bundlesBySource = new Map<string, Set<string>>();
  for (const sourceId of carriedSourceIds) {
    outcomes.set(sourceId, { bundles: 0, primitives: 0, state: 'skipped' });
    bundlesBySource.set(sourceId, new Set());
  }
  for (const primitive of previousIndex.all()) {
    const sourceId = primitive.bundle.sourceId;
    const outcome = outcomes.get(sourceId);
    if (!outcome) {
      continue;
    }
    outcome.primitives += 1;
    const bundleSet = bundlesBySource.get(sourceId)!;
    bundleSet.add(primitive.bundle.bundleId);
    outcome.bundles = bundleSet.size;
  }
  return outcomes;
}

function isSnapshotCoveringAllSources(
  existing: PrimitiveIndex,
  provider: BundleProvider,
  requestedRevisions: Readonly<Record<string, string>> | undefined
): boolean {
  const persistedRevisions = existing.getSourceRevisions();
  const configuredSourceIds = isSourceCoverageProvider(provider)
    ? provider.getSourceIds()
    : (requestedRevisions ? Object.keys(requestedRevisions) : []);
  if (configuredSourceIds.length === 0) {
    return true;
  }
  if (persistedRevisions) {
    return configuredSourceIds.every((sourceId) => {
      if (!Object.prototype.hasOwnProperty.call(persistedRevisions, sourceId)) {
        return false;
      }
      if (requestedRevisions && Object.prototype.hasOwnProperty.call(requestedRevisions, sourceId)) {
        return persistedRevisions[sourceId] === requestedRevisions[sourceId];
      }
      return true;
    });
  }
  // Legacy snapshots without persisted sourceRevisions: require every configured
  // source to have at least one primitive in the snapshot.
  const indexedSources = new Set(existing.all().map((p) => p.bundle.sourceId));
  return configuredSourceIds.every((sourceId) => indexedSources.has(sourceId));
}

/**
 * Build a primitive index and persist it to disk.
 * @param options Build options.
 * @returns Build summary.
 */
export async function buildIndex(options: BuildIndexOptions): Promise<BuildIndexResult> {
  const startedAt = Date.now();
  const profile = options.profile ? getSearchProfile(options.profile) : undefined;
  const outFile = resolveIndexPath({
    indexPath: options.outFile,
    indexStore: options.indexStore,
    indexKey: options.indexKey
  });

  // Fast-path: when a namespaced indexKey is supplied (and force is not set),
  // check if a valid non-empty snapshot for that exact sourceRevision already
  // exists on disk and covers every configured source (including healthy
  // 0-primitive sources recorded in sourceRevisions, while excluding sources
  // that failed during the prior build).
  if (!options.force && options.indexKey) {
    const existing = tryLoadIndex(outFile);
    if (
      existing
      && isMatchingIndexSnapshot(existing, options.indexKey, profile?.id)
      && isSnapshotCoveringAllSources(existing, options.provider, options.sourceRevisions)
    ) {
      const carriedOutcomes = isSourceCoverageProvider(options.provider)
        ? computeCarryOverSourceOutcomes(existing, options.provider.getSourceIds())
        : new Map<string, SourceOutcome>();
      const existingStats = existing.stats();
      const existingMeta = existing.toJSON() as { embeddingsMeta?: { provider: string; dim: number } | null };
      options.onLog?.(`reused existing index snapshot (${existingStats.primitives} primitives from ${existingStats.bundles} bundles)`);
      return {
        outFile,
        primitives: existingStats.primitives,
        bundles: existingStats.bundles,
        embeddings: existingMeta.embeddingsMeta ?? undefined,
        report: buildReport(
          options.provider,
          options.provider,
          existingStats.primitives,
          existingStats.bundles,
          Date.now() - startedAt,
          carriedOutcomes,
          true
        )
      };
    }
  }

  const previousIndex = await resolvePreviousIndex(options, outFile, profile?.id);
  const sourceOutcomes = new Map<string, SourceOutcome>();
  let harvestProvider: BundleProvider = options.provider;
  let changedSourceIds: Set<string> | undefined;
  const effectiveSourceRevisions = options.sourceRevisions && isSourceCoverageProvider(options.provider)
    ? (() => {
      const providerSourceIds = new Set(options.provider.getSourceIds());
      return Object.fromEntries(
        Object.entries(options.sourceRevisions).filter(([sourceId]) => providerSourceIds.has(sourceId))
      );
    })()
    : options.sourceRevisions;

  const previousRevisions = previousIndex?.getSourceRevisions();
  if (
    previousIndex
    && effectiveSourceRevisions
    && previousRevisions
    && isSourceCoverageProvider(options.provider)
    && typeof options.provider.filterSources === 'function'
  ) {
    changedSourceIds = new Set<string>();
    const unchangedSourceIds: string[] = [];
    for (const [sourceId, revision] of Object.entries(effectiveSourceRevisions)) {
      if (
        Object.prototype.hasOwnProperty.call(previousRevisions, sourceId)
        && previousRevisions[sourceId] === revision
      ) {
        unchangedSourceIds.push(sourceId);
      } else {
        changedSourceIds.add(sourceId);
      }
    }
    for (const sourceId of options.provider.getSourceIds()) {
      if (!unchangedSourceIds.includes(sourceId)) {
        changedSourceIds.add(sourceId);
      }
    }
    for (const [sourceId, outcome] of computeCarryOverSourceOutcomes(previousIndex, unchangedSourceIds)) {
      sourceOutcomes.set(sourceId, outcome);
    }
    harvestProvider = options.provider.filterSources(changedSourceIds);
  }

  const embed = profile ? profile.embeddingProvider !== undefined : options.embed;
  const embeddingStrategy = profile?.embeddingStrategy ?? options.embedStrategy;
  const embeddings = embed
    ? createEmbeddingProvider(profile ?? getSearchProfile('ternlight-single-v1'))
    : undefined;
  const idx = await PrimitiveIndex.buildFrom(harvestProvider, {
    hubId: options.hubId ?? options.indexKey?.hubId,
    sourceRevision: options.indexKey?.sourceRevision,
    sourceRevisions: effectiveSourceRevisions,
    previousIndex,
    changedSourceIds,
    searchProfileId: profile?.id,
    embeddings,
    embeddingStrategy,
    onLog: options.onLog,
    onBundle: (ref, produced) => {
      const outcome = sourceOutcomes.get(ref.sourceId) ?? { bundles: 0, primitives: 0 };
      outcome.bundles += 1;
      outcome.primitives += produced;
      sourceOutcomes.set(ref.sourceId, outcome);
    },
    onHarvestError: (ref, error) => {
      if (!ref) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('not a primitive candidate:')) {
        return;
      }
      const outcome = sourceOutcomes.get(ref.sourceId) ?? { bundles: 0, primitives: 0 };
      outcome.error = error;
      sourceOutcomes.set(ref.sourceId, outcome);
    }
  });
  const stats = idx.stats();
  if (stats.primitives > 0 || options.persistEmpty !== false) {
    saveIndex(idx, outFile);
  }
  const meta = idx.toJSON() as { embeddingsMeta?: { provider: string; dim: number } | null };
  return {
    outFile,
    primitives: stats.primitives,
    bundles: stats.bundles,
    embeddings: meta.embeddingsMeta ?? undefined,
    report: buildReport(
      options.provider,
      harvestProvider,
      stats.primitives,
      stats.bundles,
      Date.now() - startedAt,
      sourceOutcomes
    )
  };
}
