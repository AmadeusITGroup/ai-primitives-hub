/**
 * NoOpTransformer — pass-through transformer that performs no transformations.
 *
 * Used as the default/fallback for target types that don't have
 * specific transformation requirements. Returns the original content
 * unchanged.
 *
 * Ported unchanged from the reference branch's
 * `app/src/transform/transformers/noop-transformer.ts`.
 * @module transform/transformers/noop-transformer
 */
import type {
  ResourceTransformer,
  TransformContext,
  TransformResult,
} from '@ai-primitives-hub/core';
import {
  noChange,
} from '@ai-primitives-hub/core';

/**
 * Transformer that performs no transformations.
 * Returns the original content unchanged with modified=false.
 */
export class NoOpTransformer implements ResourceTransformer {
  /**
   * Return the original content unchanged.
   * @param context - Transformation context (ignored).
   * @returns TransformResult with original content and modified=false.
   */
  public transform(context: TransformContext): TransformResult {
    return noChange(context.content);
  }
}
