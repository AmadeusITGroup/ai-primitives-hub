import {
  EngagementResourceType,
  RatingScore,
} from './engagement';

/**
 * Feedback that has been submitted locally but may not yet be synced to the remote backend.
 */
export interface PendingFeedback {
  /** Unique ID for this pending entry */
  id: string;
  /** Bundle ID */
  bundleId: string;
  /** Source ID for routing */
  sourceId: string;
  /** Hub ID for backend selection */
  hubId: string;
  /** Resource type */
  resourceType: EngagementResourceType;
  /** User's rating (1-5) */
  rating: RatingScore;
  /** Optional comment */
  comment?: string;
  /** ISO timestamp of submission */
  timestamp: string;
  /** Whether this feedback has been synced to the remote backend */
  synced: boolean;
}
