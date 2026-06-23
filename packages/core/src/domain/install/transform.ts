/**
 * Domain types for resource transformation.
 *
 * Transformations adapt runtime-agnostic bundle content to meet
 * specific requirements of different target runtimes (e.g., Kiro
 * requiring mandatory agent name in frontmatter, VS Code considering
 * it optional).
 *
 * Pure domain: no IO, no framework imports, no feature layer imports.
 */
import type {
  Target,
} from './target';

/**
 * Context provided to transformers.
 * Contains all information needed to decide whether and how to transform
 * a file's content.
 */
export interface TransformContext {
  /** Target being written to. */
  readonly target: Target;
  /** Bundle-relative file path (e.g., "agents/my-agent.md"). */
  readonly filePath: string;
  /** Original file content as string. */
  readonly content: string;
}

/**
 * Result of a transformation operation.
 */
export interface TransformResult {
  /** Transformed content. May be identical to original if no change needed. */
  readonly content: string;
  /** Whether the content was actually modified. */
  readonly modified: boolean;
}

/**
 * Create a TransformResult indicating no change.
 * @param content - The (unchanged) content.
 * @returns TransformResult with modified=false.
 */
export const noChange = (content: string): TransformResult => ({
  content,
  modified: false
});

/**
 * Create a TransformResult indicating a change.
 * @param content - The transformed content.
 * @returns TransformResult with modified=true.
 */
export const changed = (content: string): TransformResult => ({
  content,
  modified: true
});
