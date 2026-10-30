/**
 * Release existence behind the source/authentication boundary (COL002 evidence).
 * @module ports/release-lookup
 */

/** Canonical collection identity; never a repository-prefixed runtime bundle ID. */
export interface GovernanceCollection {
  id: string;
  name?: string;
  sourceId: string;
  repository?: string;
  file?: string;
}

export interface ReleaseLookupResult {
  status: 'published' | 'missing' | 'unverified';
  /** Why the release could not be verified. */
  message?: string;
  /** How to fix it. */
  hint?: string;
}

/** "Does a published release exist for this collection id?" */
export interface ReleaseLookup {
  lookup(collection: GovernanceCollection): Promise<ReleaseLookupResult>;
}
