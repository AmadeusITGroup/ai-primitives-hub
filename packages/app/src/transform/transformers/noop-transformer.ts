/**
 * NoOpTransformer — pass-through transformer that performs no transformations.
 *
 * Used as the default/fallback for target types that don't have
 * specific transformation requirements. Returns the original content
 * unchanged.
 */
import type {
  ResourceTransformer,
  TransformContext,
  TransformResult,
} from '@prompt-registry/core';
import {
  noChange,
} from '@prompt-registry/core';

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
