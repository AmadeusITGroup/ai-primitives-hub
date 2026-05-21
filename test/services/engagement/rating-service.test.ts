/**
 * Tests for RatingService
 * Fetches and caches bundle ratings from hub sources
 */

import * as assert from 'node:assert';
import nock from 'nock';
import {
  BundleRating,
  RatingsData,
  RatingService,
} from '../../../src/services/engagement/rating-service';

suite('RatingService', () => {
  let service: RatingService;
  const testUrl = 'https://example.com/ratings.json';

  const createMockRatingsData = (bundles: Record<string, Partial<BundleRating>> = {}): RatingsData => ({
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    bundles: Object.fromEntries(
      Object.entries(bundles).map(([id, data]) => [
        id,
        {
          sourceId: data.sourceId ?? 'test-source',
          bundleId: id,
          upvotes: data.upvotes ?? 10,
          downvotes: data.downvotes ?? 2,
          wilsonScore: data.wilsonScore ?? 0.75,
          starRating: data.starRating ?? 4.2,
          totalVotes: data.totalVotes ?? 12,
          lastUpdated: data.lastUpdated ?? new Date().toISOString()
        }
      ])
    )
  });

  setup(() => {
    RatingService.resetInstance();
    service = RatingService.getInstance();
    nock.cleanAll();
  });

  teardown(() => {
    service.clearCache();
    nock.cleanAll();
  });

  suite('getInstance()', () => {
    test('should return singleton instance', () => {
      const instance1 = RatingService.getInstance();
      const instance2 = RatingService.getInstance();
      assert.strictEqual(instance1, instance2);
    });

    test('should create new instance after reset', () => {
      const instance1 = RatingService.getInstance();
      RatingService.resetInstance();
      const instance2 = RatingService.getInstance();
      assert.notStrictEqual(instance1, instance2);
    });
  });

  suite('fetchRatings()', () => {
    test('should fetch ratings from URL', async () => {
      const mockData = createMockRatingsData({
        'bundle-1': { upvotes: 15, downvotes: 3 },
        'bundle-2': { upvotes: 8, downvotes: 1 }
      });

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      const result = await service.fetchRatings(testUrl);

      assert.ok(result);
      assert.strictEqual(Object.keys(result.bundles).length, 2);
      assert.strictEqual(result.bundles['bundle-1'].upvotes, 15);
    });

    test('should cache results', async () => {
      const mockData = createMockRatingsData({ 'bundle-1': {} });

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      await service.fetchRatings(testUrl);

      // Second call should use cache (no new nock needed)
      const result = await service.fetchRatings(testUrl);

      assert.ok(result);
      assert.strictEqual(service.isCached(testUrl), true);
    });

    test('should force refresh when requested', async () => {
      const mockData1 = createMockRatingsData({ 'bundle-1': { upvotes: 10 } });
      const mockData2 = createMockRatingsData({ 'bundle-1': { upvotes: 20 } });

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData1);

      await service.fetchRatings(testUrl);

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData2);

      const result = await service.fetchRatings(testUrl, true);

      assert.ok(result);
      assert.strictEqual(result.bundles['bundle-1'].upvotes, 20);
    });

    test('should return undefined on network error', async () => {
      nock('https://example.com')
        .get(/\/ratings\.json/)
        .replyWithError('Network error');

      const result = await service.fetchRatings(testUrl);

      assert.strictEqual(result, undefined);
    });

    test('should return undefined for invalid data structure', async () => {
      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, { invalid: 'data' });

      const result = await service.fetchRatings(testUrl);

      assert.strictEqual(result, undefined);
    });

    test('should return undefined on 404', async () => {
      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(404);

      const result = await service.fetchRatings(testUrl);

      assert.strictEqual(result, undefined);
    });
  });

  suite('getBundleRating()', () => {
    test('should return rating for existing bundle', async () => {
      const mockData = createMockRatingsData({
        'test-bundle': { upvotes: 25, downvotes: 5, starRating: 4.5 }
      });

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      const rating = await service.getBundleRating(testUrl, 'test-bundle');

      assert.ok(rating);
      assert.strictEqual(rating.upvotes, 25);
      assert.strictEqual(rating.downvotes, 5);
      assert.strictEqual(rating.starRating, 4.5);
    });

    test('should return undefined for non-existent bundle', async () => {
      const mockData = createMockRatingsData({ 'other-bundle': {} });

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      const rating = await service.getBundleRating(testUrl, 'non-existent');

      assert.strictEqual(rating, undefined);
    });
  });

  suite('getRatingStats()', () => {
    test('should convert BundleRating to RatingStats', async () => {
      const mockData = createMockRatingsData({
        'test-bundle': {
          upvotes: 20,
          downvotes: 5,
          starRating: 4,
          totalVotes: 25
        }
      });

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      const stats = await service.getRatingStats(testUrl, 'test-bundle');

      assert.ok(stats);
      assert.strictEqual(stats.resourceId, 'test-bundle');
      assert.strictEqual(stats.averageRating, 4);
      assert.strictEqual(stats.ratingCount, 25);
      assert.strictEqual(stats.distribution[5], 20);
      assert.strictEqual(stats.distribution[1], 5);
    });

    test('should return undefined for non-existent bundle', async () => {
      const mockData = createMockRatingsData({});

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      const stats = await service.getRatingStats(testUrl, 'non-existent');

      assert.strictEqual(stats, undefined);
    });
  });

  suite('formatRatingForDisplay()', () => {
    test('should format with star rating for 5+ votes', () => {
      const rating: BundleRating = {
        sourceId: 'test-source',
        bundleId: 'test',
        upvotes: 10,
        downvotes: 2,
        wilsonScore: 0.75,
        starRating: 4.2,
        totalVotes: 12,
        lastUpdated: new Date().toISOString()
      };

      const formatted = service.formatRatingForDisplay(rating);

      assert.strictEqual(formatted, '★ 4.2');
    });

    test('should format with thumbs up for fewer than 5 votes', () => {
      const rating: BundleRating = {
        sourceId: 'test-source',
        bundleId: 'test',
        upvotes: 3,
        downvotes: 1,
        wilsonScore: 0.5,
        starRating: 3.5,
        totalVotes: 4,
        lastUpdated: new Date().toISOString()
      };

      const formatted = service.formatRatingForDisplay(rating);

      assert.strictEqual(formatted, '👍 3');
    });

    test('should return empty string for zero votes', () => {
      const rating: BundleRating = {
        sourceId: 'test-source',
        bundleId: 'test',
        upvotes: 0,
        downvotes: 0,
        wilsonScore: 0,
        starRating: 0,
        totalVotes: 0,
        lastUpdated: new Date().toISOString()
      };

      const formatted = service.formatRatingForDisplay(rating);

      assert.strictEqual(formatted, '');
    });
  });

  suite('getFormattedRating()', () => {
    test('should return formatted rating string', async () => {
      const mockData = createMockRatingsData({
        'test-bundle': { upvotes: 15, starRating: 4.5, totalVotes: 18 }
      });

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      const formatted = await service.getFormattedRating(testUrl, 'test-bundle');

      assert.strictEqual(formatted, '★ 4.5');
    });

    test('should return empty string for non-existent bundle', async () => {
      const mockData = createMockRatingsData({});

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      const formatted = await service.getFormattedRating(testUrl, 'non-existent');

      assert.strictEqual(formatted, '');
    });
  });

  suite('Cache Management', () => {
    test('clearCache() should clear all cached data', async () => {
      const mockData = createMockRatingsData({ 'bundle-1': {} });

      nock('https://example.com')
        .get(/\/ratings\.json/)
        .reply(200, mockData);

      await service.fetchRatings(testUrl);
      assert.strictEqual(service.isCached(testUrl), true);

      service.clearCache();

      assert.strictEqual(service.isCached(testUrl), false);
    });

    test('clearCacheForUrl() should clear specific URL cache', async () => {
      const mockData = createMockRatingsData({ 'bundle-1': {} });
      const url1 = 'https://example.com/ratings1.json';
      const url2 = 'https://example.com/ratings2.json';

      nock('https://example.com')
        .get(/\/ratings1\.json/)
        .reply(200, mockData);

      nock('https://example.com')
        .get(/\/ratings2\.json/)
        .reply(200, mockData);

      await service.fetchRatings(url1);
      await service.fetchRatings(url2);

      service.clearCacheForUrl(url1);

      assert.strictEqual(service.isCached(url1), false);
      assert.strictEqual(service.isCached(url2), true);
    });

    test('isCached() should return false for non-cached URL', () => {
      assert.strictEqual(service.isCached('https://not-cached.com/ratings.json'), false);
    });
  });
});
