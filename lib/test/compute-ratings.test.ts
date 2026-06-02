/**
 * Tests for compute-ratings
 * Rating computation for GitHub Actions
 */

import * as assert from 'node:assert';
import {
  computeAverageStarRating,
  computeResourceRating,
  deduplicateRatingsByUser,
  parseArgs,
  parseStarRatingFromComment,
} from '../src/compute-ratings';

describe('compute-ratings', () => {
  describe('computeResourceRating()', () => {
    it('should compute rating for resource with votes', () => {
      const rating = computeResourceRating(100, 10);

      assert.strictEqual(rating.up, 100);
      assert.strictEqual(rating.down, 10);
      assert.ok(rating.wilson_score > 0.8, 'Wilson score should be high for 100:10 ratio');
      assert.ok(rating.wilson_score < 1, 'Wilson score should be less than 1');
      assert.strictEqual(rating.confidence, 'very_high');
    });

    it('should compute rating for resource with no votes', () => {
      const rating = computeResourceRating(0, 0);

      assert.strictEqual(rating.up, 0);
      assert.strictEqual(rating.down, 0);
      assert.strictEqual(rating.wilson_score, 0);
      assert.strictEqual(rating.confidence, 'low');
    });

    it('should compute rating for resource with only upvotes', () => {
      const rating = computeResourceRating(3, 0);

      assert.strictEqual(rating.up, 3);
      assert.strictEqual(rating.down, 0);
      assert.ok(rating.wilson_score > 0.3, 'Wilson score should be positive');
      assert.ok(rating.wilson_score < 1, 'Wilson score should be penalized for low sample');
      assert.strictEqual(rating.confidence, 'low');
    });

    it('should compute rating for resource with only downvotes', () => {
      const rating = computeResourceRating(0, 3);

      assert.strictEqual(rating.up, 0);
      assert.strictEqual(rating.down, 3);
      assert.strictEqual(rating.wilson_score, 0);
      assert.strictEqual(rating.confidence, 'low');
    });

    it('should round scores to 3 decimal places', () => {
      const rating = computeResourceRating(73, 17);

      // Check that scores are rounded to 3 decimal places
      const wilsonStr = rating.wilson_score.toString();
      const decimalPart = wilsonStr.split('.')[1] || '';
      assert.ok(decimalPart.length <= 3, 'Wilson score should have at most 3 decimal places');
    });

    it('should assign correct confidence levels', () => {
      // Low: < 5 votes
      assert.strictEqual(computeResourceRating(2, 1).confidence, 'low');

      // Medium: 5-19 votes
      assert.strictEqual(computeResourceRating(10, 5).confidence, 'medium');

      // High: 20-99 votes
      assert.strictEqual(computeResourceRating(50, 30).confidence, 'high');

      // Very high: 100+ votes
      assert.strictEqual(computeResourceRating(80, 30).confidence, 'very_high');
    });

    it('should compute star rating between 1 and 5', () => {
      const rating = computeResourceRating(50, 10);

      assert.ok(rating.star_rating >= 1, 'Star rating should be at least 1');
      assert.ok(rating.star_rating <= 5, 'Star rating should be at most 5');
    });
  });

  describe('parseArgs()', () => {
    it('should parse config and output paths', () => {
      const result = parseArgs([]);

      assert.strictEqual(result.configPath, 'collections.yaml');
      assert.strictEqual(result.outputPath, 'ratings.json');
    });

    it('should parse --config flag', () => {
      const result = parseArgs(['--config', 'custom.yaml']);

      assert.strictEqual(result.configPath, 'custom.yaml');
    });

    it('should parse --output flag', () => {
      const result = parseArgs(['--output', 'custom.json']);

      assert.strictEqual(result.outputPath, 'custom.json');
    });

    it('should parse both flags', () => {
      const result = parseArgs(['--config', 'custom.yaml', '--output', 'custom.json']);

      assert.strictEqual(result.configPath, 'custom.yaml');
      assert.strictEqual(result.outputPath, 'custom.json');
    });

    it('should handle missing flags', () => {
      const result = parseArgs([]);

      assert.strictEqual(result.configPath, 'collections.yaml');
      assert.strictEqual(result.outputPath, 'ratings.json');
    });
  });

  describe('Rating Computation Edge Cases', () => {
    it('should handle very large vote counts', () => {
      const rating = computeResourceRating(10_000, 500);

      assert.ok(rating.wilson_score > 0.9, 'Should have high score for 10000:500 ratio');
      assert.strictEqual(rating.confidence, 'very_high');
    });

    it('should handle equal up and down votes', () => {
      const rating = computeResourceRating(50, 50);

      assert.ok(rating.wilson_score < 0.5, 'Wilson score should be below 0.5 for 50:50');
      assert.ok(rating.wilson_score > 0.3, 'Wilson score should not be too low');
    });

    it('should handle mostly negative votes', () => {
      const rating = computeResourceRating(10, 90);

      assert.ok(rating.wilson_score < 0.2, 'Wilson score should be low for 10:90 ratio');
    });
  });

  describe('parseStarRatingFromComment()', () => {
    it('should parse 5-star rating from feedback comment', () => {
      const comment = '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nRated 5 stars\n\n_Version: 1.0.0_';
      const rating = parseStarRatingFromComment(comment);

      assert.strictEqual(rating, 5);
    });

    it('should parse 3-star rating from feedback comment', () => {
      const comment = '**Feedback** (3 ⭐⭐⭐)\n\nRated 3 stars - redirected to issue tracker\n\n_Version: 1.0.0_';
      const rating = parseStarRatingFromComment(comment);

      assert.strictEqual(rating, 3);
    });

    it('should parse 1-star rating from feedback comment', () => {
      const comment = '**Feedback** (1 ⭐)\n\nThis needs improvement\n\n_Version: 2.0.0_';
      const rating = parseStarRatingFromComment(comment);

      assert.strictEqual(rating, 1);
    });

    it('should return null for comment without rating', () => {
      const comment = '**Feedback**\n\nJust a comment without rating';
      const rating = parseStarRatingFromComment(comment);

      assert.strictEqual(rating, null);
    });

    it('should return null for non-feedback comment', () => {
      const comment = 'This is just a regular comment';
      const rating = parseStarRatingFromComment(comment);

      assert.strictEqual(rating, null);
    });

    it('should parse 5-star rating from new format', () => {
      const comment = 'Rating: ⭐⭐⭐⭐⭐\nFeedback: Works great!\n---\nVersion: 1.0.0';
      assert.strictEqual(parseStarRatingFromComment(comment), 5);
    });

    it('should parse 3-star rating from new format', () => {
      const comment = 'Rating: ⭐⭐⭐\nFeedback: Decent\n---\nVersion: 1.0.0';
      assert.strictEqual(parseStarRatingFromComment(comment), 3);
    });

    it('should parse 1-star rating from new format', () => {
      const comment = 'Rating: ⭐\nFeedback: Not good\n---\nVersion: 1.0.0';
      assert.strictEqual(parseStarRatingFromComment(comment), 1);
    });

    it('should parse rating without feedback text', () => {
      const comment = 'Rating: ⭐⭐⭐⭐\n---\nVersion: 1.0.0';
      assert.strictEqual(parseStarRatingFromComment(comment), 4);
    });

    it('should parse 5-star rating from old format (backward compatibility)', () => {
      const comment = '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nGreat bundle!';
      assert.strictEqual(parseStarRatingFromComment(comment), 5);
    });

    it('should parse 3-star rating from old format (backward compatibility)', () => {
      const comment = '**Feedback** (3 ⭐⭐⭐)\n\nDecent';
      assert.strictEqual(parseStarRatingFromComment(comment), 3);
    });

    it('should return null for comment without rating', () => {
      const comment = 'Just a regular comment without rating';
      assert.strictEqual(parseStarRatingFromComment(comment), null);
    });

    it('should return null for non-feedback comment', () => {
      const comment = 'Some discussion about the bundle';
      assert.strictEqual(parseStarRatingFromComment(comment), null);
    });

    it('should handle rating at start of line (fallback)', () => {
      const comment = '5 ⭐⭐⭐⭐⭐\nGreat!';
      assert.strictEqual(parseStarRatingFromComment(comment), 5);
    });
  });

  describe('computeAverageStarRating()', () => {
    it('should compute average from multiple star ratings', () => {
      const ratings = [5, 4, 3, 5, 4];
      const result = computeAverageStarRating(ratings);

      assert.strictEqual(result.average, 4.2);
      assert.strictEqual(result.count, 5);
      assert.strictEqual(result.confidence, 'medium');
    });

    it('should handle single rating', () => {
      const ratings = [5];
      const result = computeAverageStarRating(ratings);

      assert.strictEqual(result.average, 5);
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.confidence, 'low');
    });

    it('should handle empty ratings array', () => {
      const ratings: number[] = [];
      const result = computeAverageStarRating(ratings);

      assert.strictEqual(result.average, 0);
      assert.strictEqual(result.count, 0);
      assert.strictEqual(result.confidence, 'low');
    });

    it('should compute correct confidence levels', () => {
      // Low: < 5 ratings
      assert.strictEqual(computeAverageStarRating([5, 4, 3]).confidence, 'low');

      // Medium: 5-19 ratings
      assert.strictEqual(computeAverageStarRating([5, 4, 3, 5, 4, 3, 5]).confidence, 'medium');

      // High: 20-99 ratings
      const twentyRatings = Array.from({ length: 25 }, () => 4);
      assert.strictEqual(computeAverageStarRating(twentyRatings).confidence, 'high');

      // Very high: 100+ ratings
      const hundredRatings = Array.from({ length: 100 }, () => 4);
      assert.strictEqual(computeAverageStarRating(hundredRatings).confidence, 'very_high');
    });

    it('should round average to 1 decimal place', () => {
      const ratings = [5, 4, 4, 4, 4, 4, 4]; // Average: 4.142857...
      const result = computeAverageStarRating(ratings);

      assert.strictEqual(result.average, 4.1);
    });
  });

  describe('deduplicateRatingsByUser()', () => {
    it('should keep only one rating when user submits once', () => {
      const comments = [
        {
          body: '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nGreat!',
          author: { login: 'user1' },
          createdAt: '2024-01-01T10:00:00Z'
        }
      ];

      const ratings = deduplicateRatingsByUser(comments);

      assert.strictEqual(ratings.length, 1);
      assert.strictEqual(ratings[0], 5);
    });

    it('should keep only the most recent rating when user submits multiple times', () => {
      const comments = [
        {
          body: '**Feedback** (3 ⭐⭐⭐)\n\nOkay',
          author: { login: 'user1' },
          createdAt: '2024-01-01T10:00:00Z'
        },
        {
          body: '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nActually great after update!',
          author: { login: 'user1' },
          createdAt: '2024-01-02T10:00:00Z'
        }
      ];

      const ratings = deduplicateRatingsByUser(comments);

      assert.strictEqual(ratings.length, 1);
      assert.strictEqual(ratings[0], 5); // Most recent rating
    });

    it('should keep ratings from different users', () => {
      const comments = [
        {
          body: '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nGreat!',
          author: { login: 'user1' },
          createdAt: '2024-01-01T10:00:00Z'
        },
        {
          body: '**Feedback** (4 ⭐⭐⭐⭐)\n\nGood',
          author: { login: 'user2' },
          createdAt: '2024-01-01T11:00:00Z'
        }
      ];

      const ratings = deduplicateRatingsByUser(comments);

      assert.strictEqual(ratings.length, 2);
      assert.ok(ratings.includes(5));
      assert.ok(ratings.includes(4));
    });

    it('should handle multiple users with multiple ratings each', () => {
      const comments = [
        {
          body: '**Feedback** (3 ⭐⭐⭐)\n\nOkay',
          author: { login: 'user1' },
          createdAt: '2024-01-01T10:00:00Z'
        },
        {
          body: '**Feedback** (2 ⭐⭐)\n\nNot great',
          author: { login: 'user2' },
          createdAt: '2024-01-01T11:00:00Z'
        },
        {
          body: '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nUpdated, now great!',
          author: { login: 'user1' },
          createdAt: '2024-01-02T10:00:00Z'
        },
        {
          body: '**Feedback** (4 ⭐⭐⭐⭐)\n\nBetter now',
          author: { login: 'user2' },
          createdAt: '2024-01-02T11:00:00Z'
        }
      ];

      const ratings = deduplicateRatingsByUser(comments);

      assert.strictEqual(ratings.length, 2);
      assert.ok(ratings.includes(5)); // user1's latest
      assert.ok(ratings.includes(4)); // user2's latest
    });

    it('should skip non-rating comments', () => {
      const comments = [
        {
          body: 'Just a regular comment',
          author: { login: 'user1' },
          createdAt: '2024-01-01T10:00:00Z'
        },
        {
          body: '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nGreat!',
          author: { login: 'user1' },
          createdAt: '2024-01-01T11:00:00Z'
        }
      ];

      const ratings = deduplicateRatingsByUser(comments);

      assert.strictEqual(ratings.length, 1);
      assert.strictEqual(ratings[0], 5);
    });

    it('should handle comments without author (anonymous/deleted users)', () => {
      const comments = [
        {
          body: '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nGreat!',
          author: undefined,
          createdAt: '2024-01-01T10:00:00Z'
        },
        {
          body: '**Feedback** (4 ⭐⭐⭐⭐)\n\nGood',
          author: { login: 'user1' },
          createdAt: '2024-01-01T11:00:00Z'
        }
      ];

      const ratings = deduplicateRatingsByUser(comments);

      assert.strictEqual(ratings.length, 2);
      assert.ok(ratings.includes(5));
      assert.ok(ratings.includes(4));
    });

    it('should handle empty comments array', () => {
      const ratings = deduplicateRatingsByUser([]);

      assert.strictEqual(ratings.length, 0);
    });

    it('should use timestamp comparison correctly', () => {
      const comments = [
        {
          body: '**Feedback** (5 ⭐⭐⭐⭐⭐)\n\nGreat!',
          author: { login: 'user1' },
          createdAt: '2024-01-02T10:00:00Z' // Later
        },
        {
          body: '**Feedback** (3 ⭐⭐⭐)\n\nOkay',
          author: { login: 'user1' },
          createdAt: '2024-01-01T10:00:00Z' // Earlier
        }
      ];

      const ratings = deduplicateRatingsByUser(comments);

      assert.strictEqual(ratings.length, 1);
      assert.strictEqual(ratings[0], 5); // Should keep the later one
    });
  });
});
