/**
 * Domain layer — manifest placement vocabulary.
 *
 * Deployment manifests use the canonical primitive kinds for most entries, while
 * legacy Copilot projections retain the `instructions` and `chatmode` spellings.
 * This type is target-neutral; target-specific filename rules remain in
 * `copilot-file-type.ts`.
 * @module domain/install/manifest-placement-type
 */
import type {
  PrimitiveKind,
} from '../primitive/types';

/**
 * Primitive kinds accepted by a deployment manifest placement, including the
 * legacy spellings emitted by Copilot-compatible manifests.
 */
export type ManifestPlacementType = PrimitiveKind | 'instructions' | 'chatmode';

/**
 * Convert a manifest placement spelling to the canonical primitive kind used by
 * target capability filtering.
 * @param type - Manifest placement type.
 * @returns Canonical primitive kind.
 */
export const manifestPlacementTypeToPrimitiveKind = (
  type: ManifestPlacementType
): PrimitiveKind => type === 'instructions'
  ? 'instruction'
  : (type === 'chatmode' ? 'chat-mode' : type);
