/**
 * Unit tests for KiroTransformer.
 */
import type {
  Target,
} from '@prompt-registry/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  KiroTransformer,
} from '../../src/transform/transformers/kiro-transformer';

describe('KiroTransformer', () => {
  const transformer = new KiroTransformer();
  const mockTarget: Target = {
    name: 'test-kiro',
    type: 'kiro',
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

  it('should return no change when name field already exists', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: '---\nname: "existing-name"\ntitle: "Example"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(false);
    expect(result.content).toBe(context.content);
  });

  it('should add name field derived from title when missing', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/example.md',
      content: '---\ntitle: "My Agent"\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('name: "My Agent"');
  });

  it('should add name field derived from filename when title is missing', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/my-cool-agent.md',
      content: '---\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('name: "My Cool Agent"');
  });

  it('should be idempotent - applying twice yields same result', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/my-agent.md',
      content: '---\n---\nContent'
    };
    const firstResult = transformer.transform(context);
    const secondContext = {
      target: mockTarget,
      filePath: 'agents/my-agent.md',
      content: firstResult.content
    };
    const secondResult = transformer.transform(secondContext);
    expect(secondResult.modified).toBe(false);
    expect(secondResult.content).toBe(firstResult.content);
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

  it('should convert kebab-case filename to title case', () => {
    const context = {
      target: mockTarget,
      filePath: 'agents/my-awesome-agent.md',
      content: '---\n---\nContent'
    };
    const result = transformer.transform(context);
    expect(result.modified).toBe(true);
    expect(result.content).toContain('name: "My Awesome Agent"');
  });
});
