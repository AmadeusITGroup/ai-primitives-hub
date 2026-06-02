import * as assert from 'node:assert';
import {
  aggregateResourceScores,
  bayesianSmoothing,
  calculateRatingMetrics,
  getConfidenceLevel,
  scoreToStars,
  starsToScore,
  wilsonLowerBound,
} from '../../src/utils/rating-algorithms';

suite('Rating Algorithms', () => {
  suite('wilsonLowerBound()', () => {
    test('should return 0 for no votes', () => {
      assert.strictEqual(wilsonLowerBound(0, 0), 0);
    });

    test('should return high score for many upvotes and few downvotes', () => {
      const score = wilsonLowerBound(100, 10);
      assert.ok(score > 0.8, `Expected score > 0.8, got ${score}`);
      assert.ok(score < 1, `Expected score < 1, got ${score}`);
    });

    test('should return low score for many downvotes and few upvotes', () => {
      const score = wilsonLowerBound(10, 100);
      assert.ok(score < 0.15, `Expected score < 0.15, got ${score}`);
      assert.ok(score >= 0, `Expected score >= 0, got ${score}`);
    });

    test('should penalize items with few votes', () => {
      // 5 upvotes, 0 downvotes should score lower than 100 upvotes, 0 downvotes
      const fewVotes = wilsonLowerBound(5, 0);
      const manyVotes = wilsonLowerBound(100, 0);
      assert.ok(fewVotes < manyVotes, `Few votes (${fewVotes}) should score lower than many votes (${manyVotes})`);
    });

    test('should return approximately 0.5 for equal up/down votes with many samples', () => {
      const score = wilsonLowerBound(1000, 1000);
      assert.ok(score > 0.45, `Expected score > 0.45, got ${score}`);
      assert.ok(score < 0.55, `Expected score < 0.55, got ${score}`);
    });

    test('should handle all upvotes', () => {
      const score = wilsonLowerBound(50, 0);
      assert.ok(score > 0.85, `Expected score > 0.85, got ${score}`);
    });

    test('should handle all downvotes', () => {
      const score = wilsonLowerBound(0, 50);
      assert.ok(score < 0.1, `Expected score < 0.1, got ${score}`);
    });

    test('should accept custom z-score', () => {
      const score95 = wilsonLowerBound(50, 10, 1.96);
      const score99 = wilsonLowerBound(50, 10, 2.576);
      // Higher confidence (99%) should give lower bound
      assert.ok(score99 < score95, `99% confidence (${score99}) should be lower than 95% (${score95})`);
    });
  });

  suite('bayesianSmoothing()', () => {
    test('should return prior mean for no votes', () => {
      const score = bayesianSmoothing(0, 0, 0.6, 10);
      assert.strictEqual(score, 0.6);
    });

    test('should pull small samples toward prior', () => {
      // 3 out of 3 upvotes should be pulled toward 0.6 prior
      const score = bayesianSmoothing(3, 3, 0.6, 10);
      assert.ok(score < 1, `Expected score < 1, got ${score}`);
      assert.ok(score > 0.6, `Expected score > 0.6 (prior), got ${score}`);
    });

    test('should approach actual ratio with many votes', () => {
      // 800 out of 1000 votes = 80% actual ratio
      const score = bayesianSmoothing(800, 1000, 0.6, 10);
      assert.ok(score > 0.78, `Expected score > 0.78, got ${score}`);
      assert.ok(score < 0.82, `Expected score < 0.82, got ${score}`);
    });

    test('should use default prior values', () => {
      const score = bayesianSmoothing(50, 60);
      assert.ok(score > 0 && score < 1, `Expected score between 0 and 1, got ${score}`);
    });
  });

  suite('scoreToStars()', () => {
    test('should convert 0 score to 1 star', () => {
      assert.strictEqual(scoreToStars(0), 1);
    });

    test('should convert 1 score to 5 stars', () => {
      assert.strictEqual(scoreToStars(1), 5);
    });

    test('should convert 0.5 score to 3 stars', () => {
      assert.strictEqual(scoreToStars(0.5), 3);
    });

    test('should round to one decimal place', () => {
      const stars = scoreToStars(0.333);
      assert.strictEqual(stars, 2.3);
    });

    test('should support custom star range', () => {
      assert.strictEqual(scoreToStars(0, 0, 10), 0);
      assert.strictEqual(scoreToStars(1, 0, 10), 10);
      assert.strictEqual(scoreToStars(0.5, 0, 10), 5);
    });
  });

  suite('starsToScore()', () => {
    test('should convert 1 star to 0 score', () => {
      assert.strictEqual(starsToScore(1), 0);
    });

    test('should convert 5 stars to 1 score', () => {
      assert.strictEqual(starsToScore(5), 1);
    });

    test('should convert 3 stars to 0.5 score', () => {
      assert.strictEqual(starsToScore(3), 0.5);
    });

    test('should be inverse of scoreToStars', () => {
      const originalScore = 0.75;
      const stars = scoreToStars(originalScore);
      const backToScore = starsToScore(stars);
      assert.ok(Math.abs(backToScore - originalScore) < 0.05,
        `Expected ${backToScore} to be close to ${originalScore}`);
    });
  });

  suite('aggregateResourceScores()', () => {
    test('should return 0 for empty array', () => {
      assert.strictEqual(aggregateResourceScores([]), 0);
    });

    test('should return single resource score for one item', () => {
      const score = aggregateResourceScores([{ score: 0.8, voteCount: 10 }]);
      assert.strictEqual(score, 0.8);
    });

    test('should weight by log of vote count', () => {
      // Resource with more votes should have more influence
      const resources = [
        { score: 0.9, voteCount: 100 },
        { score: 0.5, voteCount: 10 }
      ];
      const aggregated = aggregateResourceScores(resources);
      // Should be closer to 0.9 than to 0.5
      assert.ok(aggregated > 0.7, `Expected aggregated > 0.7, got ${aggregated}`);
    });

    test('should dampen effect of very high vote counts', () => {
      // Log scaling prevents one resource from completely dominating
      const resources = [
        { score: 0.9, voteCount: 10_000 },
        { score: 0.5, voteCount: 100 }
      ];
      const aggregated = aggregateResourceScores(resources);
      // Should still give some weight to the second resource
      assert.ok(aggregated < 0.88, `Expected aggregated < 0.88, got ${aggregated}`);
    });

    test('should handle resources with zero votes', () => {
      const resources = [
        { score: 0.8, voteCount: 0 },
        { score: 0.6, voteCount: 10 }
      ];
      const aggregated = aggregateResourceScores(resources);
      // Zero votes should have minimal weight
      assert.ok(aggregated > 0.55, `Expected aggregated > 0.55, got ${aggregated}`);
    });
  });

  suite('getConfidenceLevel()', () => {
    test('should return low for fewer than 5 votes', () => {
      assert.strictEqual(getConfidenceLevel(0), 'low');
      assert.strictEqual(getConfidenceLevel(4), 'low');
    });

    test('should return medium for 5-19 votes', () => {
      assert.strictEqual(getConfidenceLevel(5), 'medium');
      assert.strictEqual(getConfidenceLevel(19), 'medium');
    });

    test('should return high for 20-99 votes', () => {
      assert.strictEqual(getConfidenceLevel(20), 'high');
      assert.strictEqual(getConfidenceLevel(99), 'high');
    });

    test('should return very_high for 100+ votes', () => {
      assert.strictEqual(getConfidenceLevel(100), 'very_high');
      assert.strictEqual(getConfidenceLevel(1000), 'very_high');
    });
  });

  suite('calculateRatingMetrics()', () => {
    test('should calculate all metrics', () => {
      const metrics = calculateRatingMetrics(80, 20);

      assert.ok(metrics.wilsonScore > 0, 'wilsonScore should be positive');
      assert.ok(metrics.bayesianScore > 0, 'bayesianScore should be positive');
      assert.ok(metrics.starRating >= 1 && metrics.starRating <= 5, 'starRating should be 1-5');
      assert.strictEqual(metrics.upvotes, 80);
      assert.strictEqual(metrics.downvotes, 20);
      assert.strictEqual(metrics.totalVotes, 100);
      assert.strictEqual(metrics.confidence, 'very_high');
    });

    test('should handle zero votes', () => {
      const metrics = calculateRatingMetrics(0, 0);

      assert.strictEqual(metrics.wilsonScore, 0);
      assert.strictEqual(metrics.totalVotes, 0);
      assert.strictEqual(metrics.confidence, 'low');
    });

    test('should accept custom prior mean', () => {
      const metrics1 = calculateRatingMetrics(5, 5, 0.3);
      const metrics2 = calculateRatingMetrics(5, 5, 0.7);

      // Different priors should affect Bayesian score
      assert.ok(metrics1.bayesianScore < metrics2.bayesianScore,
        `Prior 0.3 (${metrics1.bayesianScore}) should give lower score than prior 0.7 (${metrics2.bayesianScore})`);
    });
  });
});
