/**
 * Shared search profiles used by every delivery layer.
 *
 * The profile is the compatibility boundary between a persisted index and a
 * query. CLI commands and the VS Code extension must resolve the same profile
 * rather than constructing embedding providers independently.
 * @module search/search-profile
 */
import {
  TernlightEmbeddingProvider,
} from '@ai-primitives-hub/infra';
import type {
  EmbeddingProvider,
} from '@ai-primitives-hub/infra';

export interface SearchProfile {
  id: string;
  ranking: 'bm25' | 'hybrid' | 'multi';
  embeddingProvider?: string;
  embeddingStrategy?: 'single' | 'dual';
  /**
   * Default relevance floors applied to queries run under this profile, so the
   * CLI and the extension share one cut instead of each layer inventing its own.
   * Semantic profiles cut the noise tail; a query may still override per call.
   */
  relevance?: {
    /** Absolute floor in the normalized [0,1] score space. */
    minScore?: number;
    /** Floor as a fraction of the top hit's score (0–1). */
    minRelativeScore?: number;
  };
}

export const SEARCH_PROFILES = {
  'bm25-v1': {
    id: 'bm25-v1',
    ranking: 'bm25',
    embeddingProvider: undefined,
    embeddingStrategy: undefined
  },
  'ternlight-single-v1': {
    id: 'ternlight-single-v1',
    ranking: 'hybrid',
    embeddingProvider: 'ternlight-mini',
    embeddingStrategy: 'single',
    relevance: { minScore: 0.3, minRelativeScore: 0.4 }
  },
  'ternlight-dual-v1': {
    id: 'ternlight-dual-v1',
    ranking: 'multi',
    embeddingProvider: 'ternlight-mini',
    embeddingStrategy: 'dual',
    relevance: { minScore: 0.3, minRelativeScore: 0.4 }
  }
} as const satisfies Record<string, SearchProfile>;

export type SearchProfileId = keyof typeof SEARCH_PROFILES;

/**
 * Resolve a named profile or throw an actionable configuration error.
 * @param profileId - Stable profile identifier.
 * @returns The shared profile definition.
 */
export function getSearchProfile(profileId = 'bm25-v1'): SearchProfile {
  const profile = SEARCH_PROFILES[profileId as SearchProfileId];
  if (!profile) {
    throw new Error(`Unknown search profile: ${profileId}`);
  }
  return profile;
}

/**
 * Create the embedding provider required by a profile.
 * @param profile - Shared profile definition.
 * @returns The profile provider, or undefined for BM25-only search.
 */
export function createEmbeddingProvider(profile: SearchProfile): EmbeddingProvider | undefined {
  if (profile.embeddingProvider === undefined) {
    return undefined;
  }
  if (profile.embeddingProvider === 'ternlight-mini') {
    return new TernlightEmbeddingProvider();
  }
  throw new Error(`No embedding provider registered for: ${profile.embeddingProvider}`);
}
