/**
 * PrimitiveIndex — public API that composes harvester + tokenizer + BM25
 * + facet maps + persistence + shortlists + profile export.
 *
 * Deterministic by default (BM25 + facets); hybrid ranking only activates
 * when a queryEmbedding is provided and records carry embeddings.
 */

import * as crypto from 'node:crypto';
import {
  harvest,
} from '../harvest/harvester';
import {
  Bm25Engine,
  type FieldTokens,
} from './bm25-engine';
import {
  tokenize,
} from './tokenizer';
import {
  HYBRID_ALPHA,
  type SearchableField,
} from './tuning';
import type {
  BuildOptions,
  BundleProvider,
  IndexStats,
  MatchExplanation,
  Primitive,
  RefreshOptions,
  RefreshReport,
  SearchHit,
  SearchQuery,
  SearchResult,
  Shortlist,
} from './types';
import {
  PRIMITIVE_KINDS,
} from './types';

/**
 * Internal record for indexed primitives.
 * Contains the primitive, tokenized fields, and optional embedding.
 */
interface InternalRecord {
  primitive: Primitive;
  fields: FieldTokens;
  embedding?: Float32Array;
}

/**
 * Tokenize all searchable fields of a primitive.
 * @param p Primitive to tokenize.
 * @returns Tokenized fields for BM25 indexing.
 */
function tokenizeFields(p: Primitive): FieldTokens {
  return {
    title: tokenize(p.title),
    tags: tokenize(p.tags.join(' ')),
    description: tokenize(p.description),
    bodyPreview: tokenize(p.bodyPreview)
  };
}

/**
 * Compute cosine similarity between two vectors.
 * @param a First vector.
 * @param b Second vector.
 * @returns Cosine similarity score between 0 and 1.
 */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [i, element] of a.entries()) {
    dot += element * b[i];
    na += element * element;
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Generate a random ID with a prefix.
 * @param prefix ID prefix.
 * @returns Random ID string.
 */
function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * PrimitiveIndex — BM25-powered search index for agentic primitives.
 * Supports text search via BM25 and optional hybrid search with embeddings.
 */
export class PrimitiveIndex {
  private records: InternalRecord[] = [];
  private byId = new Map<string, number>(); // primitiveId → records idx
  private bm25!: Bm25Engine;
  private facets!: {
    kind: Map<string, Set<number>>;
    source: Map<string, Set<number>>;
    bundle: Map<string, Set<number>>;
    tag: Map<string, Set<number>>;
    installed: Set<number>;
  };

  private readonly shortlists = new Map<string, Shortlist>();
  private meta: {
    schemaVersion: number;
    builtAt: string;
    hubId?: string;
    embeddingsMeta?: { provider: string; dim: number };
  } = { schemaVersion: 1, builtAt: new Date().toISOString(), hubId: 'my-hub-id' };

  /**
   * Compute changes between current index and new primitives.
   * @param nextById Map of new primitives by ID.
   * @returns Change summary with added, updated, removed, and unchanged counts.
   */
  private computeChanges(
    nextById: Map<string, Primitive>
  ): { added: string[]; updated: string[]; removed: string[]; unchanged: number } {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    let unchanged = 0;

    for (const [id, prim] of nextById) {
      const oldIdx = this.byId.get(id);
      if (oldIdx === undefined) {
        added.push(id);
      } else if (this.records[oldIdx].primitive.contentHash === prim.contentHash) {
        unchanged++;
      } else {
        updated.push(id);
      }
    }
    for (const id of this.byId.keys()) {
      if (!nextById.has(id)) {
        removed.push(id);
      }
    }

    return { added, updated, removed, unchanged };
  }

  /**
   * Clean up shortlists by removing deleted primitives.
   * @param removedIds IDs of removed primitives.
   */
  private cleanupShortlists(removedIds: string[]): void {
    if (removedIds.length === 0) {
      return;
    }
    const removedSet = new Set(removedIds);
    for (const sl of this.shortlists.values()) {
      const before = sl.primitiveIds.length;
      sl.primitiveIds = sl.primitiveIds.filter((p) => !removedSet.has(p));
      if (sl.primitiveIds.length !== before) {
        sl.updatedAt = new Date().toISOString();
      }
    }
  }

  /**
   * Build a PrimitiveIndex from a BundleProvider.
   * @param provider Bundle provider to harvest primitives from.
   * @param opts Build options.
   * @returns Built PrimitiveIndex.
   */
  public static async buildFrom(
    provider: BundleProvider,
    opts: BuildOptions = {}
  ): Promise<PrimitiveIndex> {
    const idx = new PrimitiveIndex();
    const primitives = await harvest(provider, {
      maxFilesPerBundle: opts.maxFilesPerBundle
    });
    await idx.reset(primitives, opts);
    return idx;
  }

  /**
   * Build a new index from primitives.
   * @param primitives List of primitives to index.
   * @param opts Build options.
   * @returns Built PrimitiveIndex.
   */
  public static fromPrimitives(
    primitives: Primitive[],
    opts: BuildOptions = {}
  ): PrimitiveIndex {
    const idx = new PrimitiveIndex();
    // Use synchronous reset path when building from primitives directly
    idx.resetSync(primitives, opts);
    return idx;
  }

  /**
   * Reset the index with new primitives.
   * @param primitives List of primitives to index.
   * @param opts Build options.
   */
  private async reset(primitives: Primitive[], opts: BuildOptions): Promise<void> {
    this.resetSync(primitives, opts);
    if (opts.embeddings) {
      const texts = this.records.map((r) =>
        `${r.primitive.title}\n${r.primitive.description}\n${r.primitive.tags.join(' ')}\n${r.primitive.bodyPreview}`
      );
      const vectors = await opts.embeddings.embed(texts);
      vectors.forEach((v, i) => {
        this.records[i].embedding = v;
      });
      this.meta.embeddingsMeta = {
        provider: (opts.embeddings as unknown as { name?: string }).name ?? 'custom',
        dim: opts.embeddings.dim
      };
    }
  }

  /**
   * Synchronous reset without embeddings support.
   * Used by fromPrimitives which doesn't need async embedding loading.
   * @param primitives List of primitives to index.
   * @param opts Build options.
   */
  private resetSync(primitives: Primitive[], opts: BuildOptions): void {
    // Deduplicate by primitiveId; later wins.
    const byId = new Map<string, Primitive>();
    for (const p of primitives) {
      byId.set(p.id, p);
    }
    this.records = Array.from(byId.values()).map((primitive) => ({
      primitive,
      fields: tokenizeFields(primitive)
    }));
    this.byId = new Map(this.records.map((r, i) => [r.primitive.id, i]));
    this.rebuildBm25();
    this.rebuildFacets();
    this.meta = {
      ...this.meta,
      schemaVersion: 1,
      builtAt: new Date().toISOString(),
      hubId: opts.hubId ?? this.meta.hubId
    };
  }

  /**
   * Rebuild the BM25 index from current records.
   */
  private rebuildBm25(): void {
    this.bm25 = new Bm25Engine(
      this.records.map((r) => ({ id: r.primitive.id, fields: r.fields }))
    );
  }

  /**
   * Rebuild facet maps from current records.
   */
  private rebuildFacets(): void {
    const kind = new Map<string, Set<number>>();
    const source = new Map<string, Set<number>>();
    const bundle = new Map<string, Set<number>>();
    const tag = new Map<string, Set<number>>();
    const installed = new Set<number>();
    for (let i = 0; i < this.records.length; i++) {
      const p = this.records[i].primitive;
      addTo(kind, p.kind, i);
      addTo(source, p.bundle.sourceId, i);
      addTo(bundle, p.bundle.bundleId, i);
      for (const t of p.tags) {
        addTo(tag, t.toLowerCase(), i);
      }
      if (p.bundle.installed) {
        installed.add(i);
      }
    }
    this.facets = { kind, source, bundle, tag, installed };
  }

  /**
   * Filter records based on query facets.
   * @param query Search query with facet filters.
   * @returns Set of record indices matching the filters.
   */
  private filter(query: SearchQuery): Set<number> {
    const all = new Set<number>();
    for (let i = 0; i < this.records.length; i++) {
      all.add(i);
    }
    let candidates = all;
    candidates = intersectFacet(candidates, this.facets.kind, query.kinds);
    candidates = intersectFacet(candidates, this.facets.source, query.sources);
    candidates = intersectFacet(candidates, this.facets.bundle, query.bundles);
    candidates = intersectFacet(candidates, this.facets.tag, query.tags, true);
    if (query.installedOnly) {
      candidates = intersectSets(candidates, this.facets.installed);
    }
    return candidates;
  }

  /**
   * Populate zero scores for filtered candidates.
   * @param scores Map of record indices to scores.
   * @param candidates Set of candidate record indices.
   */
  private populateZeroScores(scores: Map<number, number>, candidates: Set<number>): void {
    for (const idx of candidates) {
      if (!scores.has(idx)) {
        scores.set(idx, 0);
      }
    }
  }

  /**
   * Normalize scores to 0-1 range.
   * @param scores Map of record indices to scores.
   * @returns Maximum score before normalization.
   */
  private normalizeScores(scores: Map<number, number>): number {
    let maxScore = 0;
    for (const s of scores.values()) {
      if (s > maxScore) {
        maxScore = s;
      }
    }
    return maxScore;
  }

  /**
   * Compute final score from BM25 and optional cosine similarity.
   * @param raw Raw BM25 score.
   * @param maxScore Maximum BM25 score for normalization.
   * @param useHybrid Whether to use hybrid scoring.
   * @param embedding Record embedding vector.
   * @param queryEmbedding Query embedding vector.
   * @param alpha Weight for BM25 vs cosine similarity.
   * @returns Final score between 0 and 1.
   */
  private computeScore(
    raw: number,
    maxScore: number,
    useHybrid: boolean,
    embedding: Float32Array<ArrayBufferLike> | undefined,
    queryEmbedding: Float32Array<ArrayBufferLike> | undefined,
    alpha: number
  ): number {
    const bm25Norm = maxScore > 0 ? raw / maxScore : 0;
    let score = alpha * bm25Norm;
    if (useHybrid && embedding && queryEmbedding) {
      const cs = cosine(embedding, queryEmbedding);
      score += (1 - alpha) * cs;
    }
    return score;
  }

  /**
   * Build a SearchHit from a record index and score.
   * @param idx Record index.
   * @param score Final score.
   * @param explanations Optional match explanations.
   * @returns SearchHit object.
   */
  private buildSearchHit(
    idx: number,
    score: number,
    explanations: Map<number, { field: SearchableField; term: string; weight: number; contribution: number }[]> | undefined
  ): SearchHit {
    return {
      primitive: this.records[idx].primitive,
      score,
      matches: explanations?.get(idx)?.map<MatchExplanation>((m) => ({
        field: m.field,
        term: m.term,
        weight: m.weight,
        contribution: m.contribution
      }))
    };
  }

  /**
   * Sort hits by score, then rating, then bundle ID, then path.
   * @param hits List of search hits.
   * @returns Sorted list of search hits.
   */
  private sortHits(hits: SearchHit[]): SearchHit[] {
    return hits.toSorted((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const ra = a.primitive.rating ?? 0;
      const rb = b.primitive.rating ?? 0;
      if (rb !== ra) {
        return rb - ra;
      }
      if (a.primitive.bundle.bundleId !== b.primitive.bundle.bundleId) {
        return a.primitive.bundle.bundleId.localeCompare(b.primitive.bundle.bundleId);
      }
      return a.primitive.path.localeCompare(b.primitive.path);
    });
  }

  /**
   * Rank candidates based on the search query.
   * @param query Search query.
   * @param candidates Set of candidate record indices.
   * @returns Ranking result without facets or timing.
   */
  private rank(query: SearchQuery, candidates: Set<number>): Omit<SearchResult, 'facets' | 'tookMs'> {
    const qTokens = query.q ? tokenize(query.q) : [];
    const { scores, explanations } = this.bm25.score(qTokens, candidates, !!query.explain);

    if (qTokens.length === 0) {
      this.populateZeroScores(scores, candidates);
    }

    const maxScore = this.normalizeScores(scores);
    const useHybrid = (query.ranking === 'hybrid') && !!query.queryEmbedding;
    const alpha = useHybrid ? HYBRID_ALPHA : 1;

    const hits = this.buildHits(scores, maxScore, useHybrid, alpha, query, explanations);
    const sortedHits = this.sortHits(hits);

    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    return {
      total: sortedHits.length,
      hits: sortedHits.slice(offset, offset + limit)
    };
  }

  /**
   * Build search hits from scores and explanations.
   * @param scores Map of record indices to scores.
   * @param maxScore Maximum score for normalization.
   * @param useHybrid Whether to use hybrid scoring.
   * @param alpha Weight for BM25 vs cosine similarity.
   * @param query Search query.
   * @param explanations Optional match explanations.
   * @returns List of search hits.
   */
  private buildHits(
    scores: Map<number, number>,
    maxScore: number,
    useHybrid: boolean,
    alpha: number,
    query: SearchQuery,
    explanations: Map<number, { field: SearchableField; term: string; weight: number; contribution: number }[]> | undefined
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const [idx, raw] of scores) {
      const score = this.computeScore(
        raw,
        maxScore,
        useHybrid,
        this.records[idx].embedding,
        query.queryEmbedding,
        alpha
      );
      hits.push(this.buildSearchHit(idx, score, explanations));
    }
    return hits;
  }

  /**
   * Increment a count in a record.
   * @param map Record of counts.
   * @param key Key to increment.
   */
  private incrementCount(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
  }

  /**
   * Count tags and update tag counts map.
   * @param tags List of tags.
   * @param tagCounts Map of tag counts.
   */
  private countTags(tags: string[], tagCounts: Record<string, number>): void {
    for (const t of tags) {
      this.incrementCount(tagCounts, t);
    }
  }

  /**
   * Compute facet counts for a set of candidates.
   * @param candidates Set of candidate record indices.
   * @returns Facet counts for kinds, sources, and tags.
   */
  private facetCounts(candidates: Set<number>): SearchResult['facets'] {
    const kinds: Record<string, number> = {};
    const sources: Record<string, number> = {};
    const tags: Record<string, number> = {};
    for (const idx of candidates) {
      const p = this.records[idx].primitive;
      this.incrementCount(kinds, p.kind);
      this.incrementCount(sources, p.bundle.sourceId);
      this.countTags(p.tags, tags);
    }
    return { kinds, sources, tags };
  }

  // --- Queries -----------------------------------------------------------

  /**
   * Get a primitive by its ID.
   * @param primitiveId Primitive ID.
   * @returns Primitive or undefined if not found.
   */
  public get(primitiveId: string): Primitive | undefined {
    const idx = this.byId.get(primitiveId);
    return idx === undefined ? undefined : this.records[idx].primitive;
  }

  /**
   * Get all primitives in the index.
   * @returns Array of all primitives.
   */
  public all(): Primitive[] {
    return this.records.map((r) => r.primitive);
  }

  /**
   * Get index statistics.
   * @returns Index statistics including counts and metadata.
   */
  public stats(): IndexStats {
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const bundles = new Set<string>();
    for (const r of this.records) {
      byKind[r.primitive.kind] = (byKind[r.primitive.kind] ?? 0) + 1;
      bySource[r.primitive.bundle.sourceId] = (bySource[r.primitive.bundle.sourceId] ?? 0) + 1;
      bundles.add(`${r.primitive.bundle.sourceId}::${r.primitive.bundle.bundleId}`);
    }
    return {
      primitives: this.records.length,
      byKind,
      bySource,
      bundles: bundles.size,
      shortlists: this.shortlists.size,
      builtAt: this.meta.builtAt
    };
  }

  /**
   * Search the index for primitives matching the query.
   * @param query Search query with filters and options.
   * @returns Search results including hits, facets, and timing.
   */
  public search(query: SearchQuery): SearchResult {
    const t0 = Date.now();
    const filtered = this.filter(query);
    const result = this.rank(query, filtered);
    return {
      ...result,
      facets: this.facetCounts(filtered),
      tookMs: Date.now() - t0
    };
  }

  // --- Shortlists --------------------------------------------------------

  /**
   * Create a new shortlist.
   * @param name Shortlist name.
   * @param description Optional description.
   * @returns Created shortlist.
   */
  public createShortlist(name: string, description?: string): Shortlist {
    const now = new Date().toISOString();
    const sl: Shortlist = {
      id: randomId('sl'),
      name: name.trim() || 'Untitled',
      description,
      primitiveIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.shortlists.set(sl.id, sl);
    return sl;
  }

  /**
   * List all shortlists sorted by creation time.
   * @returns Array of shortlists.
   */
  public listShortlists(): Shortlist[] {
    return Array.from(this.shortlists.values()).toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Get a shortlist by ID.
   * @param id Shortlist ID.
   * @returns Shortlist or undefined if not found.
   */
  public getShortlist(id: string): Shortlist | undefined {
    return this.shortlists.get(id);
  }

  /**
   * Delete a shortlist by ID.
   * @param id Shortlist ID.
   * @returns True if the shortlist was deleted, false otherwise.
   */
  public deleteShortlist(id: string): boolean {
    return this.shortlists.delete(id);
  }

  /**
   * Add a primitive to a shortlist.
   * @param id Shortlist ID.
   * @param primitiveId Primitive ID to add.
   * @returns Updated shortlist.
   */
  public addToShortlist(id: string, primitiveId: string): Shortlist {
    const sl = this.shortlists.get(id);
    if (!sl) {
      throw new Error(`Unknown shortlist: ${id}`);
    }
    if (!this.byId.has(primitiveId)) {
      throw new Error(`Unknown primitive: ${primitiveId}`);
    }
    if (!sl.primitiveIds.includes(primitiveId)) {
      sl.primitiveIds.push(primitiveId);
      sl.updatedAt = new Date().toISOString();
    }
    return sl;
  }

  /**
   * Remove a primitive from a shortlist.
   * @param id Shortlist ID.
   * @param primitiveId Primitive ID to remove.
   * @returns Updated shortlist.
   */
  public removeFromShortlist(id: string, primitiveId: string): Shortlist {
    const sl = this.shortlists.get(id);
    if (!sl) {
      throw new Error(`Unknown shortlist: ${id}`);
    }
    const before = sl.primitiveIds.length;
    sl.primitiveIds = sl.primitiveIds.filter((p) => p !== primitiveId);
    if (sl.primitiveIds.length !== before) {
      sl.updatedAt = new Date().toISOString();
    }
    return sl;
  }

  // --- Refresh -----------------------------------------------------------

  /**
   * Refresh the index with new primitives from the provider.
   * @param provider Bundle provider to harvest primitives from.
   * @param opts Refresh options.
   * @returns Refresh report with change summary.
   */
  public async refresh(provider: BundleProvider, opts: RefreshOptions = {}): Promise<RefreshReport> {
    const incoming = await harvest(provider, { maxFilesPerBundle: opts.maxFilesPerBundle });
    const nextById = new Map<string, Primitive>();
    for (const p of incoming) {
      nextById.set(p.id, p);
    }

    const changes = this.computeChanges(nextById);
    this.cleanupShortlists(changes.removed);

    await this.reset(Array.from(nextById.values()), opts);
    return { added: changes.added, updated: changes.updated, removed: changes.removed, unchanged: changes.unchanged };
  }

  // --- Persistence hooks (used by store.ts) ------------------------------

  /**
   * Serialize the index to JSON for persistence.
   * @returns JSON-serializable object.
   */
  public toJSON(): unknown {
    return {
      schemaVersion: this.meta.schemaVersion,
      builtAt: this.meta.builtAt,
      hubId: this.meta.hubId,
      embeddingsMeta: this.meta.embeddingsMeta ?? null,
      primitives: this.records.map((r) => ({
        ...r.primitive,
        embedding: r.embedding ? Array.from(r.embedding) : undefined
      })),
      shortlists: Array.from(this.shortlists.values())
    };
  }

  /**
   * Deserialize an index from JSON.
   * @param raw JSON object.
   * @returns PrimitiveIndex instance.
   */
  public static fromJSON(raw: unknown): PrimitiveIndex {
    const idx = new PrimitiveIndex();
    const data = raw as {
      schemaVersion: number;
      builtAt?: string;
      hubId?: string;
      embeddingsMeta?: { provider: string; dim: number } | null;
      primitives: (Primitive & { embedding?: number[] })[];
      shortlists?: Shortlist[];
    };
    if (!data?.schemaVersion || data.schemaVersion !== 1) {
      throw new Error(`Unsupported primitive-index schemaVersion: ${String(data?.schemaVersion)}`);
    }
    const primitives = data.primitives.map((p) => {
      // Runtime validation: kind must be recognised.
      if (!PRIMITIVE_KINDS.includes(p.kind)) {
        throw new Error(`Invalid kind "${p.kind}" for primitive ${p.id}`);
      }
      return p;
    });
    idx.records = primitives.map((p) => ({
      primitive: {
        id: p.id,
        bundle: p.bundle,
        kind: p.kind,
        path: p.path,
        title: p.title,
        description: p.description,
        tags: p.tags,
        authors: p.authors,
        applyTo: p.applyTo,
        tools: p.tools,
        model: p.model,
        bodyPreview: p.bodyPreview,
        contentHash: p.contentHash,
        rating: p.rating,
        updatedAt: p.updatedAt
      },
      fields: tokenizeFields(p),
      embedding: p.embedding ? new Float32Array(p.embedding) : undefined
    }));
    idx.byId = new Map(idx.records.map((r, i) => [r.primitive.id, i]));
    idx.rebuildBm25();
    idx.rebuildFacets();
    idx.meta = {
      schemaVersion: 1,
      builtAt: data.builtAt ?? new Date(0).toISOString(),
      hubId: data.hubId,
      embeddingsMeta: data.embeddingsMeta ?? undefined
    };
    for (const sl of data.shortlists ?? []) {
      idx.shortlists.set(sl.id, { ...sl });
    }
    return idx;
  }
}

function addTo(map: Map<string, Set<number>>, key: string, idx: number): void {
  const s = map.get(key);
  if (s) {
    s.add(idx);
  } else {
    map.set(key, new Set([idx]));
  }
}

function intersectSets(a: Set<number>, b: Set<number>): Set<number> {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<number>();
  for (const v of small) {
    if (big.has(v)) {
      out.add(v);
    }
  }
  return out;
}

function intersectFacet(
  candidates: Set<number>,
  map: Map<string, Set<number>>,
  keys: string[] | undefined,
  lower = false
): Set<number> {
  if (!keys || keys.length === 0) {
    return candidates;
  }
  const union = new Set<number>();
  for (const raw of keys) {
    const key = lower ? raw.toLowerCase() : raw;
    const bucket = map.get(key);
    if (bucket) {
      for (const v of bucket) {
        union.add(v);
      }
    }
  }
  return intersectSets(candidates, union);
}

// Re-exports so consumers can `import from './primitive-index'`.

export { SEARCHABLE_FIELDS } from './tuning';
