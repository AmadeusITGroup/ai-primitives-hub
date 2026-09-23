/**
 * Typed primitive-search application contract.
 *
 * This facade keeps delivery layers independent from raw index errors while
 * preserving `searchIndex()` for callers that need its low-level behavior.
 * It never builds an index or resolves remote source state.
 * @module search/primitive-search
 */
import type {
  PrimitiveIndexKey,
  PrimitiveIndexStore,
  PrimitiveKind,
} from '@ai-primitives-hub/core';
import type {
  SearchResult,
} from '@ai-primitives-hub/infra';
import {
  searchIndex,
  SearchIndexError,
} from './search-index';
import type {
  SearchProfileId,
} from './search-profile';

/** Ranking modes supported by the shared primitive index. */
export type RankingMode = 'bm25' | 'hybrid' | 'multi';

/** Lifecycle state of the persisted index selected for a request. */
export type PrimitiveIndexState =
  | 'missing'
  | 'ready'
  | 'refreshing'
  | 'partial'
  | 'incompatible'
  | 'failed';

/** Search availability exposed to delivery layers. */
export type PrimitiveSearchAvailability = 'ready' | 'degraded' | 'unavailable';

/** Per-source coverage reported by an index lifecycle operation. */
export interface SourceCoverage {
  sourceId: string;
  state: 'indexed' | 'skipped' | 'unsupported' | 'failed';
  bundles?: number;
  primitives?: number;
  revision?: string;
  message?: string;
}

/** Compatibility metadata carried by a persisted primitive index. */
export interface IndexCompatibility {
  schemaVersion?: number;
  extractionVersion?: string;
  primitiveIdentityVersion?: string;
  tokenizerVersion?: string;
  bm25Profile?: string;
  rankingProfile?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingStrategy?: 'single' | 'dual';
  sourceRevision?: string;
}

/** Status and coverage of the persisted primitive index. */
export interface IndexStatus {
  state: PrimitiveIndexState;
  searchProfileId?: string;
  ranking?: RankingMode;
  builtAt?: string;
  sourceCoverage?: SourceCoverage[];
  compatibility?: IndexCompatibility;
  usingFallbackSnapshot?: boolean;
}

/** Serializable primitive search request shared by all delivery layers. */
export interface PrimitiveSearchRequest {
  q?: string;
  kinds?: PrimitiveKind[];
  sources?: string[];
  bundles?: string[];
  tags?: string[];
  installedOnly?: boolean;
  limit?: number;
  offset?: number;
  explain?: boolean;
  ranking?: RankingMode;
  profile?: SearchProfileId;
}

/** Actionable warning returned when the persisted index cannot be searched. */
export interface PrimitiveSearchWarning {
  code: 'INDEX_MISSING' | 'INDEX_INCOMPATIBLE' | 'SEARCH_FAILED';
  message: string;
  causeCode?: string;
}

/** Typed search response for CLI and UI delivery adapters. */
export interface PrimitiveSearchResponse {
  status: PrimitiveSearchAvailability;
  index: IndexStatus;
  result?: SearchResult;
  warning?: PrimitiveSearchWarning;
}

/** Options for the typed primitive-search facade. */
export interface SearchPrimitivesOptions {
  /** Path to the persisted primitive index (legacy override). */
  indexPath?: string;
  /** Shared namespaced index location resolver. */
  indexStore?: PrimitiveIndexStore;
  /** Compatibility key used by `indexStore`. */
  indexKey?: PrimitiveIndexKey;
  /** Serializable query and filtering options. */
  request: PrimitiveSearchRequest;
  /** Current installed bundle snapshot; resolved outside the read-only search use case. */
  installedBundleKeys?: string[];
  /** Lifecycle status supplied by the caller when it is already known. */
  indexStatus?: IndexStatus;
}

const INCOMPATIBLE_INDEX_CODES = new Set([
  'EMBEDDING_UNAVAILABLE',
  'HUB_MISMATCH',
  'NO_EMBEDDINGS',
  'PROFILE_MISMATCH',
  'SOURCE_REVISION_MISMATCH'
]);

function initialIndexStatus(options: SearchPrimitivesOptions): IndexStatus {
  return options.indexStatus ?? { state: 'ready' };
}

function isDegraded(state: PrimitiveIndexState): boolean {
  return state === 'partial' || state === 'refreshing';
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingIndex(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || /ENOENT|no such file/i.test(errorMessage(error));
}

function unavailableResponse(
  index: IndexStatus,
  state: Extract<PrimitiveIndexState, 'missing' | 'incompatible' | 'failed'>,
  warning: PrimitiveSearchWarning
): PrimitiveSearchResponse {
  return {
    status: 'unavailable',
    index: { ...index, state },
    warning
  };
}

/**
 * Search a pre-built primitive index through a serializable, status-aware
 * application contract. This operation is read-only: callers must schedule
 * lifecycle rebuilds separately.
 * @param options Persisted-index location, request, and optional lifecycle state.
 */
export async function searchPrimitives(options: SearchPrimitivesOptions): Promise<PrimitiveSearchResponse> {
  const index = initialIndexStatus(options);
  try {
    const result = await searchIndex({
      indexPath: options.indexPath,
      indexStore: options.indexStore,
      indexKey: options.indexKey,
      profile: options.request.profile,
      ranking: options.request.ranking,
      query: {
        q: options.request.q,
        kinds: options.request.kinds,
        sources: options.request.sources,
        bundles: options.request.bundles,
        tags: options.request.tags,
        installedOnly: options.request.installedOnly,
        installedBundleKeys: options.installedBundleKeys,
        limit: options.request.limit,
        offset: options.request.offset,
        explain: options.request.explain,
        ranking: options.request.ranking
      }
    });
    const responseIndex: IndexStatus = {
      ...index,
      searchProfileId: result.searchProfileId,
      ranking: result.ranking
    };
    return {
      status: isDegraded(responseIndex.state) ? 'degraded' : 'ready',
      index: responseIndex,
      result
    };
  } catch (error) {
    if (isMissingIndex(error)) {
      return unavailableResponse(index, 'missing', {
        code: 'INDEX_MISSING',
        message: 'No compatible primitive index is available. Rebuild the primitive index and try again.',
        causeCode: errorCode(error)
      });
    }
    if (error instanceof SearchIndexError && INCOMPATIBLE_INDEX_CODES.has(error.code)) {
      return unavailableResponse(index, 'incompatible', {
        code: 'INDEX_INCOMPATIBLE',
        message: error.message,
        causeCode: error.code
      });
    }
    return unavailableResponse(index, 'failed', {
      code: 'SEARCH_FAILED',
      message: errorMessage(error),
      causeCode: errorCode(error)
    });
  }
}
