/**
 * WindsurfTransformer — transforms content for the Windsurf target runtime.
 *
 * Windsurf's modern rules system (`.windsurf/rules/*.md`, replacing the
 * legacy single-file `.windsurfrules`) requires each rule file to declare
 * an activation `trigger` in its YAML frontmatter — one of `always_on`,
 * `model_decision`, `glob`, or `manual` — with `globs` required when
 * `trigger` is `glob`:
 * @see https://docs.windsurf.com/windsurf/cascade/memories#rules
 *
 * `infra`'s `writers/default-layouts.json` routes both `prompts/` and
 * `instructions/` into Windsurf's single `rules/` directory, so both are
 * in scope here (unlike Kiro's transformer, which only touches
 * `agents/`).
 *
 * This transformer:
 * - Maps an existing `applyTo` glob (the VS Code Copilot
 *   `*.instructions.md` convention this project's harvester already
 *   reads, see `infra/harvest/extractor.ts`) onto `trigger: glob` +
 *   `globs: [<applyTo>]`, preserving the original `applyTo` field.
 * - Otherwise defaults to `trigger: model_decision`, deriving a
 *   `description` (required for the model to judge relevance) from an
 *   existing `title`/`description` field or the filename, same
 *   derivation as `KiroTransformer`'s `name`.
 *
 * Idempotent: if `trigger` is already present, the content is
 * unchanged — an explicit existing trigger is never second-guessed.
 * Fail-safe: on parsing errors, returns the original content.
 * @module transform/transformers/windsurf-transformer
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
 * Transformer for Windsurf-specific requirements.
 */
export class WindsurfTransformer implements ResourceTransformer {
  /**
   * Derive a human-readable name from a bundle-relative file path.
   * @param filePath - Bundle-relative file path.
   * @returns Derived name.
   */
  private extractNameFromPath(filePath: string): string {
    const baseName = filePath.replace(/^(prompts|instructions)\//, '').replace(/\.md$/, '');
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
   * Transform file content for the Windsurf runtime.
   * Only transforms rule-routed files (prompts/*.md, instructions/*.md).
   * @param context - Transformation context.
   * @returns TransformResult.
   */
  public transform(context: TransformContext): TransformResult {
    if (!context.filePath.startsWith('prompts/') && !context.filePath.startsWith('instructions/')) {
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

      // If a trigger is already declared, respect it as-is.
      if (frontmatter !== null && frontmatter.trigger !== undefined) {
        return noChange(context.content);
      }

      const applyTo = frontmatter?.applyTo;
      const updatedFrontmatter: Record<string, unknown> = frontmatter === null ? {} : { ...frontmatter };

      if (typeof applyTo === 'string' && applyTo.length > 0) {
        // A VS Code Copilot-style applyTo glob maps directly onto Windsurf's glob trigger.
        updatedFrontmatter.trigger = 'glob';
        updatedFrontmatter.globs = [applyTo];
      } else {
        updatedFrontmatter.trigger = 'model_decision';
        if (updatedFrontmatter.description === undefined) {
          updatedFrontmatter.description = (frontmatter?.title) ?? this.extractNameFromPath(context.filePath);
        }
      }

      const updatedContent = this.serializeFrontmatter(updatedFrontmatter, context.content);

      return changed(updatedContent);
    } catch {
      // Fail-safe: on parsing error, return original content
      return noChange(context.content);
    }
  }
}
