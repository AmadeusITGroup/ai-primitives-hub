/**
 * ResourceTransformer port.
 *
 * Transforms file content before writing to a target to meet
 * runtime-specific requirements (e.g., ensuring mandatory frontmatter
 * fields for Kiro, adjusting formatting for VS Code, etc.).
 *
 * Implementations must be:
 * - Idempotent: Applying the transformation multiple times yields the same result
 * - Independent: Each transformation should not depend on other transformations
 * - Fail-safe: On error, return the original content (log warning separately)
 * @module ports/resource-transformer
 */
import type {
  TransformContext,
  TransformResult,
} from '../domain/install/transform';

/**
 * Transforms file content based on target type and file path.
 * Implementations are registered per target type and applied
 * during the write stage of the install pipeline.
 */
export interface ResourceTransformer {
  /**
   * Transform file content based on target type and file path.
   * @param context - Transformation context including target, file path, and original content.
   * @returns TransformResult with transformed content and modification flag.
   */
  transform(context: TransformContext): TransformResult;
}
