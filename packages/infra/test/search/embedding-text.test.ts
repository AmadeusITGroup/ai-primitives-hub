import type {
  Primitive,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildEmbeddingText,
  buildEmbeddingTexts,
  EMBEDDING_BUDGETS,
} from '../../src/search/embedding-text';

function primitive(overrides: Partial<Primitive> = {}): Primitive {
  return {
    id: 'test-1',
    bundle: {
      sourceId: 'src',
      sourceType: 'github',
      bundleId: 'bundle',
      bundleVersion: '1.0.0',
      installed: false
    },
    kind: 'skill',
    title: 'Terraform Module Generator',
    description: 'Generate Terraform modules from natural language.',
    path: 'skills/terraform.skill.md',
    tags: ['terraform', 'infrastructure', 'cloud'],
    bodyPreview: 'This skill helps you generate Terraform modules from natural language descriptions.',
    contentHash: 'abc',
    ...overrides
  };
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe('buildEmbeddingText', () => {
  it('concatenates title, description, tags, and bodySummary or bodyPreview', () => {
    const text = buildEmbeddingText(primitive());
    expect(text).toContain('Terraform Module Generator');
    expect(text).toContain('Generate Terraform modules from natural language.');
    expect(text).toContain('terraform infrastructure cloud');
    expect(text).toContain('This skill helps you generate');
  });

  it('prefers bodySummary over bodyPreview when present', () => {
    const text = buildEmbeddingText(primitive({
      bodySummary: 'summary text from the full body',
      bodyPreview: 'preview text'
    }));
    expect(text).toContain('summary text from the full body');
    expect(text).not.toContain('preview text');
  });

  it('does not exceed the total word budget', () => {
    const longDescription = 'word '.repeat(200);
    const longBody = 'body '.repeat(200);
    const text = buildEmbeddingText(primitive({
      description: longDescription,
      bodyPreview: longBody
    }));
    expect(wordCount(text)).toBeLessThanOrEqual(EMBEDDING_BUDGETS.total);
  });

  it('preserves priority order (title before description before body)', () => {
    const text = buildEmbeddingText(primitive({
      description: 'word '.repeat(200),
      bodyPreview: 'body '.repeat(200)
    }));
    const words = text.trim().split(/\s+/).filter(Boolean);
    expect(words[0]).toBe('Terraform');
    expect(words[1]).toBe('Module');
    expect(words[2]).toBe('Generator');
  });
});

describe('buildEmbeddingTexts', () => {
  it('returns a single combined stream by default', () => {
    const texts = buildEmbeddingTexts(primitive());
    expect(Object.keys(texts)).toEqual(['combined']);
    expect(texts.combined).toContain('Terraform Module Generator');
  });

  it('returns separate metadata and body streams for dual strategy', () => {
    const texts = buildEmbeddingTexts(primitive({
      bodySummary: 'summary text from the full body'
    }), 'dual');
    expect(Object.keys(texts).toSorted()).toEqual(['body', 'metadata']);
    expect(texts.metadata).toContain('Terraform Module Generator');
    expect(texts.body).toContain('summary text from the full body');
    expect(wordCount(texts.metadata)).toBeLessThanOrEqual(EMBEDDING_BUDGETS.metadata);
    expect(wordCount(texts.body)).toBeLessThanOrEqual(EMBEDDING_BUDGETS.body);
  });
});
