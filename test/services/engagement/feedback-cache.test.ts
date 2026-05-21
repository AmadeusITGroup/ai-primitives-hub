/**
 * Tests for FeedbackCache
 * In-memory cache for bundle feedbacks with synchronous access
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  CachedFeedback,
  FeedbackCache,
  FeedbacksData,
} from '../../../src/services/engagement/feedback-cache';
import {
  FeedbackService,
} from '../../../src/services/engagement/feedback-service';
import {
  Logger,
} from '../../../src/utils/logger';

suite('FeedbackCache', () => {
  let feedbackCache: FeedbackCache;
  let feedbackServiceStub: sinon.SinonStubbedInstance<FeedbackService>;
  let loggerStub: sinon.SinonStubbedInstance<Logger>;

  setup(() => {
    // Reset singleton
    FeedbackCache.resetInstance();

    // Stub logger
    loggerStub = sinon.createStubInstance(Logger);
    sinon.stub(Logger, 'getInstance').returns(loggerStub);

    // Stub FeedbackService
    feedbackServiceStub = sinon.createStubInstance(FeedbackService);
    sinon.stub(FeedbackService, 'getInstance').returns(feedbackServiceStub);

    feedbackCache = FeedbackCache.getInstance();
  });

  teardown(() => {
    sinon.restore();
    FeedbackCache.resetInstance();
  });

  suite('getInstance()', () => {
    test('should return singleton instance', () => {
      const instance1 = FeedbackCache.getInstance();
      const instance2 = FeedbackCache.getInstance();
      assert.strictEqual(instance1, instance2);
    });
  });

  suite('getFeedbacks()', () => {
    test('should return undefined for uncached bundle', () => {
      const feedbacks = feedbackCache.getFeedbacks('test/bundle');
      assert.strictEqual(feedbacks, undefined);
    });

    test('should return cached feedbacks for bundle', () => {
      const mockFeedbacks: CachedFeedback[] = [
        {
          id: 'feedback-1',
          bundleId: 'test/bundle',
          rating: 5,
          comment: 'Great bundle!',
          timestamp: '2026-01-20T10:00:00Z',
          version: '1.0.0',
          cachedAt: Date.now()
        }
      ];

      feedbackCache.setFeedbacks('test/bundle', mockFeedbacks);
      const result = feedbackCache.getFeedbacks('test/bundle');

      assert.strictEqual(result?.length, 1);
      assert.strictEqual(result?.[0].comment, 'Great bundle!');
    });

    test('should return empty array for bundle with no feedbacks', () => {
      feedbackCache.setFeedbacks('test/bundle', []);
      const result = feedbackCache.getFeedbacks('test/bundle');

      assert.strictEqual(result?.length, 0);
    });
  });

  suite('hasFeedbacks()', () => {
    test('should return false for uncached bundle', () => {
      assert.strictEqual(feedbackCache.hasFeedbacks('test/bundle'), false);
    });

    test('should return true for cached bundle with feedbacks', () => {
      feedbackCache.setFeedbacks('test/bundle', [{
        id: 'feedback-1',
        bundleId: 'test/bundle',
        rating: 5,
        comment: 'Great!',
        timestamp: '2026-01-20T10:00:00Z',
        cachedAt: Date.now()
      }]);

      assert.strictEqual(feedbackCache.hasFeedbacks('test/bundle'), true);
    });

    test('should return true even for bundle with empty feedbacks array', () => {
      feedbackCache.setFeedbacks('test/bundle', []);
      assert.strictEqual(feedbackCache.hasFeedbacks('test/bundle'), true);
    });
  });

  suite('refreshFromHub()', () => {
    test('should fetch and cache feedbacks from hub', async () => {
      const mockData: FeedbacksData = {
        version: '1.0.0',
        generated: '2026-01-29T08:00:00Z',
        bundles: [
          {
            bundleId: 'test/bundle-1',
            feedbacks: [
              {
                id: 'f1',
                rating: 5,
                comment: 'Excellent!',
                timestamp: '2026-01-20T10:00:00Z',
                version: '1.0.0'
              }
            ]
          },
          {
            bundleId: 'test/bundle-2',
            feedbacks: [
              {
                id: 'f2',
                rating: 4,
                comment: 'Good',
                timestamp: '2026-01-21T10:00:00Z'
              }
            ]
          }
        ]
      };

      feedbackServiceStub.fetchFeedbacks.resolves(mockData);

      await feedbackCache.refreshFromHub('test-hub', 'https://example.com/feedbacks.json');

      assert.strictEqual(feedbackCache.hasFeedbacks('test/bundle-1'), true);
      assert.strictEqual(feedbackCache.hasFeedbacks('test/bundle-2'), true);

      const feedbacks1 = feedbackCache.getFeedbacks('test/bundle-1');
      assert.strictEqual(feedbacks1?.length, 1);
      assert.strictEqual(feedbacks1?.[0].comment, 'Excellent!');
    });

    test('should handle empty feedbacks data', async () => {
      const mockData: FeedbacksData = {
        version: '1.0.0',
        generated: '2026-01-29T08:00:00Z',
        bundles: []
      };

      feedbackServiceStub.fetchFeedbacks.resolves(mockData);

      await feedbackCache.refreshFromHub('test-hub', 'https://example.com/feedbacks.json');

      assert.strictEqual(feedbackCache.size, 0);
    });

    test('should handle fetch errors gracefully', async () => {
      feedbackServiceStub.fetchFeedbacks.rejects(new Error('Network error'));

      // Should not throw
      await feedbackCache.refreshFromHub('test-hub', 'https://example.com/feedbacks.json');

      // Cache should remain empty
      assert.strictEqual(feedbackCache.size, 0);
    });

    test('should prevent concurrent refreshes', async () => {
      const mockData: FeedbacksData = {
        version: '1.0.0',
        generated: '2026-01-29T08:00:00Z',
        bundles: []
      };

      feedbackServiceStub.fetchFeedbacks.resolves(mockData);

      // Start two refreshes simultaneously
      const promise1 = feedbackCache.refreshFromHub('test-hub', 'https://example.com/feedbacks.json');
      const promise2 = feedbackCache.refreshFromHub('test-hub', 'https://example.com/feedbacks.json');

      await Promise.all([promise1, promise2]);

      // Should only call fetchFeedbacks once
      assert.strictEqual(feedbackServiceStub.fetchFeedbacks.callCount, 1);
    });

    test('should emit onCacheUpdated event after refresh', async () => {
      const mockData: FeedbacksData = {
        version: '1.0.0',
        generated: '2026-01-29T08:00:00Z',
        bundles: []
      };

      feedbackServiceStub.fetchFeedbacks.resolves(mockData);

      let eventFired = false;
      feedbackCache.onCacheUpdated(() => {
        eventFired = true;
      });

      await feedbackCache.refreshFromHub('test-hub', 'https://example.com/feedbacks.json');

      assert.strictEqual(eventFired, true);
    });
  });

  suite('clear()', () => {
    test('should clear all cached feedbacks', () => {
      feedbackCache.setFeedbacks('test/bundle-1', []);
      feedbackCache.setFeedbacks('test/bundle-2', []);

      assert.strictEqual(feedbackCache.size, 2);

      feedbackCache.clear();

      assert.strictEqual(feedbackCache.size, 0);
      assert.strictEqual(feedbackCache.hasFeedbacks('test/bundle-1'), false);
    });

    test('should emit onCacheUpdated event', () => {
      let eventFired = false;
      feedbackCache.onCacheUpdated(() => {
        eventFired = true;
      });

      feedbackCache.clear();

      assert.strictEqual(eventFired, true);
    });
  });

  suite('clearHub()', () => {
    test('should clear feedbacks loaded via refreshFromHub', async () => {
      const hub1Data: FeedbacksData = {
        version: '1.0.0',
        generated: new Date().toISOString(),
        bundles: [
          { bundleId: 'bundle-1', feedbacks: [{ id: 'f1', rating: 4, comment: 'good', timestamp: new Date().toISOString() }] },
          { bundleId: 'bundle-2', feedbacks: [{ id: 'f2', rating: 5, comment: 'great', timestamp: new Date().toISOString() }] }
        ]
      };
      const hub2Data: FeedbacksData = {
        version: '1.0.0',
        generated: new Date().toISOString(),
        bundles: [
          { bundleId: 'bundle-3', feedbacks: [{ id: 'f3', rating: 3, comment: 'ok', timestamp: new Date().toISOString() }] }
        ]
      };

      feedbackServiceStub.fetchFeedbacks.onFirstCall().resolves(hub1Data);
      feedbackServiceStub.fetchFeedbacks.onSecondCall().resolves(hub2Data);

      await feedbackCache.refreshFromHub('hub1', 'https://hub1/feedbacks.json');
      await feedbackCache.refreshFromHub('hub2', 'https://hub2/feedbacks.json');

      assert.strictEqual(feedbackCache.size, 3);

      feedbackCache.clearHub('hub1');

      assert.strictEqual(feedbackCache.hasFeedbacks('bundle-1'), false);
      assert.strictEqual(feedbackCache.hasFeedbacks('bundle-2'), false);
      assert.strictEqual(feedbackCache.hasFeedbacks('bundle-3'), true);
    });
  });

  suite('getCachedBundleIds()', () => {
    test('should return all cached bundle IDs', () => {
      feedbackCache.setFeedbacks('test/bundle-1', []);
      feedbackCache.setFeedbacks('test/bundle-2', []);

      const ids = feedbackCache.getCachedBundleIds();

      assert.strictEqual(ids.length, 2);
      assert.ok(ids.includes('test/bundle-1'));
      assert.ok(ids.includes('test/bundle-2'));
    });

    test('should return empty array when cache is empty', () => {
      const ids = feedbackCache.getCachedBundleIds();
      assert.strictEqual(ids.length, 0);
    });
  });

  suite('size', () => {
    test('should return number of cached bundles', () => {
      assert.strictEqual(feedbackCache.size, 0);

      feedbackCache.setFeedbacks('test/bundle-1', []);
      assert.strictEqual(feedbackCache.size, 1);

      feedbackCache.setFeedbacks('test/bundle-2', []);
      assert.strictEqual(feedbackCache.size, 2);
    });
  });

  suite('dispose()', () => {
    test('should clear cache and dispose event emitter', () => {
      feedbackCache.setFeedbacks('test/bundle', []);
      assert.strictEqual(feedbackCache.size, 1);

      feedbackCache.dispose();

      assert.strictEqual(feedbackCache.size, 0);
    });
  });
});
