/**
 * Search-index use case.
 *
 * Loads a persisted primitive index and runs a search, optionally using a
 * local embedding model for hybrid or multi-vector ranking.
 * @module search/search-index
 */
import type {
  PrimitiveIndexKey,
  PrimitiveIndexStore,
} from '@ai-primitives-hub/core';
import type {
  SearchQuery,
  SearchResult,
} from '@ai-primitives-hub/infra';
import {
  loadIndex,
} from '@ai-primitives-hub/infra';
import {
  resolveIndexPath,
} from './index-location';
import {
  createEmbeddingProvider,
  getSearchProfile,
  SEARCH_PROFILES,
  type SearchProfileId,
} from './search-profile';

/**
 * Options for searching a primitive index.
 */
export interface SearchIndexOptions {
  /** Path to the persisted primitive index (legacy override). */
  indexPath?: string;
  /** Shared namespaced index location resolver. */
  indexStore?: PrimitiveIndexStore;
  /** Compatibility key used by `indexStore`. */
  indexKey?: PrimitiveIndexKey;
  /** Search query and filters. */
  query: SearchQuery;
  /**
   * Ranking strategy. `bm25` (default) is keyword-only; `hybrid` adds dense
   * similarity with a single combined embedding; `multi` uses the named
   * embedding streams stored in the index. May also be set on `query.ranking`;
   * this field takes precedence.
   */
  ranking?: 'bm25' | 'hybrid' | 'multi';
  /** Optional shared profile; takes precedence over ranking. */
  profile?: SearchProfileId;
}

/**
 * Search error for unsupported hybrid search.
 */
export class SearchIndexError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SearchIndexError';
    this.code = code;
  }
}

function validateIndexKey(
  key: PrimitiveIndexKey | undefined,
  metadata: { hubId?: string; sourceRevision?: string }
): void {
  if (!key) {
    return;
  }
  if (metadata.hubId && metadata.hubId !== key.hubId) {
    throw new SearchIndexError('HUB_MISMATCH', `Index hub ${metadata.hubId} is incompatible with requested hub ${key.hubId}`);
  }
  if (metadata.sourceRevision && metadata.sourceRevision !== key.sourceRevision) {
    throw new SearchIndexError('SOURCE_REVISION_MISMATCH', 'Index source revision is incompatible with the requested source snapshot');
  }
}

function streamNames(strategy: string | undefined, hasEmbeddings: boolean): string[] {
  if (!hasEmbeddings) {
    return [];
  }
  if (strategy === 'dual') {
    return ['metadata', 'body'];
  }
  return ['combined'];
}

/**
 * Load a primitive index and run a search.
 * @param options Search options.
 * @returns Search result.
 * @throws {SearchIndexError} if hybrid/multi ranking is requested on a non-embedded index.
 */
export async function searchIndex(options: SearchIndexOptions): Promise<SearchResult> {
  const indexPath = resolveIndexPath(options);
  const idx = loadIndex(indexPath);
  const indexMetadata = idx.toJSON() as {
    hubId?: string;
    sourceRevision?: string | null;
    searchProfileId?: string | null;
    embeddingsMeta?: { provider: string; dim: number; embeddingStrategy?: string } | null;
  };
  validateIndexKey(options.indexKey, {
    hubId: indexMetadata.hubId,
    sourceRevision: indexMetadata.sourceRevision ?? undefined
  });
  const query: SearchQuery = { ...options.query };
  const persistedProfileId = indexMetadata.searchProfileId
    ?? (indexMetadata.embeddingsMeta
      ? (indexMetadata.embeddingsMeta.embeddingStrategy === 'dual' ? 'ternlight-dual-v1' : 'ternlight-single-v1')
      : 'bm25-v1');
  const persistedProfile = Object.prototype.hasOwnProperty.call(SEARCH_PROFILES, persistedProfileId)
    ? getSearchProfile(persistedProfileId)
    : undefined;
  const profile = options.profile
    ? getSearchProfile(options.profile)
    : (!options.ranking && !query.ranking ? persistedProfile : undefined);
  const ranking = profile?.ranking ?? options.ranking ?? query.ranking ?? 'bm25';
  const searchProfileId = profile?.id
    ?? (ranking === 'multi' ? 'ternlight-dual-v1' : (ranking === 'hybrid' ? 'ternlight-single-v1' : 'bm25-v1'));

  if ((ranking === 'hybrid' || ranking === 'multi') && !query.q) {
    throw new SearchIndexError('MISSING_QUERY', `${String(ranking)} ranking requires a text query`);
  }

  if (ranking === 'hybrid' || ranking === 'multi') {
    const meta = indexMetadata;
    if (!meta.embeddingsMeta) {
      throw new SearchIndexError(
        'NO_EMBEDDINGS',
        `${String(ranking)} ranking requires an embedded index. Run \`index build --embed\` or \`index harvest --embed\` first.`
      );
    }
    const expectedProfileId = profile?.id
      ?? (ranking === 'multi' ? 'ternlight-dual-v1' : 'ternlight-single-v1');
    if (persistedProfileId !== expectedProfileId) {
      throw new SearchIndexError(
        'PROFILE_MISMATCH',
        `Search profile ${expectedProfileId} is incompatible with index profile ${persistedProfileId}. Rebuild the index with the requested profile.`
      );
    }

    const provider = createEmbeddingProvider(
      profile ?? getSearchProfile(ranking === 'multi' ? 'ternlight-dual-v1' : 'ternlight-single-v1')
    );
    if (!provider) {
      throw new SearchIndexError('EMBEDDING_UNAVAILABLE', `No embedding provider is registered for ${String(ranking)} ranking`);
    }

    if (ranking === 'hybrid') {
      const [queryEmbedding] = await provider.embed([query.q!]);
      query.ranking = 'hybrid';
      query.queryEmbedding = queryEmbedding;
    } else {
      const names = streamNames(meta.embeddingsMeta.embeddingStrategy, true);
      const inputs = names.map(() => query.q!);
      const vectors = await provider.embed(inputs);
      const queryEmbeddings: Record<string, Float32Array> = {};
      for (const [i, name] of names.entries()) {
        queryEmbeddings[name] = vectors[i]!;
      }
      query.ranking = 'multi';
      query.queryEmbeddings = queryEmbeddings;
    }
  }

  const result = idx.search(query);
  return {
    ...result,
    searchProfileId,
    ranking,
    embeddingUsed: ranking === 'hybrid' || ranking === 'multi'
  };
}
