import * as assert from 'node:assert';
import {
  parseRatingFromComment,
} from '../../src/utils/rating-parser';

suite('parseRatingFromComment', () => {
  test('parses 1 star', () => {
    assert.strictEqual(parseRatingFromComment('Rating: ⭐'), 1);
  });

  test('parses 5 stars', () => {
    assert.strictEqual(parseRatingFromComment('Rating: ⭐⭐⭐⭐⭐'), 5);
  });

  test('parses rating with feedback text below', () => {
    const body = 'Rating: ⭐⭐⭐\nFeedback: Good stuff!\n---\nVersion: 1.0.0';
    assert.strictEqual(parseRatingFromComment(body), 3);
  });

  test('returns undefined for comment without rating line', () => {
    assert.strictEqual(parseRatingFromComment('Just a regular comment'), undefined);
  });

  test('returns undefined for 0 stars', () => {
    assert.strictEqual(parseRatingFromComment('Rating: '), undefined);
  });

  test('returns undefined for more than 5 stars', () => {
    assert.strictEqual(parseRatingFromComment('Rating: ⭐⭐⭐⭐⭐⭐'), undefined);
  });

  test('handles rating line not at start of body', () => {
    const body = 'Some preamble\nRating: ⭐⭐\nMore text';
    assert.strictEqual(parseRatingFromComment(body), 2);
  });
});
