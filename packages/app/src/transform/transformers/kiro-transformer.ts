/**
 * KiroTransformer — transforms content for Kiro target runtime.
 *
 * Kiro requires the agent name in frontmatter to be mandatory:
 * https://kiro.dev/docs/chat/subagents/
 *
 * This transformer ensures that agent files have a 'name' field in their
 * frontmatter. If missing, it derives the name from the title field or
 * the filename.
 *
 * Idempotent: If the name field already exists, the content is unchanged.
 * Fail-safe: On parsing errors, returns the original content.
 */
import type {
  ResourceTransformer,
  TransformContext,
  TransformResult,
} from '@prompt-registry/core';
import {
  changed,
  noChange,
  parseFrontmatter,
} from '@prompt-registry/core';

/**
 * Transformer for Kiro-specific requirements.
 */
export class KiroTransformer implements ResourceTransformer {
  /**
   * Extract a name from a file path.
   * @param filePath - Bundle-relative file path.
   * @returns Derived name.
   */
  private extractNameFromPath(filePath: string): string {
    // Remove 'agents/' prefix and '.md' extension
    const baseName = filePath.replace(/^agents\//, '').replace(/\.md$/, '');
    // Convert kebab-case to title case
    return baseName
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Serialize frontmatter back to the file content.
   * @param frontmatter - Frontmatter object.
   * @param originalContent - Original file content.
   * @returns Updated content with new frontmatter.
   */
  private serializeFrontmatter(frontmatter: Record<string, unknown>, originalContent: string): string {
    const lines = originalContent.split('\n');
    const frontmatterEndIndex = lines.indexOf('---');

    if (frontmatterEndIndex === -1) {
      // No frontmatter found, prepend it
      const prependedYaml = this.objectToYaml(frontmatter);
      return `---\n${prependedYaml}---\n${originalContent}`;
    }

    const secondSeparatorIndex = lines.findIndex((line, idx) => idx > frontmatterEndIndex && line === '---');

    if (secondSeparatorIndex === -1) {
      // Malformed frontmatter, return original
      return originalContent;
    }

    // Replace existing frontmatter
    const yamlLines = this.objectToYaml(frontmatter);
    const beforeFrontmatter = lines.slice(0, frontmatterEndIndex + 1);
    const afterFrontmatter = lines.slice(secondSeparatorIndex);

    return [...beforeFrontmatter, yamlLines, ...afterFrontmatter].join('\n');
  }

  /**
   * Convert an object to YAML string.
   * Simple implementation for common cases.
   * @param obj - Object to convert.
   * @returns YAML string.
   */
  private objectToYaml(obj: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) {
        continue;
      }
      if (typeof value === 'string') {
        lines.push(`${key}: "${value}"`);
      } else if (typeof value === 'boolean' || value === null) {
        lines.push(`${key}: ${String(value)}`);
      } else if (Array.isArray(value)) {
        lines.push(`${key}:`);
        for (const item of value) {
          if (typeof item === 'string') {
            lines.push(`  - "${item}"`);
          } else {
            lines.push(`  - ${String(item)}`);
          }
        }
      } else if (typeof value === 'number') {
        lines.push(`${key}: ${value}`);
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Transform file content for Kiro runtime.
   * Only transforms agent files (agents/*.md).
   * @param context - Transformation context.
   * @returns TransformResult.
   */
  public transform(context: TransformContext): TransformResult {
    // Only transform agent files
    if (!context.filePath.startsWith('agents/')) {
      return noChange(context.content);
    }

    // Skip non-markdown files
    if (!context.filePath.endsWith('.md')) {
      return noChange(context.content);
    }

    try {
      const frontmatter = parseFrontmatter(context.content);

      // Check if frontmatter markers exist in content
      const hasFrontmatterMarkers = context.content.startsWith('---')
        && context.content.includes('---', 3);

      // If no frontmatter markers exist, return original content (fail-safe)
      if (!hasFrontmatterMarkers) {
        return noChange(context.content);
      }

      // If name field already exists, no transformation needed
      if (frontmatter !== null && frontmatter.name !== undefined) {
        return noChange(context.content);
      }

      // Derive name from title or filename
      const derivedName = (frontmatter?.title) ?? this.extractNameFromPath(context.filePath);

      // Update frontmatter with name field (create new if null)
      const updatedFrontmatter = frontmatter === null
        ? { name: derivedName }
        : { ...frontmatter, name: derivedName };
      const updatedContent = this.serializeFrontmatter(updatedFrontmatter, context.content);

      return changed(updatedContent);
    } catch {
      // Fail-safe: on parsing error, return original content
      return noChange(context.content);
    }
  }
}
