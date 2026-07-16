/**
 * Coverage tests for infra/search/tuning.ts.
 *
 * Tests tuning constants for search ranking.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  BM25,
  FIELD_WEIGHTS,
  HYBRID_ALPHA,
  SEARCHABLE_FIELDS,
  type SearchableField,
} from '../../src/search/tuning';

describe('tuning constants', () => {
  it('exports FIELD_WEIGHTS with expected structure', () => {
    expect(FIELD_WEIGHTS).toEqual({
      title: 3,
      tags: 2,
      description: 1.5,
      bodyPreview: 1
    });
  });

  it('exports BM25 hyperparameters', () => {
    expect(BM25).toEqual({
      k1: 1.2,
      b: 0.75
    });
  });

  it('exports HYBRID_ALPHA constant', () => {
    expect(HYBRID_ALPHA).toBe(0.6);
  });

  it('exports SEARCHABLE_FIELDS array', () => {
    expect(SEARCHABLE_FIELDS).toEqual(['title', 'tags', 'description', 'bodyPreview']);
  });

  it('SEARCHABLE_FIELDS matches FIELD_WEIGHTS keys', () => {
    const weightKeys = Object.keys(FIELD_WEIGHTS) as SearchableField[];
    expect(SEARCHABLE_FIELDS.toSorted()).toEqual(weightKeys.toSorted());
  });

  it('all FIELD_WEIGHTS values are positive numbers', () => {
    for (const value of Object.values(FIELD_WEIGHTS)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('BM25 k1 is positive', () => {
    expect(BM25.k1).toBeGreaterThan(0);
  });

  it('BM25 b is between 0 and 1', () => {
    expect(BM25.b).toBeGreaterThanOrEqual(0);
    expect(BM25.b).toBeLessThanOrEqual(1);
  });

  it('HYBRID_ALPHA is between 0 and 1', () => {
    expect(HYBRID_ALPHA).toBeGreaterThanOrEqual(0);
    expect(HYBRID_ALPHA).toBeLessThanOrEqual(1);
  });
});
