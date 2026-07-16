/**
 * Discovery domain types.
 *
 * Core type definitions for AI-powered resource discovery. These types
 * are pure and have no dependencies on feature layers.
 *
 * Ported unchanged from the reference branch's
 * `core/src/domain/discovery/types.ts`.
 * @module domain/discovery/types
 */

/**
 * Resource type discriminator.
 */
export type ResourceType = 'profile' | 'bundle' | 'primitive';

/**
 * Branded type for recommendation ID to prevent confusion.
 */
export type RecommendationId = string & { readonly _BRAND: 'RecommendationId' };

/**
 * Branded type for profile draft ID to prevent confusion.
 */
export type ProfileDraftId = string & { readonly _BRAND: 'ProfileDraftId' };

/**
 * Resource recommendation with AI reasoning.
 */
export interface ResourceRecommendation {
  /** Resource type: profile, bundle, or primitive */
  readonly type: ResourceType;
  /** Unique resource identifier */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Brief description */
  readonly description: string;
  /** Relevance score (0-1) */
  readonly relevanceScore: number;
  /** AI-generated reasoning for recommendation */
  readonly reasoning: string;
  /** Source hub or repository */
  readonly source: string;
  /** Primitive kind (if applicable) */
  readonly kind?: string;
  /** Whether this is recommended by AI */
  readonly aiRecommended: boolean;
}

/**
 * User selection from recommendations.
 */
export interface ResourceSelection {
  /** Resource identifier */
  readonly id: string;
  /** Whether selected */
  readonly selected: boolean;
  /** Selection timestamp */
  readonly selectedAt?: string;
}

/**
 * Profile draft for generation.
 */
export interface ProfileDraft {
  /** Profile ID */
  readonly id: string;
  /** Profile name */
  readonly name: string;
  /** Profile description */
  readonly description: string;
  /** Profile icon */
  readonly icon?: string;
  /** Selected resources */
  readonly selections: readonly ResourceSelection[];
  /** Draft creation timestamp */
  readonly createdAt: string;
}

/**
 * Discovery options.
 */
export interface DiscoveryOptions {
  /** Enable AI-powered recommendations */
  readonly enableAI: boolean;
  /** Enable interactive mode */
  readonly interactive: boolean;
  /** Working directory */
  readonly cwd: string;
  /** Index file path */
  readonly indexFile?: string;
  /** Maximum recommendations */
  readonly limit?: number;
  /** Filter by primitive kinds */
  readonly kinds?: readonly string[];
}
