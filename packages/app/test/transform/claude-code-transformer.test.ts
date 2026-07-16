/**
 * Unit tests for ClaudeCodeTransformer.
 *
 * New, from-scratch coverage (no reference-branch counterpart exists
 * for this transformer — see its own module header) exercising the
 * researched Claude Code subagent frontmatter contract: mandatory
 * `name` and `description` fields, independently backfilled.
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
  ClaudeCodeTransformer,
} from '../../src/transform/transformers/claude-code-transformer';

describe('ClaudeCodeTransformer', () => {
  const transformer = new ClaudeCodeTransformer();
  const mockTarget: Target = {
    name: 'test-claude-code',
    type: 'claude-code',
    scope: 'user'
  };

  it('should return no change for non-agent files', () => {
    const context = {
      target: mockTarget,
      filePath: 'prompts/example.md',
      content: 'some content'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe('some content');
  });

  it('should return no change for non-markdown agent files', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.txt',
      content: 'some content'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe('some content');
  });

  it('should return no change when both name and description already exist', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: '---\nname: "existing-name"\ndescription: "Existing description"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe(context.content);
  });

  it('should handle malformed frontmatter gracefully', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: 'no frontmatter here'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe(context.content);
  });

  it('should add name derived from title when missing, keeping existing description', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: '---\ntitle: "My Agent"\ndescription: "Does things"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('name: "My Agent"');
    expect(result.content).toContain('description: "Does things"');
  });

  it('should add name derived from filename when title is missing', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/my-cool-agent.md',
      content: '---\ndescription: "Does things"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('name: "My Cool Agent"');
  });

  it('should add description derived from the first body line when missing', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: '---\nname: "example"\n---\nReviews code for quality issues.\n\nMore detail here.'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('description: "Reviews code for quality issues."');
  });

  it('should skip markdown heading lines when deriving description from body', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: '---\nname: "example"\n---\n# Example Agent\n\nActual description line.'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('description: "Actual description line."');
  });

  it('should fall back to a generic description when the body has no usable line', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: '---\nname: "example"\n---\n'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('description: "example agent"');
  });

  it('should add both name and description when neither is present', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/my-agent.md',
      content: '---\n---\nHelps with things.'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('name: "My Agent"');
    expect(result.content).toContain('description: "Helps with things."');
  });

  it('should be idempotent - applying twice yields same result', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/my-agent.md',
      content: '---\n---\nHelps with things.'
    };
    const firstResult = transformer.transform(context);
    const secondResult = transformer.transform({
      target: mockTarget,
      filePath: 'agents/my-agent.md',
      content: firstResult.content
    });
    expect(secondResult.modified).toBe(false);
    expect(secondResult.content).toBe(firstResult.content);
  });
});
