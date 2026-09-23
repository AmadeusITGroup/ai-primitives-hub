/**
 * Compatibility key for a persisted primitive index.
 */
export interface PrimitiveIndexKey {
  /** Stable identity of the hub whose sources were harvested. */
  hubId: string;
  /** Stable source snapshot/revision represented by the index. */
  sourceRevision: string;
  /** Versioned search/ranking/embedding profile. */
  searchProfileId: string;
}

/**
 * Resolves logical primitive-index keys to physical cache locations.
 *
 * The port intentionally resolves a path rather than reading or writing it;
 * persistence remains owned by the existing index serializer and can retain
 * its atomic-write/last-known-good policy independently of path resolution.
 */
export interface PrimitiveIndexStore {
  /** Resolve a namespaced persisted index path. */
  getIndexPath(key: PrimitiveIndexKey): string;
  /**
   * Find a usable index for a hub and profile when the requested snapshot is
   * unavailable. When source IDs are supplied, compatible snapshots are
   * preferred over newer snapshots from an incompatible source snapshot.
   */
  findLatestIndexPath?(
    hubId: string,
    searchProfileId: string,
    sourceIds?: readonly string[]
  ): Promise<string | undefined>;
}
