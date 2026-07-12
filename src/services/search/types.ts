/**
 * Search types for the BM25-based primitive index.
 *
 * Ported from feat/cli-backup (packages/infra/src/search/types.ts).
 * Adapted from monorepo `@prompt-registry/core` to single-package types.
 */

import type {
  Bundle,
} from '../../types/registry';

/**
 * Kind of searchable primitive, mapped to bundle resource kinds.
 */
export type PrimitiveKind = 'prompt' | 'instruction' | 'agent' | 'skill' | 'plugin' | 'hook';

export const PRIMITIVE_KINDS: PrimitiveKind[] = ['prompt', 'instruction', 'agent', 'skill', 'plugin', 'hook'];

/**
 * Embedding provider interface for hybrid search.
 */
export interface EmbeddingProvider {
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Search query with filters.
 */
export interface SearchQuery {
  q?: string;
  kinds?: PrimitiveKind[];
  sources?: string[];
  bundles?: string[];
  tags?: string[];
  installedOnly?: boolean;
  limit?: number;
  offset?: number;
  explain?: boolean;
  ranking?: 'bm25' | 'hybrid';
  /** For hybrid ranking. Must match the embedding provider dimension. */
  queryEmbedding?: Float32Array;
}

/**
 * Explanation for a single match in a search hit.
 */
export interface MatchExplanation {
  field: 'title' | 'description' | 'tags' | 'bodyPreview';
  term: string;
  weight: number;
  contribution: number;
}

/**
 * A single search result hit.
 */
export interface SearchHit {
  bundle: Bundle;
  score: number;
  matches?: MatchExplanation[];
}

/**
 * Search result with hits, facets, and timing.
 */
export interface SearchResult {
  total: number;
  hits: SearchHit[];
  facets: {
    kinds: Record<string, number>;
    sources: Record<string, number>;
    tags: Record<string, number>;
  };
  tookMs: number;
}

/**
 * Index statistics.
 */
export interface IndexStats {
  primitives: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
  bundles: number;
  builtAt: string;
}
