/**
 * Compose the text that is fed to the embedding provider for a primitive.
 *
 * The ternlight models truncate at 128 BERT tokens, which empirically equals
 * about 85 English words. This module word-truncates the combined primitive
 * text to that budget and supports both a single combined stream and a dual
 * stream (metadata + body).
 * @module search/embedding-text
 */

import type {
  Primitive,
} from '@ai-primitives-hub/core';

/**
 * Word budget for each embedding stream.
 *
 * The `total` budget is used for the legacy single stream. The dual streams
 * use `metadata` for title/description/tags and `body` for the body summary.
 */
export const EMBEDDING_BUDGETS = {
  metadata: 25,
  body: 60,
  total: 85
} as const;

function firstWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return words.slice(0, maxWords).join(' ');
}

function metadataText(p: Primitive): string {
  const parts = [p.title];
  if (p.tags && p.tags.length > 0) {
    parts.push(p.tags.join(' '));
  }
  if (p.description) {
    parts.push(p.description);
  }
  return firstWords(parts.join('\n'), EMBEDDING_BUDGETS.metadata);
}

function bodyText(p: Primitive): string {
  return firstWords(p.bodySummary ?? p.bodyPreview ?? '', EMBEDDING_BUDGETS.body);
}

/**
 * Compose the full embedding text for a primitive.
 *
 * Current strategy: concatenate title, description, tags, and the bodySummary
 * (or bodyPreview as a fallback), then truncate to the word budget. This keeps
 * the existing hybrid-search behaviour stable while ensuring the input does not
 * exceed the ternlight token window and can benefit from longer full-body
 * summaries when available.
 * @param p - Primitive to embed.
 * @returns Text to pass to the embedding provider.
 */
export function buildEmbeddingText(p: Primitive): string {
  const parts = [
    p.title,
    p.description,
    p.tags.join(' '),
    p.bodySummary ?? p.bodyPreview
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  return firstWords(parts.join('\n'), EMBEDDING_BUDGETS.total);
}

/**
 * Compose one or more embedding texts for a primitive depending on strategy.
 * @param p - Primitive to embed.
 * @param strategy - `single` returns one combined text; `dual` returns separate
 *   `metadata` and `body` texts.
 * @returns A map from stream name to embedding input text.
 */
export function buildEmbeddingTexts(p: Primitive, strategy: 'single' | 'dual' = 'single'): Record<string, string> {
  if (strategy === 'dual') {
    return {
      metadata: metadataText(p),
      body: bodyText(p)
    };
  }
  return { combined: buildEmbeddingText(p) };
}
