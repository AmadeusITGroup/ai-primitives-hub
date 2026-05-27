/**
 * Primitive Index — shared types (backward compatibility).
 *
 * This file now re-exports domain types for backward compatibility.
 * New code should import from `@prompt-registry/collection-scripts/domain`.
 *
 * Feature-layer types (SearchQuery, SearchResult, etc.) remain here as they
 * are specific to the primitive-index feature.
 * @module primitive-index/types
 */

// Domain types — re-exported from domain layer
// Import domain types for feature-layer type definitions
import type {
  Primitive,
  PrimitiveKind,
} from '@prompt-registry/core';

export {
  PRIMITIVE_KINDS,
  type PrimitiveKind,
  type BundleRef,
  type BundleManifest,
  type HarvestedFile,
  type BundleProvider,
  type Primitive,
} from '@prompt-registry/core';

// Feature-layer types — specific to primitive-index

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
  primitive: Primitive;
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
 * Shortlist for organizing primitives.
 */
export interface Shortlist {
  id: string;
  name: string;
  description?: string;
  primitiveIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Index statistics.
 */
export interface IndexStats {
  primitives: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
  bundles: number;
  shortlists: number;
  builtAt: string;
}

/**
 * Refresh report after updating the index.
 */
export interface RefreshReport {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
}

/**
 * Options for building the index.
 */
export interface BuildOptions {
  hubId?: string;
  embeddings?: EmbeddingProvider;
  /** Cap per-bundle file count to bound runaway sources. Default: 500. */
  maxFilesPerBundle?: number;
}

/**
 * Options for refreshing the index (same as BuildOptions).
 */
export type RefreshOptions = BuildOptions;
