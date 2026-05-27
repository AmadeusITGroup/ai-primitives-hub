/**
 * Minimal BM25 engine over pre-tokenised documents with weighted fields.
 *
 * Determinism: stable tie-breaker ordering is the caller's responsibility;
 * this module only produces raw scores.
 */

import {
  BM25,
  FIELD_WEIGHTS,
  SEARCHABLE_FIELDS,
  type SearchableField,
} from './tuning';

/**
 * Type for field tokens.
 * Maps searchable fields to their token arrays.
 */
export type FieldTokens = Record<SearchableField, string[]>;

/**
 * BM25 document with ID and tokenized fields.
 */
export interface Bm25Doc {
  id: string;
  fields: FieldTokens;
}

/**
 * Internal posting list entry.
 */
interface PostingEntry {
  docIdx: number;
  tf: number;
}

/**
 * BM25 statistics for a term.
 */
export interface Bm25Stats {
  field: SearchableField;
  term: string;
  idf: number;
  /** Sum of BM25 contributions across matching docs (for debugging only). */
  total: number;
}

/**
 * Parameters for BM25 scoring.
 */
interface ScoreParams {
  k1: number;
  b: number;
}

/**
 * Output maps for scoring.
 */
interface ScoreOutput {
  scores: Map<number, number>;
  explanations?: Map<number, { field: SearchableField; term: string; weight: number; contribution: number }[]>;
}
/**
 * Context passed to scorePostings.
 */
interface TermScoringContext {
  field: SearchableField;
  term: string;
  fieldWeight: number;
  idf: number;
}

/**
 * BM25 search engine.
 * Computes BM25 scores for pre-tokenized documents with weighted fields.
 */
export class Bm25Engine {
  private readonly docs: Bm25Doc[];
  /** For each field: map term → postings. */
  private readonly postings: Record<SearchableField, Map<string, PostingEntry[]>>;
  /** For each field: per-doc length (token count). */
  private readonly docLens: Record<SearchableField, number[]>;
  private readonly avgLens: Record<SearchableField, number>;

  /**
   * Construct a BM25 engine from documents.
   * @param docs Array of BM25 documents.
   */
  constructor(docs: Bm25Doc[]) {
    this.docs = docs;
    const { postings, docLens } = this.initializeFieldMaps();
    this.indexDocuments(docs, postings, docLens);
    const avgLens = this.computeAverageLengths(docLens);
    this.postings = postings;
    this.docLens = docLens;
    this.avgLens = avgLens;
  }

  /**
   * Initialize field maps for posting lists and document lengths.
   * @returns Initialized postings and docLens maps.
   */
  private initializeFieldMaps(): {
    postings: Record<SearchableField, Map<string, PostingEntry[]>>;
    docLens: Record<SearchableField, number[]>;
  } {
    const postings = {} as Record<SearchableField, Map<string, PostingEntry[]>>;
    const docLens = {} as Record<SearchableField, number[]>;
    for (const field of SEARCHABLE_FIELDS) {
      postings[field] = new Map();
      docLens[field] = Array.from<number>({ length: this.docs.length }).fill(0);
    }
    return { postings, docLens };
  }

  /**
   * Build term frequency map from token array.
   * @param tokens Array of tokens.
   * @returns Map of term to frequency count.
   */
  private buildTermFrequencyMap(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    return tf;
  }

  /**
   * Add a posting entry to the inverted index.
   * @param postings Postings map.
   * @param field Searchable field.
   * @param term Term to add.
   * @param docIdx Document index.
   * @param count Term frequency count.
   */
  private addPostingEntry(
    postings: Record<SearchableField, Map<string, PostingEntry[]>>,
    field: SearchableField,
    term: string,
    docIdx: number,
    count: number
  ): void {
    const list = postings[field].get(term);
    if (list) {
      list.push({ docIdx, tf: count });
    } else {
      postings[field].set(term, [{ docIdx, tf: count }]);
    }
  }

  /**
   * Process a single document and build its posting entries.
   * @param docIdx Document index.
   * @param doc Document to process.
   * @param postings Postings map to update.
   * @param docLens Document lengths map to update.
   */
  private processDocument(
    docIdx: number,
    doc: Bm25Doc,
    postings: Record<SearchableField, Map<string, PostingEntry[]>>,
    docLens: Record<SearchableField, number[]>
  ): void {
    for (const field of SEARCHABLE_FIELDS) {
      const tokens = doc.fields[field] ?? [];
      docLens[field][docIdx] = tokens.length;
      const tf = this.buildTermFrequencyMap(tokens);
      for (const [term, count] of tf) {
        this.addPostingEntry(postings, field, term, docIdx, count);
      }
    }
  }

  /**
   * Compute average document lengths for each field.
   * @param docLens Document lengths map.
   * @returns Map of field to average length.
   */
  private computeAverageLengths(
    docLens: Record<SearchableField, number[]>
  ): Record<SearchableField, number> {
    const avgLens = {} as Record<SearchableField, number>;
    for (const field of SEARCHABLE_FIELDS) {
      const lens = docLens[field];
      const total = lens.reduce((acc, n) => acc + n, 0);
      avgLens[field] = lens.length > 0 ? total / lens.length : 0;
    }
    return avgLens;
  }

  /**
   * Index all documents and build posting lists.
   * @param docs Documents to index.
   * @param postings Postings map to update.
   * @param docLens Document lengths map to update.
   */
  private indexDocuments(
    docs: Bm25Doc[],
    postings: Record<SearchableField, Map<string, PostingEntry[]>>,
    docLens: Record<SearchableField, number[]>
  ): void {
    for (const [i, doc] of docs.entries()) {
      this.processDocument(i, doc, postings, docLens);
    }
  }

  /**
   * Score all fields for the given unique terms.
   * @param uniqueTerms Set of unique query terms.
   * @param k1 BM25 k1 parameter.
   * @param b BM25 b parameter.
   * @param candidates Optional candidate set.
   * @param scores Score map to update.
   * @param explanations Explanation map to update.
   */
  private scoreFields(
    uniqueTerms: Set<string>,
    k1: number,
    b: number,
    candidates: Set<number> | undefined,
    scores: Map<number, number>,
    explanations: Map<number, { field: SearchableField; term: string; weight: number; contribution: number }[]> | undefined
  ): void {
    for (const field of SEARCHABLE_FIELDS) {
      this.scoreFieldTerms(field, uniqueTerms, k1, b, candidates, scores, explanations);
    }
  }

  /**
   * Score terms for a specific field.
   * @param field Searchable field.
   * @param uniqueTerms Set of unique query terms.
   * @param k1 BM25 k1 parameter.
   * @param b BM25 b parameter.
   * @param candidates Optional candidate set.
   * @param scores Score map to update.
   * @param explanations Explanation map to update.
   */
  private scoreFieldTerms(
    field: SearchableField,
    uniqueTerms: Set<string>,
    k1: number,
    b: number,
    candidates: Set<number> | undefined,
    scores: Map<number, number>,
    explanations: Map<number, { field: SearchableField; term: string; weight: number; contribution: number }[]> | undefined
  ): void {
    const fieldWeight = FIELD_WEIGHTS[field];
    const params: ScoreParams = { k1, b };
    const output: ScoreOutput = { scores, explanations };
    for (const term of uniqueTerms) {
      this.scoreTerm(term, field, fieldWeight, params, candidates, output);
    }
  }

  /**
   * Get the number of documents in the index.
   * @returns Document count.
   */
  public get size(): number {
    return this.docs.length;
  }

  /**
   * IDF (Okapi variant, clamped to >=0).
   * @param field Searchable field.
   * @param term Term to compute IDF for.
   * @returns IDF score.
   */
  private idf(field: SearchableField, term: string): number {
    const postings = this.postings[field].get(term);
    if (!postings) {
      return 0;
    }
    const n = this.docs.length;
    const df = postings.length;
    const raw = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    return Math.max(raw, 0);
  }

  /**
   * Compute TF saturation score.
   * @param tf Term frequency.
   * @param k1 BM25 k1 parameter.
   * @param b BM25 b parameter.
   * @param dl Document length.
   * @param avg Average document length.
   * @returns TF saturation score.
   */
  private computeTfSat(tf: number, k1: number, b: number, dl: number, avg: number): number {
    const norm = 1 - b + b * (dl / avg);
    return (tf * (k1 + 1)) / (tf + k1 * norm);
  }

  /**
   * Update score and explanation for a document.
   * @param scores Score map to update.
   * @param explanations Explanation map to update.
   * @param docIdx Document index.
   * @param field Searchable field.
   * @param term Matched term.
   * @param fieldWeight Field weight.
   * @param contribution Score contribution.
   */
  private updateScoreAndExplanation(
    scores: Map<number, number>,
    explanations: Map<number, { field: SearchableField; term: string; weight: number; contribution: number }[]> | undefined,
    docIdx: number,
    field: SearchableField,
    term: string,
    fieldWeight: number,
    contribution: number
  ): void {
    scores.set(docIdx, (scores.get(docIdx) ?? 0) + contribution);
    if (explanations) {
      const arr = explanations.get(docIdx) ?? [];
      arr.push({ field, term, weight: fieldWeight, contribution });
      explanations.set(docIdx, arr);
    }
  }

  /**
   * Score a single term against the index.
   * @param term Term to score.
   * @param field Searchable field.
   * @param fieldWeight Field weight.
   * @param params BM25 parameters.
   * @param candidates Optional candidate set.
   * @param output Output array to update.
   */
  private scoreTerm(
    term: string,
    field: SearchableField,
    fieldWeight: number,
    params: ScoreParams,
    candidates: Set<number> | undefined,
    output: ScoreOutput
  ): void {
    const postings = this.postings[field];
    const list = postings.get(term);
    if (!list) {
      return;
    }
    const idf = this.idf(field, term);
    if (idf === 0) {
      return;
    }
    this.scorePostings(list, { field, term, fieldWeight, idf }, params, candidates, output);
  }

  /**
   * Score posting list entries.
   * @param list Posting entries.
   * @param ctx Term scoring context.
   * @param params BM25 parameters.
   * @param candidates Optional candidate set.
   * @param output Score output maps.
   */
  private scorePostings(
    list: PostingEntry[],
    ctx: TermScoringContext,
    params: ScoreParams,
    candidates: Set<number> | undefined,
    output: ScoreOutput
  ): void {
    const { field, term, fieldWeight, idf } = ctx;
    const lens = this.docLens[field];
    const avg = this.avgLens[field] || 1;
    for (const { docIdx, tf } of list) {
      if (candidates && !candidates.has(docIdx)) {
        continue;
      }
      const dl = lens[docIdx];
      const tfSat = this.computeTfSat(tf, params.k1, params.b, dl, avg);
      const contribution = fieldWeight * idf * tfSat;
      this.updateScoreAndExplanation(output.scores, output.explanations, docIdx, field, term, fieldWeight, contribution);
    }
  }

  /**
   * Score the corpus against the given query tokens, optionally restricted
   * to a set of candidate doc indices. Returns per-doc scores and (if
   * `explain`) the breakdown contributions.
   * @param queryTokens Tokenized query.
   * @param candidates Optional candidate set.
   * @param explain Whether to generate explanations.
   * @returns Score map and optional explanations.
   */
  public score(
    queryTokens: string[],
    candidates?: Set<number>,
    explain = false
  ): {
    scores: Map<number, number>;
    explanations?: Map<number, { field: SearchableField; term: string; weight: number; contribution: number }[]>;
  } {
    const scores = new Map<number, number>();
    const explanations = explain ? new Map<number, { field: SearchableField; term: string; weight: number; contribution: number }[]>() : undefined;
    if (queryTokens.length === 0 || this.docs.length === 0) {
      return { scores, explanations };
    }

    const { k1, b } = BM25;
    const uniqueTerms = new Set(queryTokens);
    this.scoreFields(uniqueTerms, k1, b, candidates, scores, explanations);

    return { scores, explanations };
  }
}
