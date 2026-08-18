/**
 * Primitive Index — shared types (backward compatibility).
 *
 * This file now re-exports domain types for backward compatibility.
 * New code should import from `@ai-primitives-hub/core`.
 *
 * Feature-layer types (SearchQuery, SearchResult, etc.) remain here as they
 * are specific to the primitive-index feature.
 *
 * Ported unchanged from the reference branch's
 * `infra/src/search/types.ts`; the domain-type re-export now points at
 * `@ai-primitives-hub/core`.
 * @module search/types
 */

// Domain types — re-exported from domain layer
// Import domain types for feature-layer type definitions
import type {
  BundleRef,
  Primitive,
  PrimitiveKind,
} from '@ai-primitives-hub/core';

export {
  type BundleManifest,
  type BundleProvider,
  type BundleRef,
  type HarvestedFile,
  PRIMITIVE_KINDS,
  type Primitive,
  type PrimitiveKind,
} from '@ai-primitives-hub/core';

// Feature-layer types — specific to primitive-index

/**
 * Embedding provider interface for hybrid search.
 */
export interface EmbeddingProvider {
  /** Human-readable provider name stored in index metadata. */
  readonly name?: string;
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
  /** Current installed bundle snapshot used by the query-time overlay. */
  installedBundleKeys?: string[];
  limit?: number;
  offset?: number;
  explain?: boolean;
  ranking?: 'bm25' | 'hybrid' | 'multi';
  /** For hybrid ranking. Must match the embedding provider dimension. */
  queryEmbedding?: Float32Array;
  /** For multi-vector ranking: one embedding per named stream. */
  queryEmbeddings?: Record<string, Float32Array>;
  /** Optional per-stream weights for multi-vector ranking. */
  embeddingWeights?: Record<string, number>;
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
  /** Stable profile selected by the shared app-level search use case. */
  searchProfileId?: string;
  /** Effective ranking mode used for this query. */
  ranking?: 'bm25' | 'hybrid' | 'multi';
  /** True when the query was embedded and dense scores were combined. */
  embeddingUsed?: boolean;
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
  /** Stable source snapshot/revision represented by the index. */
  sourceRevision?: string;
  /** Stable app-level search profile that produced this index. */
  searchProfileId?: string;
  embeddings?: EmbeddingProvider;
  /** Embedding strategy: `single` keeps one combined vector per primitive; `dual` stores separate metadata and body vectors. Default: `single`. */
  embeddingStrategy?: 'single' | 'dual';
  /** Cap per-bundle file count to bound runaway sources. Default: 500. */
  maxFilesPerBundle?: number;
  /** Optional progress/diagnostic log sink. */
  onLog?: (msg: string) => void;
  /** Optional per-bundle harvest observation for lifecycle reporting. */
  onBundle?: (ref: BundleRef, produced: number) => void;
  /** Optional per-bundle harvest error observation for lifecycle reporting. */
  onHarvestError?: (ref: BundleRef | null, error: unknown) => void;
}

/**
 * Options for refreshing the index (same as BuildOptions).
 */
export type RefreshOptions = BuildOptions;
