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
}

type SourceOutcome = {
  bundles: number;
  primitives: number;
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
  primitives: number,
  bundles: number,
  elapsedMs: number,
  outcomes: ReadonlyMap<string, SourceOutcome>
): BuildReport {
  if (!isSourceCoverageProvider(provider)) {
    return {
      state: 'ready',
      sourceCoverage: [],
      primitives,
      bundles,
      elapsedMs
    };
  }

  const errors = new Map(provider.getSourceErrors().map(({ sourceId, error }) => [sourceId, error]));
  const sourceCoverage = provider.getSourceIds().map((sourceId) => {
    const outcome = outcomes.get(sourceId);
    const error = errors.get(sourceId) ?? outcome?.error;
    return error === undefined
      ? {
        sourceId,
        state: 'indexed' as const,
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
    state: sourceCoverage.some(({ state }) => state !== 'indexed') ? 'partial' : 'ready',
    sourceCoverage,
    primitives,
    bundles,
    elapsedMs
  };
}

/**
 * Build a primitive index and persist it to disk.
 * @param options Build options.
 * @returns Build summary.
 */
export async function buildIndex(options: BuildIndexOptions): Promise<BuildIndexResult> {
  const startedAt = Date.now();
  const sourceOutcomes = new Map<string, SourceOutcome>();
  const profile = options.profile ? getSearchProfile(options.profile) : undefined;
  const outFile = resolveIndexPath({
    indexPath: options.outFile,
    indexStore: options.indexStore,
    indexKey: options.indexKey
  });
  const embed = profile ? profile.embeddingProvider !== undefined : options.embed;
  const embeddingStrategy = profile?.embeddingStrategy ?? options.embedStrategy;
  const embeddings = embed
    ? createEmbeddingProvider(profile ?? getSearchProfile('ternlight-single-v1'))
    : undefined;
  const idx = await PrimitiveIndex.buildFrom(options.provider, {
    hubId: options.hubId ?? options.indexKey?.hubId,
    sourceRevision: options.indexKey?.sourceRevision,
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
    report: buildReport(options.provider, stats.primitives, stats.bundles, Date.now() - startedAt, sourceOutcomes)
  };
}
