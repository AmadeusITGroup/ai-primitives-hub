/**
 * Tests for FeedbackService
 * Fetches and caches bundle feedbacks from hub sources
 */

import * as assert from 'node:assert';
import nock from 'nock';
import {
  FeedbacksData,
  FeedbackService,
} from '../../../src/services/engagement/feedback-service';

suite('FeedbackService', () => {
  let service: FeedbackService;

  const validFeedbacksData: FeedbacksData = {
    version: '1.0.0',
    generated: '2026-05-20T00:00:00Z',
    bundles: [
      {
        bundleId: 'bundle-1',
        feedbacks: [
          { id: 'f1', comment: 'Great bundle!', rating: 5, timestamp: '2026-05-20T00:00:00Z' },
          { id: 'f2', comment: 'Needs improvement', rating: 3, timestamp: '2026-05-19T00:00:00Z' }
        ]
      }
    ]
  };

  setup(() => {
    FeedbackService.resetInstance();
    service = FeedbackService.getInstance();
  });

  teardown(() => {
    nock.cleanAll();
    FeedbackService.resetInstance();
  });

  suite('Singleton Pattern', () => {
    test('should return same instance', () => {
      const instance1 = FeedbackService.getInstance();
      const instance2 = FeedbackService.getInstance();
      assert.strictEqual(instance1, instance2);
    });

    test('should create new instance after reset', () => {
      const instance1 = FeedbackService.getInstance();
      FeedbackService.resetInstance();
      const instance2 = FeedbackService.getInstance();
      assert.notStrictEqual(instance1, instance2);
    });
  });

  suite('fetchFeedbacks', () => {
    test('should fetch and cache feedbacks data', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .reply(200, validFeedbacksData);

      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.deepStrictEqual(result, validFeedbacksData);
      assert.strictEqual(service.cacheSize, 1);
    });

    test('should return cached data on second call', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .reply(200, validFeedbacksData);

      await service.fetchFeedbacks('https://example.com/feedbacks.json');
      // Second call should use cache (no new nock needed)
      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.deepStrictEqual(result, validFeedbacksData);
    });

    test('should pass authorization header when accessToken provided', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .matchHeader('Authorization', 'token my-token')
        .reply(200, validFeedbacksData);

      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json', 'my-token');
      assert.deepStrictEqual(result, validFeedbacksData);
    });

    test('should return null for 404 response', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .reply(404);

      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.strictEqual(result, null);
    });

    test('should return null for network error', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .replyWithError('ECONNREFUSED');

      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.strictEqual(result, null);
    });

    test('should return null for invalid response (not an object)', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .reply(200, 'not json');

      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.strictEqual(result, null);
    });

    test('should return null for malformed data (missing bundles array)', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .reply(200, { version: '1.0.0' });

      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.strictEqual(result, null);
    });

    test('should return null for malformed data (bundles not an array)', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .reply(200, { version: '1.0.0', bundles: {} });

      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.strictEqual(result, null);
    });

    test('should return null for 500 server error', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .reply(500);

      const result = await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.strictEqual(result, null);
    });
  });

  suite('clearCache', () => {
    test('should clear specific URL from cache', async () => {
      nock('https://example.com')
        .get('/feedbacks.json')
        .reply(200, validFeedbacksData);

      await service.fetchFeedbacks('https://example.com/feedbacks.json');
      assert.strictEqual(service.cacheSize, 1);

      service.clearCache('https://example.com/feedbacks.json');
      assert.strictEqual(service.cacheSize, 0);
    });

    test('should clear all caches when called without URL', async () => {
      nock('https://example.com')
        .get('/feedbacks1.json')
        .reply(200, validFeedbacksData);
      nock('https://example.com')
        .get('/feedbacks2.json')
        .reply(200, validFeedbacksData);

      await service.fetchFeedbacks('https://example.com/feedbacks1.json');
      await service.fetchFeedbacks('https://example.com/feedbacks2.json');
      assert.strictEqual(service.cacheSize, 2);

      service.clearCache();
      assert.strictEqual(service.cacheSize, 0);
    });
  });
});
