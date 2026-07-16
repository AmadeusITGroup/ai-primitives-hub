/**
 * Unit tests for WindsurfTransformer.
 *
 * New, from-scratch coverage (no reference-branch counterpart exists
 * for this transformer — see its own module header) exercising the
 * researched Windsurf Rules frontmatter contract: a mandatory
 * `trigger` field (`always_on`/`model_decision`/`glob`/`manual`), the
 * `applyTo`-to-`glob` mapping, and the `model_decision` default with
 * derived `description`.
 */
import type {
  Target,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  WindsurfTransformer,
} from '../../src/transform/transformers/windsurf-transformer';

describe('WindsurfTransformer', () => {
  const transformer = new WindsurfTransformer();
  const mockTarget: Target = {
    name: 'test-windsurf',
    type: 'windsurf',
    scope: 'user'
  };

  it('should return no change for files outside prompts/instructions', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: 'some content'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe('some content');
  });

  it('should return no change for non-markdown files', () => {
    const context = {
      target: mockTarget,
      filePath: 'prompts/example.txt',
      content: 'some content'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe('some content');
  });

  it('should return no change when trigger field already exists', () => {
    const context = {
      target: mockTarget,
      filePath: 'prompts/example.md',
      content: '---\ntrigger: "always_on"\ndescription: "Existing"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe(context.content);
  });

  it('should handle malformed frontmatter gracefully', () => {
    const context = {
      target: mockTarget,
      filePath: 'prompts/example.md',
      content: 'no frontmatter here'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe(context.content);
  });

  it('should map an applyTo glob to trigger: glob and globs', () => {
    const context = {
      target: mockTarget,
      filePath: 'instructions/example.md',
      content: '---\napplyTo: "**/*.ts"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('trigger: "glob"');
    expect(result.content).toContain('globs:');
    expect(result.content).toContain('- "**/*.ts"');
    expect(result.content).toContain('applyTo: "**/*.ts"');
  });

  it('should default to trigger: model_decision when no applyTo is present', () => {
    const context = {
      target: mockTarget,
      filePath: 'prompts/example.md',
      content: '---\ntitle: "My Prompt"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('trigger: "model_decision"');
  });

  it('should derive description from title when adding model_decision trigger', () => {
    const context = {
      target: mockTarget,
      filePath: 'prompts/example.md',
      content: '---\ntitle: "My Prompt"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.content).toContain('description: "My Prompt"');
  });

  it('should derive description from filename when title is missing', () => {
    const context = {
      target: mockTarget,
      filePath: 'instructions/my-cool-rule.md',
      content: '---\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('trigger: "model_decision"');
    expect(result.content).toContain('description: "My Cool Rule"');
  });

  it('should preserve an existing description instead of deriving one', () => {
    const context = {
      target: mockTarget,
      filePath: 'prompts/example.md',
      content: '---\ndescription: "Already documented"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('trigger: "model_decision"');
    expect(result.content).toContain('description: "Already documented"');
  });

  it('should transform both prompts/ and instructions/ paths', () => {
    const promptContext = {
      target: mockTarget,
      filePath: 'prompts/a.md',
      content: '---\n---\nContent'
    };
    const instructionContext = {
      target: mockTarget,
      filePath: 'instructions/b.md',
      content: '---\n---\nContent'
    };
    expect(transformer.transform(promptContext).modified).toBe(true);
    expect(transformer.transform(instructionContext).modified).toBe(true);
  });

  it('should be idempotent - applying twice yields same result', () => {
    const context = {
      target: mockTarget,
      filePath: 'prompts/my-prompt.md',
      content: '---\n---\nContent'
    };
    const firstResult = transformer.transform(context);
    const secondResult = transformer.transform({
      target: mockTarget,
      filePath: 'prompts/my-prompt.md',
      content: firstResult.content
    });
    expect(secondResult.modified).toBe(false);
    expect(secondResult.content).toBe(firstResult.content);
  });
});
