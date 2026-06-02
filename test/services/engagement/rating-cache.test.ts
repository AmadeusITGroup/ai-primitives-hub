/**
 * Tests for RatingCache
 * In-memory cache for synchronous rating access in UI components
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  CachedRating,
  RatingCache,
} from '../../../src/services/engagement/rating-cache';
import {
  RatingsData,
  RatingService,
} from '../../../src/services/engagement/rating-service';

suite('RatingCache', () => {
  let sandbox: sinon.SinonSandbox;
  let cache: RatingCache;

  const createMockRating = (sourceId: string, bundleId: string, starRating = 4, voteCount = 50): CachedRating => ({
    sourceId,
    bundleId,
    starRating,
    wilsonScore: 0.75,
    voteCount,
    confidence: 'high',
    cachedAt: Date.now()
  });

  setup(() => {
    sandbox = sinon.createSandbox();
    RatingCache.resetInstance();
    cache = RatingCache.getInstance();
  });

  teardown(() => {
    sandbox.restore();
    RatingCache.resetInstance();
  });

  suite('Singleton Pattern', () => {
    test('should return same instance', () => {
      const instance1 = RatingCache.getInstance();
      const instance2 = RatingCache.getInstance();
      assert.strictEqual(instance1, instance2);
    });

    test('should create new instance after reset', () => {
      const instance1 = RatingCache.getInstance();
      RatingCache.resetInstance();
      const instance2 = RatingCache.getInstance();
      assert.notStrictEqual(instance1, instance2);
    });
  });

  suite('getRating()', () => {
    test('should return undefined for uncached bundle', () => {
      const rating = cache.getRating('test-source', 'unknown-bundle');
      assert.strictEqual(rating, undefined);
    });

    test('should return cached rating', () => {
      const mockRating = createMockRating('test-source', 'test-bundle');
      cache.setRating(mockRating);

      const rating = cache.getRating('test-source', 'test-bundle');
      assert.deepStrictEqual(rating, mockRating);
    });
  });

  suite('getRatingDisplay()', () => {
    test('should return undefined for uncached bundle', () => {
      const display = cache.getRatingDisplay('test-source', 'unknown-bundle');
      assert.strictEqual(display, undefined);
    });

    test('should return undefined for bundle with zero votes', () => {
      const mockRating = createMockRating('test-source', 'test-bundle', 0, 0);
      cache.setRating(mockRating);

      const display = cache.getRatingDisplay('test-source', 'test-bundle');
      assert.strictEqual(display, undefined);
    });

    test('should return formatted display for cached rating', () => {
      const mockRating = createMockRating('test-source', 'test-bundle', 4.2, 50);
      cache.setRating(mockRating);

      const display = cache.getRatingDisplay('test-source', 'test-bundle');
      assert.ok(display);
      assert.ok(display.text.includes('★'));
      assert.ok(display.text.includes('4.2'));
      assert.ok(display.tooltip.includes('Rating'));
      assert.ok(display.tooltip.includes('Votes'));
    });
  });

  suite('hasRating()', () => {
    test('should return false for uncached bundle', () => {
      assert.strictEqual(cache.hasRating('test-source', 'unknown-bundle'), false);
    });

    test('should return true for cached bundle', () => {
      cache.setRating(createMockRating('test-source', 'test-bundle'));
      assert.strictEqual(cache.hasRating('test-source', 'test-bundle'), true);
    });
  });

  suite('setRating()', () => {
    test('should add rating to cache', () => {
      const rating = createMockRating('test-source', 'new-bundle');
      cache.setRating(rating);

      assert.strictEqual(cache.size, 1);
      assert.deepStrictEqual(cache.getRating('test-source', 'new-bundle'), rating);
    });

    test('should update existing rating', () => {
      cache.setRating(createMockRating('test-source', 'test-bundle', 3));
      cache.setRating(createMockRating('test-source', 'test-bundle', 4.5));

      const rating = cache.getRating('test-source', 'test-bundle');
      assert.strictEqual(rating?.starRating, 4.5);
    });
  });

  suite('clear()', () => {
    test('should remove all cached ratings', () => {
      cache.setRating(createMockRating('test-source', 'bundle-1'));
      cache.setRating(createMockRating('test-source', 'bundle-2'));
      assert.strictEqual(cache.size, 2);

      cache.clear();
      assert.strictEqual(cache.size, 0);
    });
  });

  suite('clearHub()', () => {
    test('should remove ratings for a hub that were loaded via refreshFromHub', async () => {
      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings')
        .onFirstCall().resolves({
          version: '1.0.0',
          generatedAt: new Date().toISOString(),
          bundles: {
            'bundle-1': { sourceId: 'hub1', bundleId: 'bundle-1', upvotes: 5, downvotes: 0, wilsonScore: 0.7, starRating: 4, totalVotes: 5, lastUpdated: new Date().toISOString() },
            'bundle-2': { sourceId: 'hub1', bundleId: 'bundle-2', upvotes: 3, downvotes: 1, wilsonScore: 0.6, starRating: 3.5, totalVotes: 4, lastUpdated: new Date().toISOString() }
          }
        })
        .onSecondCall().resolves({
          version: '1.0.0',
          generatedAt: new Date().toISOString(),
          bundles: {
            'bundle-1': { sourceId: 'hub2', bundleId: 'bundle-1', upvotes: 10, downvotes: 2, wilsonScore: 0.75, starRating: 4.2, totalVotes: 12, lastUpdated: new Date().toISOString() }
          }
        });

      await cache.refreshFromHub('hub1', 'https://hub1/ratings.json');
      await cache.refreshFromHub('hub2', 'https://hub2/ratings.json');

      assert.strictEqual(cache.size, 3);

      cache.clearHub('hub1');

      assert.strictEqual(cache.size, 1);
      assert.strictEqual(cache.hasRating('hub2', 'bundle-1'), true);
      assert.strictEqual(cache.hasRating('hub1', 'bundle-1'), false);
      assert.strictEqual(cache.hasRating('hub1', 'bundle-2'), false);
    });
  });

  suite('getCachedBundleIds()', () => {
    test('should return empty array when cache is empty', () => {
      const ids = cache.getCachedBundleIds();
      assert.deepStrictEqual(ids, []);
    });

    test('should return all cached composite keys', () => {
      cache.setRating(createMockRating('test-source', 'bundle-a'));
      cache.setRating(createMockRating('test-source', 'bundle-b'));

      const ids = cache.getCachedBundleIds();
      assert.strictEqual(ids.length, 2);
      assert.ok(ids.includes('test-source:bundle-a'));
      assert.ok(ids.includes('test-source:bundle-b'));
    });
  });

  suite('refreshFromHub()', () => {
    test('should populate cache from RatingService', async () => {
      const mockRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          'bundle-1': {
            sourceId: 'test-source',
            bundleId: 'bundle-1',
            upvotes: 80,
            downvotes: 10,
            wilsonScore: 0.82,
            starRating: 4.3,
            totalVotes: 90,
            lastUpdated: new Date().toISOString()
          },
          'bundle-2': {
            sourceId: 'test-source',
            bundleId: 'bundle-2',
            upvotes: 20,
            downvotes: 5,
            wilsonScore: 0.65,
            starRating: 3.6,
            totalVotes: 25,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(mockRatingsData);

      await cache.refreshFromHub('test-hub', 'https://example.com/ratings.json');

      assert.strictEqual(cache.size, 2);

      const rating1 = cache.getRating('test-source', 'bundle-1');
      assert.ok(rating1);
      assert.strictEqual(rating1.starRating, 4.3);
      assert.strictEqual(rating1.voteCount, 90);

      const rating2 = cache.getRating('test-source', 'bundle-2');
      assert.ok(rating2);
      assert.strictEqual(rating2.starRating, 3.6);
    });

    test('should handle empty ratings data', async () => {
      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(undefined);

      await cache.refreshFromHub('test-hub', 'https://example.com/ratings.json');

      assert.strictEqual(cache.size, 0);
    });

    test('should handle fetch errors gracefully', async () => {
      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').rejects(new Error('Network error'));

      // Should not throw
      await cache.refreshFromHub('test-hub', 'https://example.com/ratings.json');

      assert.strictEqual(cache.size, 0);
    });

    test('should preserve in-session optimistic rating after refresh overwrites aggregate', async () => {
      // Scenario: user rates bundle 3 stars (optimistic), then on next startup
      // refreshFromHub loads stale ratings.json (computed before the user rated).
      // The aggregate should re-incorporate the user's vote, not revert to stale data.

      // Step 1: Remote has bundle with star_rating 5 (1 vote from someone else... or stale)
      const staleRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          otter: {
            sourceId: 'otter-src',
            bundleId: 'otter',
            upvotes: 1,
            downvotes: 0,
            wilsonScore: 1,
            starRating: 5,
            totalVotes: 1,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      const ratingService = RatingService.getInstance();
      const fetchStub = sandbox.stub(ratingService, 'fetchRatings');

      // Step 2: Initial load from remote
      const sourceIdMap = new Map([['otter-src', 'adapter-hash']]);
      fetchStub.resolves(staleRatingsData);
      await cache.refreshFromHub('hub1', 'https://hub/ratings.json', sourceIdMap);

      const afterLoad = cache.getRating('adapter-hash', 'otter');
      assert.ok(afterLoad);
      assert.strictEqual(afterLoad.starRating, 5);

      // Step 3: User rates 3 stars (optimistic update in-session)
      cache.applyOptimisticRating('adapter-hash', 'otter', 3);

      const afterOptimistic = cache.getRating('adapter-hash', 'otter');
      assert.ok(afterOptimistic);
      // (5 * 1 + 3) / 2 = 4.0
      assert.strictEqual(afterOptimistic.starRating, 4);
      assert.strictEqual(afterOptimistic.voteCount, 2);

      // Step 4: refreshFromHub runs again (e.g. extension restart, but ratings.json is still stale)
      // The remote still shows star_rating: 5 with 1 vote (hasn't been recomputed yet)
      await cache.refreshFromHub('hub1', 'https://hub/ratings.json', sourceIdMap);

      // BUG: Without the fix, this reverts to 5 stars / 1 vote (stale remote data)
      // EXPECTED: The user's optimistic 3-star vote is re-applied on top of the fresh remote data
      const afterRefresh = cache.getRating('adapter-hash', 'otter');
      assert.ok(afterRefresh);
      assert.strictEqual(afterRefresh.starRating, 4, 'Optimistic rating must be preserved after refresh');
      assert.strictEqual(afterRefresh.voteCount, 2, 'Vote count must include the user\'s optimistic vote');
    });

    test('should preserve hydrated user rating after refresh on cold start (cross-restart)', async () => {
      // Scenario: extension restarts. optimisticKeys is empty.
      // 1. refreshFromHub loads stale ratings.json (5★, 1 vote)
      // 2. hydrateUserRatings sets userRating = 3 (from local storage)
      // 3. Aggregate should reflect the user's vote, not show stale 5★

      const staleRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: '2026-05-20T21:00:00Z',
        bundles: {
          otter: {
            sourceId: 'otter-src',
            bundleId: 'otter',
            upvotes: 1,
            downvotes: 0,
            wilsonScore: 1,
            starRating: 5,
            totalVotes: 1,
            lastUpdated: '2026-05-20T21:00:00Z'
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(staleRatingsData);

      const sourceIdMap = new Map([['otter-src', 'adapter-hash']]);

      // Step 1: refresh loads stale aggregate
      await cache.refreshFromHub('hub1', 'https://hub/ratings.json', sourceIdMap);

      // Step 2: local hydration sets user rating (simulates cold start — NOT via applyOptimisticRating)
      cache.hydrateUserRatings([
        { sourceId: 'adapter-hash', bundleId: 'otter', score: 3 }
      ]);

      // Step 3: call reapplyHydratedVotes to fix the aggregate
      cache.reapplyHydratedVotes();

      // The user is the only voter. ratings.json had their OLD vote (5★).
      // After swap: (5*1 - 5 + 3) / 1 = 3. voteCount stays 1.
      const afterReapply = cache.getRating('adapter-hash', 'otter');
      assert.ok(afterReapply);
      assert.strictEqual(afterReapply.starRating, 3, 'Aggregate must swap old vote for new');
      assert.strictEqual(afterReapply.voteCount, 1, 'voteCount unchanged (swap, not add)');
    });

    test('reapplyHydratedVotes is idempotent (second call is a no-op)', async () => {
      const staleRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          otter: {
            sourceId: 'otter-src',
            bundleId: 'otter',
            upvotes: 1,
            downvotes: 0,
            wilsonScore: 1,
            starRating: 5,
            totalVotes: 1,
            lastUpdated: '2026-05-20T21:00:00Z'
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(staleRatingsData);

      const sourceIdMap = new Map([['otter-src', 'adapter-hash']]);
      await cache.refreshFromHub('hub1', 'https://hub/ratings.json', sourceIdMap);

      cache.hydrateUserRatings([
        { sourceId: 'adapter-hash', bundleId: 'otter', score: 3 }
      ]);

      cache.reapplyHydratedVotes();
      const afterFirst = cache.getRating('adapter-hash', 'otter');

      // Second call should be a no-op
      cache.reapplyHydratedVotes();
      const afterSecond = cache.getRating('adapter-hash', 'otter');

      assert.ok(afterFirst);
      assert.ok(afterSecond);
      assert.strictEqual(afterSecond.starRating, afterFirst.starRating, 'Second call must not shift aggregate');
      assert.strictEqual(afterSecond.voteCount, afterFirst.voteCount, 'Second call must not change voteCount');
    });

    test('should fire onCacheUpdated event after refresh', async () => {
      const mockRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          'bundle-1': {
            sourceId: 'test-source',
            bundleId: 'bundle-1',
            upvotes: 50,
            downvotes: 5,
            wilsonScore: 0.85,
            starRating: 4.4,
            totalVotes: 55,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(mockRatingsData);

      let eventFired = false;
      cache.onCacheUpdated(() => {
        eventFired = true;
      });

      await cache.refreshFromHub('test-hub', 'https://example.com/ratings.json');

      assert.strictEqual(eventFired, true);
    });
  });

  suite('Optimistic Updates', () => {
    test('should apply optimistic rating and update cache', () => {
      cache.setRating({
        sourceId: 'src-1', bundleId: 'bundle-1',
        starRating: 4, wilsonScore: 0.8, voteCount: 10,
        confidence: 'medium', cachedAt: Date.now()
      });

      cache.applyOptimisticRating('src-1', 'bundle-1', 5);

      const rating = cache.getRating('src-1', 'bundle-1');
      assert.ok(rating);
      // (4.0 * 10 + 5) / 11 ≈ 4.09
      assert.ok(Math.abs(rating.starRating - 4.1) < 0.1);
      assert.strictEqual(rating.voteCount, 11);
    });

    test('should create new rating entry for unrated bundle', () => {
      cache.applyOptimisticRating('src-1', 'new-bundle', 4);

      const rating = cache.getRating('src-1', 'new-bundle');
      assert.ok(rating);
      assert.strictEqual(rating.starRating, 4);
      assert.strictEqual(rating.voteCount, 1);
    });

    test('should fire onCacheUpdated event after optimistic update', () => {
      let fired = false;
      cache.onCacheUpdated(() => {
        fired = true;
      });

      cache.applyOptimisticRating('src-1', 'bundle-1', 3);
      assert.ok(fired);
    });
  });

  suite('Confidence Level Calculation', () => {
    test('should assign low confidence for < 5 votes', async () => {
      const mockRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          'bundle-1': {
            sourceId: 'test-source',
            bundleId: 'bundle-1',
            upvotes: 3,
            downvotes: 0,
            wilsonScore: 0.5,
            starRating: 3,
            totalVotes: 3,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(mockRatingsData);

      await cache.refreshFromHub('test-hub', 'https://example.com/ratings.json');

      const rating = cache.getRating('test-source', 'bundle-1');
      assert.strictEqual(rating?.confidence, 'low');
    });

    test('should assign medium confidence for 5-19 votes', async () => {
      const mockRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          'bundle-1': {
            sourceId: 'test-source',
            bundleId: 'bundle-1',
            upvotes: 10,
            downvotes: 2,
            wilsonScore: 0.7,
            starRating: 3.8,
            totalVotes: 12,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(mockRatingsData);

      await cache.refreshFromHub('test-hub', 'https://example.com/ratings.json');

      const rating = cache.getRating('test-source', 'bundle-1');
      assert.strictEqual(rating?.confidence, 'medium');
    });

    test('should assign high confidence for 20-99 votes', async () => {
      const mockRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          'bundle-1': {
            sourceId: 'test-source',
            bundleId: 'bundle-1',
            upvotes: 40,
            downvotes: 10,
            wilsonScore: 0.75,
            starRating: 4,
            totalVotes: 50,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(mockRatingsData);

      await cache.refreshFromHub('test-hub', 'https://example.com/ratings.json');

      const rating = cache.getRating('test-source', 'bundle-1');
      assert.strictEqual(rating?.confidence, 'high');
    });

    test('should assign very_high confidence for 100+ votes', async () => {
      const mockRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          'bundle-1': {
            sourceId: 'test-source',
            bundleId: 'bundle-1',
            upvotes: 150,
            downvotes: 20,
            wilsonScore: 0.85,
            starRating: 4.4,
            totalVotes: 170,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(mockRatingsData);

      await cache.refreshFromHub('test-hub', 'https://example.com/ratings.json');

      const rating = cache.getRating('test-source', 'bundle-1');
      assert.strictEqual(rating?.confidence, 'very_high');
    });
  });

  suite('user ratings and rollback', () => {
    test('getUserRating returns undefined for a bundle the user hasn\'t rated', () => {
      assert.strictEqual(cache.getUserRating('src-1', 'bundle-1'), undefined);
    });

    test('applyOptimisticRating records the user\'s rating for later lookup', () => {
      cache.applyOptimisticRating('src-1', 'bundle-1', 4);

      assert.strictEqual(cache.getUserRating('src-1', 'bundle-1'), 4);
    });

    test('applyOptimisticRating with an existing cached aggregate adds a new vote when the user hasn\'t rated yet (voteCount increments)', () => {
      cache.setRating({
        sourceId: 'src-1', bundleId: 'bundle-1',
        starRating: 4, wilsonScore: 0.8, voteCount: 10,
        confidence: 'medium', cachedAt: Date.now()
      });

      cache.applyOptimisticRating('src-1', 'bundle-1', 5);

      const rating = cache.getRating('src-1', 'bundle-1');
      assert.ok(rating);
      assert.strictEqual(rating.voteCount, 11);
      // (4.0 * 10 + 5) / 11 ≈ 4.09 → rounded to 4.1
      assert.ok(Math.abs(rating.starRating - 4.1) < 0.05);
      assert.strictEqual(cache.getUserRating('src-1', 'bundle-1'), 5);
    });

    test('applyOptimisticRating with an existing user rating swaps the vote instead of double-counting (voteCount unchanged)', () => {
      cache.setRating({
        sourceId: 'src-1', bundleId: 'bundle-1',
        starRating: 4, wilsonScore: 0.8, voteCount: 10,
        confidence: 'medium', cachedAt: Date.now()
      });

      // First rating from user (increments voteCount to 11).
      cache.applyOptimisticRating('src-1', 'bundle-1', 5);
      const afterFirst = cache.getRating('src-1', 'bundle-1');
      assert.ok(afterFirst);
      assert.strictEqual(afterFirst.voteCount, 11);

      // Same user rates again — voteCount must NOT change.
      cache.applyOptimisticRating('src-1', 'bundle-1', 2);

      const afterSecond = cache.getRating('src-1', 'bundle-1');
      assert.ok(afterSecond);
      assert.strictEqual(afterSecond.voteCount, 11);
      // Total score before: 4.1 * 11 = 45.1, minus old rating 5, plus new rating 2 = 42.1 → 42.1 / 11 ≈ 3.83
      // Allow some rounding tolerance.
      assert.ok(afterSecond.starRating < afterFirst.starRating);
      assert.strictEqual(cache.getUserRating('src-1', 'bundle-1'), 2);
    });

    test('rollbackOptimisticRating undoes a first-time rating correctly (voteCount decrements, userRatings cleared)', () => {
      cache.setRating({
        sourceId: 'src-1', bundleId: 'bundle-1',
        starRating: 4, wilsonScore: 0.8, voteCount: 10,
        confidence: 'medium', cachedAt: Date.now()
      });

      cache.applyOptimisticRating('src-1', 'bundle-1', 5);
      const afterApply = cache.getRating('src-1', 'bundle-1');
      assert.ok(afterApply);
      assert.strictEqual(afterApply.voteCount, 11);

      cache.rollbackOptimisticRating('src-1', 'bundle-1', 5, undefined);

      const afterRollback = cache.getRating('src-1', 'bundle-1');
      assert.ok(afterRollback);
      assert.strictEqual(afterRollback.voteCount, 10);
      // Restored star rating should be back at ~4.0.
      assert.ok(Math.abs(afterRollback.starRating - 4) < 0.05);
      assert.strictEqual(cache.getUserRating('src-1', 'bundle-1'), undefined);
    });

    test('rollbackOptimisticRating undoes a re-rating correctly (voteCount unchanged, userRatings restored to previous)', () => {
      cache.setRating({
        sourceId: 'src-1', bundleId: 'bundle-1',
        starRating: 4, wilsonScore: 0.8, voteCount: 10,
        confidence: 'medium', cachedAt: Date.now()
      });

      // User's first vote of 5.
      cache.applyOptimisticRating('src-1', 'bundle-1', 5);
      const afterFirst = cache.getRating('src-1', 'bundle-1');
      assert.ok(afterFirst);
      const starAfterFirst = afterFirst.starRating;
      assert.strictEqual(afterFirst.voteCount, 11);

      // User re-rates to 2 (previous was 5).
      cache.applyOptimisticRating('src-1', 'bundle-1', 2);
      const afterSecond = cache.getRating('src-1', 'bundle-1');
      assert.ok(afterSecond);
      assert.strictEqual(afterSecond.voteCount, 11);

      // Rollback the re-rating: applied=2, previous=5.
      cache.rollbackOptimisticRating('src-1', 'bundle-1', 2, 5);

      const afterRollback = cache.getRating('src-1', 'bundle-1');
      assert.ok(afterRollback);
      assert.strictEqual(afterRollback.voteCount, 11);
      // Star rating should be restored to what it was after the first vote.
      assert.ok(Math.abs(afterRollback.starRating - starAfterFirst) < 0.05);
      assert.strictEqual(cache.getUserRating('src-1', 'bundle-1'), 5);
    });

    test('rollbackOptimisticRating when the user was the only voter removes the entry from the aggregate cache entirely', () => {
      cache.applyOptimisticRating('src-1', 'new-bundle', 4);

      const afterApply = cache.getRating('src-1', 'new-bundle');
      assert.ok(afterApply);
      assert.strictEqual(afterApply.voteCount, 1);

      cache.rollbackOptimisticRating('src-1', 'new-bundle', 4, undefined);

      assert.strictEqual(cache.getRating('src-1', 'new-bundle'), undefined);
      assert.strictEqual(cache.hasRating('src-1', 'new-bundle'), false);
      assert.strictEqual(cache.getUserRating('src-1', 'new-bundle'), undefined);
    });
  });

  suite('hydrateUserRatings()', () => {
    test('should populate userRatings from resolved local data', () => {
      cache.hydrateUserRatings([
        { sourceId: 'adapter-abc123', bundleId: 'otter', score: 3 },
        { sourceId: 'adapter-abc123', bundleId: 'fox', score: 5 }
      ]);

      assert.strictEqual(cache.getUserRating('adapter-abc123', 'otter'), 3);
      assert.strictEqual(cache.getUserRating('adapter-abc123', 'fox'), 5);
    });

    test('should not overwrite in-session optimistic ratings', () => {
      // User rated 5 in this session
      cache.applyOptimisticRating('adapter-abc123', 'otter', 5);

      // Hydration tries to set 3 (from local storage, older rating)
      cache.hydrateUserRatings([
        { sourceId: 'adapter-abc123', bundleId: 'otter', score: 3 }
      ]);

      // In-session rating wins
      assert.strictEqual(cache.getUserRating('adapter-abc123', 'otter'), 5);
    });

    test('should skip invalid scores', () => {
      cache.hydrateUserRatings([
        { sourceId: 'src-1', bundleId: 'b1', score: 0 as any },
        { sourceId: 'src-1', bundleId: 'b2', score: 6 as any },
        { sourceId: 'src-1', bundleId: 'b3', score: 4 }
      ]);

      assert.strictEqual(cache.getUserRating('src-1', 'b1'), undefined);
      assert.strictEqual(cache.getUserRating('src-1', 'b2'), undefined);
      assert.strictEqual(cache.getUserRating('src-1', 'b3'), 4);
    });

    test('should handle empty array', () => {
      cache.hydrateUserRatings([]);
      // Should not throw, no ratings added
      assert.strictEqual(cache.getUserRating('any', 'bundle'), undefined);
    });

    test('overwrites existing entries when overwrite flag is true', () => {
      cache.hydrateUserRatings([
        { sourceId: 'adapter-abc123', bundleId: 'otter', score: 3 }
      ]);
      assert.strictEqual(cache.getUserRating('adapter-abc123', 'otter'), 3);

      cache.hydrateUserRatings([
        { sourceId: 'adapter-abc123', bundleId: 'otter', score: 5 }
      ], { overwrite: true });
      assert.strictEqual(cache.getUserRating('adapter-abc123', 'otter'), 5);
    });

    test('overwrite does not replace in-session optimistic ratings', () => {
      cache.applyOptimisticRating('adapter-abc123', 'otter', 4);

      cache.hydrateUserRatings([
        { sourceId: 'adapter-abc123', bundleId: 'otter', score: 3 }
      ], { overwrite: true });

      assert.strictEqual(cache.getUserRating('adapter-abc123', 'otter'), 4);
    });
  });

  suite('remote hydration overwrites local', () => {
    test('hydrateUserRatings with overwrite replaces local-only entries', () => {
      // Simulate local hydration (score 3 from local storage)
      cache.hydrateUserRatings([
        { sourceId: 'adapter-hash', bundleId: 'otter', score: 3 }
      ]);
      assert.strictEqual(cache.getUserRating('adapter-hash', 'otter'), 3);

      // Simulate remote hydration arriving with updated score (user rated 5 on other machine)
      cache.hydrateUserRatings([
        { sourceId: 'adapter-hash', bundleId: 'otter', score: 5 }
      ], { overwrite: true });

      assert.strictEqual(cache.getUserRating('adapter-hash', 'otter'), 5);
    });

    test('remote hydration adds ratings not in local storage', () => {
      // Local has nothing
      assert.strictEqual(cache.getUserRating('adapter-hash', 'fox'), undefined);

      // Remote hydration brings a rating
      cache.hydrateUserRatings([
        { sourceId: 'adapter-hash', bundleId: 'fox', score: 4 }
      ], { overwrite: true });

      assert.strictEqual(cache.getUserRating('adapter-hash', 'fox'), 4);
    });
  });

  suite('getConfigSourceId()', () => {
    test('should return config source ID when reverse map is populated', async () => {
      // Populate reverse map via refreshFromHub with sourceIdMap
      const mockRatingsData: RatingsData = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        bundles: {
          otter: {
            sourceId: 'otter-config',
            bundleId: 'otter',
            upvotes: 5,
            downvotes: 0,
            wilsonScore: 0.7,
            starRating: 3,
            totalVotes: 5,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      const ratingService = RatingService.getInstance();
      sandbox.stub(ratingService, 'fetchRatings').resolves(mockRatingsData);

      const sourceIdMap = new Map([['otter-config', 'awesome-copilot-bd06bc6ce82c']]);
      await cache.refreshFromHub('local', 'https://example.com/ratings.json', sourceIdMap);

      // Reverse lookup: adapter hash → config ID
      assert.strictEqual(cache.getConfigSourceId('awesome-copilot-bd06bc6ce82c'), 'otter-config');
    });

    test('should return adapterSourceId itself when no mapping exists', () => {
      assert.strictEqual(cache.getConfigSourceId('unknown-source'), 'unknown-source');
    });
  });
});
