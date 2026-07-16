/**
 * ClaudeCodeTransformer — transforms content for the Claude Code target runtime.
 *
 * Claude Code subagents (`.claude/agents/*.md`) require both `name` and
 * `description` in their YAML frontmatter — the only two mandatory
 * fields of the subagent spec:
 * @see https://code.claude.com/docs/en/sub-agents
 *
 * This transformer ensures agent files have both fields, deriving
 * whichever is missing:
 * - `name`: from an existing `title` field, or the filename — same
 *   derivation as `KiroTransformer`.
 * - `description`: from the first non-empty, non-heading line of the
 *   file body — matching Claude Code's own documented fallback for a
 *   missing slash-command `description` ("defaults to the first line
 *   of the command prompt"), reused here since agents live in the same
 *   spec family. Falls back to a generic `"<name> agent"` description
 *   if the body has no usable line either, so the field is never left
 *   absent.
 *
 * Idempotent: fields that are already present are left untouched;
 * unlike `KiroTransformer` (which only ever manages one field), this
 * checks `name` and `description` independently, only filling in
 * whichever is missing.
 * Fail-safe: on parsing errors, returns the original content.
 * @module transform/transformers/claude-code-transformer
 */
import type {
  ResourceTransformer,
  TransformContext,
  TransformResult,
} from '@ai-primitives-hub/core';
import {
  changed,
  noChange,
  parseFrontmatter,
} from '@ai-primitives-hub/core';

/**
 * Transformer for Claude Code-specific requirements.
 */
export class ClaudeCodeTransformer implements ResourceTransformer {
  /**
   * Derive a human-readable name from a bundle-relative file path.
   * @param filePath - Bundle-relative file path.
   * @returns Derived name.
   */
  private extractNameFromPath(filePath: string): string {
    const baseName = filePath.replace(/^agents\//, '').replace(/\.md$/, '');
    return baseName
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Derive a fallback description from the first non-empty, non-heading
   * line of the file body (the part after the closing frontmatter marker).
   * @param originalContent - Original file content.
   * @returns Derived description, or undefined if the body has no usable line.
   */
  private extractDescriptionFromBody(originalContent: string): string | undefined {
    const lines = originalContent.split('\n');
    const frontmatterEndIndex = lines.indexOf('---');
    const secondSeparatorIndex = lines.findIndex((line, idx) => idx > frontmatterEndIndex && line === '---');
    const bodyLines = secondSeparatorIndex === -1 ? [] : lines.slice(secondSeparatorIndex + 1);

    for (const line of bodyLines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('#')) {
        return trimmed;
      }
    }
    return undefined;
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
      const newYaml = this.objectToYaml(frontmatter);
      return `---\n${newYaml}---\n${originalContent}`;
    }

    const secondSeparatorIndex = lines.findIndex((line, idx) => idx > frontmatterEndIndex && line === '---');

    if (secondSeparatorIndex === -1) {
      // Malformed frontmatter, return original
      return originalContent;
    }

    const yamlContent = this.objectToYaml(frontmatter);
    const beforeFrontmatter = lines.slice(0, frontmatterEndIndex + 1);
    const afterFrontmatter = lines.slice(secondSeparatorIndex);

    return [...beforeFrontmatter, yamlContent, ...afterFrontmatter].join('\n');
  }

  /**
   * Convert an object to YAML string. Simple implementation for common cases.
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
        lines.push(`${key}: ${value}`);
      } else if (Array.isArray(value)) {
        lines.push(`${key}:`);
        for (const item of value) {
          if (typeof item === 'string') {
            lines.push(`  - "${item}"`);
          } else {
            lines.push(`  - ${String(item)}`);
          }
        }
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Transform file content for the Claude Code runtime.
   * Only transforms agent files (agents/*.md).
   * @param context - Transformation context.
   * @returns TransformResult.
   */
  public transform(context: TransformContext): TransformResult {
    if (!context.filePath.startsWith('agents/')) {
      return noChange(context.content);
    }

    if (!context.filePath.endsWith('.md')) {
      return noChange(context.content);
    }

    try {
      const frontmatter = parseFrontmatter(context.content);

      const hasFrontmatterMarkers = context.content.startsWith('---')
        && context.content.includes('---', 3);

      if (!hasFrontmatterMarkers) {
        return noChange(context.content);
      }

      const needsName = frontmatter === null || frontmatter.name === undefined;
      const needsDescription = frontmatter === null || frontmatter.description === undefined;

      if (!needsName && !needsDescription) {
        return noChange(context.content);
      }

      const updatedFrontmatter: Record<string, unknown> = frontmatter === null ? {} : { ...frontmatter };

      if (needsName) {
        updatedFrontmatter.name = (frontmatter?.title) ?? this.extractNameFromPath(context.filePath);
      }
      if (needsDescription) {
        updatedFrontmatter.description = this.extractDescriptionFromBody(context.content)
          ?? `${String(updatedFrontmatter.name)} agent`;
      }

      const updatedContent = this.serializeFrontmatter(updatedFrontmatter, context.content);

      return changed(updatedContent);
    } catch {
      // Fail-safe: on parsing error, return original content
      return noChange(context.content);
    }
  }
}
