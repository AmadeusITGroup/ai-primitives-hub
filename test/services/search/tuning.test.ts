import * as assert from 'node:assert';
import {
  BM25,
  FIELD_WEIGHTS,
  HYBRID_ALPHA,
  SEARCHABLE_FIELDS,
  type SearchableField,
} from '../../../src/services/search/tuning';

suite('Tuning Constants', () => {
  test('exports FIELD_WEIGHTS with expected structure', () => {
    assert.deepStrictEqual(FIELD_WEIGHTS, {
      title: 3,
      tags: 2,
      description: 1.5,
      bodyPreview: 1
    });
  });

  test('exports BM25 hyperparameters', () => {
    assert.deepStrictEqual(BM25, {
      k1: 1.2,
      b: 0.75
    });
  });

  test('exports HYBRID_ALPHA constant', () => {
    assert.strictEqual(HYBRID_ALPHA, 0.6);
  });

  test('exports SEARCHABLE_FIELDS array', () => {
    assert.deepStrictEqual(SEARCHABLE_FIELDS, ['title', 'tags', 'description', 'bodyPreview']);
  });

  test('SEARCHABLE_FIELDS matches FIELD_WEIGHTS keys', () => {
    const weightKeys = Object.keys(FIELD_WEIGHTS) as SearchableField[];
    assert.deepStrictEqual([...SEARCHABLE_FIELDS].toSorted(), [...weightKeys].toSorted());
  });

  test('all FIELD_WEIGHTS values are positive numbers', () => {
    for (const value of Object.values(FIELD_WEIGHTS) as number[]) {
      assert.ok(value > 0);
    }
  });

  test('BM25 k1 is positive', () => {
    assert.ok(BM25.k1 > 0);
  });

  test('BM25 b is between 0 and 1', () => {
    assert.ok(BM25.b >= 0);
    assert.ok(BM25.b <= 1);
  });

  test('HYBRID_ALPHA is between 0 and 1', () => {
    assert.ok(HYBRID_ALPHA >= 0);
    assert.ok(HYBRID_ALPHA <= 1);
  });
});
