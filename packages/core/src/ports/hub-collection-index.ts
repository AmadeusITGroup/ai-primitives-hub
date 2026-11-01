/**
 * Hub-wide collection ids across enabled collection sources (COL004 evidence).
 * @module ports/hub-collection-index
 */
import type {
  GovernanceCollection,
} from './release-lookup';

export interface HubCollectionInventory {
  collections: GovernanceCollection[];
  /** Discovered collections plus Hub profile references awaiting publication. */
  releaseCandidates?: GovernanceCollection[];
  /** Sources whose collections could not be read: why, and how to fix it. */
  unverifiedSources: { sourceId: string; message: string; hint?: string }[];
}

/** Complete canonical collection inventory from enabled collection sources. */
export interface HubCollectionIndex {
  read(): Promise<HubCollectionInventory>;
}
