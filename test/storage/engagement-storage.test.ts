/**
 * Tests for EngagementStorage
 * File-based persistence for engagement data (ratings, feedback)
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EngagementStorage,
} from '../../src/storage/engagement-storage';
import {
  Feedback,
  Rating,
  RatingScore,
} from '../../src/types/engagement';
import {
  PendingFeedback,
} from '../../src/types/pending-feedback';

suite('EngagementStorage', () => {
  let storage: EngagementStorage;
  let tempDir: string;

  // ===== Test Utilities =====
  const createRating = (
    id: string,
    resourceId: string,
    score: RatingScore = 4
  ): Rating => ({
    id,
    timestamp: new Date().toISOString(),
    resourceType: 'bundle',
    resourceId,
    score
  });

  const createFeedback = (
    id: string,
    resourceId: string,
    comment = 'Great bundle!'
  ): Feedback => ({
    id,
    timestamp: new Date().toISOString(),
    resourceType: 'bundle',
    resourceId,
    comment
  });

  setup(async () => {
    // Create temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engagement-storage-test-'));
    storage = new EngagementStorage(tempDir);
    await storage.initialize();
  });

  teardown(() => {
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('constructor', () => {
    test('should throw error for empty storage path', () => {
      assert.throws(
        () => new EngagementStorage(''),
        /Storage path cannot be empty/
      );
    });

    test('should throw error for whitespace-only storage path', () => {
      assert.throws(
        () => new EngagementStorage('   '),
        /Storage path cannot be empty/
      );
    });
  });

  suite('initialize()', () => {
    test('should create engagement directory', async () => {
      const newTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engagement-init-test-'));
      const newStorage = new EngagementStorage(newTempDir);
      await newStorage.initialize();

      const engagementDir = path.join(newTempDir, 'engagement');
      assert.ok(fs.existsSync(engagementDir), 'Engagement directory should exist');

      // Cleanup
      fs.rmSync(newTempDir, { recursive: true, force: true });
    });
  });

  suite('getPaths()', () => {
    test('should return correct storage paths', () => {
      const paths = storage.getPaths();

      assert.ok(paths.root.includes('engagement'));
      assert.ok(paths.ratings.endsWith('ratings.json'));
      assert.ok(paths.feedback.endsWith('feedback.json'));
    });
  });

  // ========================================================================
  // Rating Tests
  // ========================================================================

  suite('Rating Operations', () => {
    suite('saveRating()', () => {
      test('should save a rating', async () => {
        const rating = createRating('r1', 'bundle-1', 5);
        await storage.saveRating(rating);

        const retrieved = await storage.getRating('bundle', 'bundle-1');
        assert.ok(retrieved);
        assert.strictEqual(retrieved.score, 5);
      });

      test('should update existing rating for same resource', async () => {
        await storage.saveRating(createRating('r1', 'bundle-1', 3));
        await storage.saveRating(createRating('r2', 'bundle-1', 5));

        const ratings = await storage.getAllRatings();
        assert.strictEqual(ratings.length, 1);
        assert.strictEqual(ratings[0].score, 5);
      });
    });

    suite('getRating()', () => {
      test('should return undefined for non-existent rating', async () => {
        const rating = await storage.getRating('bundle', 'non-existent');
        assert.strictEqual(rating, undefined);
      });

      test('should return correct rating for resource', async () => {
        await storage.saveRating(createRating('r1', 'bundle-1', 4));
        await storage.saveRating(createRating('r2', 'bundle-2', 5));

        const rating = await storage.getRating('bundle', 'bundle-1');
        assert.ok(rating);
        assert.strictEqual(rating.score, 4);
      });
    });

    suite('getAllRatings()', () => {
      test('should return empty array when no ratings exist', async () => {
        const ratings = await storage.getAllRatings();
        assert.deepStrictEqual(ratings, []);
      });

      test('should return all ratings', async () => {
        await storage.saveRating(createRating('r1', 'bundle-1', 4));
        await storage.saveRating(createRating('r2', 'bundle-2', 5));

        const ratings = await storage.getAllRatings();
        assert.strictEqual(ratings.length, 2);
      });
    });

    suite('deleteRating()', () => {
      test('should delete existing rating', async () => {
        await storage.saveRating(createRating('r1', 'bundle-1', 4));
        await storage.deleteRating('bundle', 'bundle-1');

        const rating = await storage.getRating('bundle', 'bundle-1');
        assert.strictEqual(rating, undefined);
      });

      test('should not throw when deleting non-existent rating', async () => {
        await storage.deleteRating('bundle', 'non-existent');
        // Should not throw
      });
    });
  });

  // ========================================================================
  // Feedback Tests
  // ========================================================================

  suite('Feedback Operations', () => {
    suite('saveFeedback()', () => {
      test('should save feedback', async () => {
        const feedback = createFeedback('f1', 'bundle-1', 'Great!');
        await storage.saveFeedback(feedback);

        const retrieved = await storage.getFeedback('bundle', 'bundle-1');
        assert.strictEqual(retrieved.length, 1);
        assert.strictEqual(retrieved[0].comment, 'Great!');
      });

      test('should allow multiple feedback entries for same resource', async () => {
        await storage.saveFeedback(createFeedback('f1', 'bundle-1', 'First'));
        await storage.saveFeedback(createFeedback('f2', 'bundle-1', 'Second'));

        const feedback = await storage.getFeedback('bundle', 'bundle-1');
        assert.strictEqual(feedback.length, 2);
      });
    });

    suite('getFeedback()', () => {
      test('should return empty array for resource with no feedback', async () => {
        const feedback = await storage.getFeedback('bundle', 'non-existent');
        assert.deepStrictEqual(feedback, []);
      });

      test('should return feedback sorted by timestamp descending', async () => {
        const f1 = createFeedback('f1', 'bundle-1', 'First');
        f1.timestamp = '2024-01-01T00:00:00.000Z';

        const f2 = createFeedback('f2', 'bundle-1', 'Second');
        f2.timestamp = '2024-06-01T00:00:00.000Z';

        await storage.saveFeedback(f1);
        await storage.saveFeedback(f2);

        const feedback = await storage.getFeedback('bundle', 'bundle-1');
        assert.strictEqual(feedback[0].comment, 'Second'); // Most recent first
      });

      test('should limit results', async () => {
        for (let i = 0; i < 10; i++) {
          await storage.saveFeedback(createFeedback(`f${i}`, 'bundle-1', `Comment ${i}`));
        }

        const feedback = await storage.getFeedback('bundle', 'bundle-1', 3);
        assert.strictEqual(feedback.length, 3);
      });
    });

    suite('getAllFeedback()', () => {
      test('should return all feedback', async () => {
        await storage.saveFeedback(createFeedback('f1', 'bundle-1'));
        await storage.saveFeedback(createFeedback('f2', 'bundle-2'));

        const feedback = await storage.getAllFeedback();
        assert.strictEqual(feedback.length, 2);
      });
    });

    suite('deleteFeedback()', () => {
      test('should delete feedback by ID', async () => {
        await storage.saveFeedback(createFeedback('f1', 'bundle-1'));
        await storage.saveFeedback(createFeedback('f2', 'bundle-1'));

        await storage.deleteFeedback('f1');

        const feedback = await storage.getAllFeedback();
        assert.strictEqual(feedback.length, 1);
        assert.strictEqual(feedback[0].id, 'f2');
      });
    });
  });

  // ========================================================================
  // Pending Feedback Tests
  // ========================================================================

  suite('Pending Feedback Operations', () => {
    test('should save and retrieve pending feedback', async () => {
      const pending: PendingFeedback = {
        id: 'pf-1',
        bundleId: 'test-bundle',
        sourceId: 'test-source',
        hubId: 'test-hub',
        resourceType: 'bundle',
        rating: 4,
        comment: 'Great bundle!',
        timestamp: new Date().toISOString(),
        synced: false
      };

      await storage.savePendingFeedback(pending);
      const result = await storage.getPendingFeedback();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'pf-1');
      assert.strictEqual(result[0].synced, false);
    });

    test('should retrieve only unsynced pending feedback', async () => {
      const synced: PendingFeedback = {
        id: 'pf-synced', bundleId: 'b1', sourceId: 's1', hubId: 'h1',
        resourceType: 'bundle', rating: 5,
        timestamp: new Date().toISOString(), synced: true
      };
      const unsynced: PendingFeedback = {
        id: 'pf-unsynced', bundleId: 'b2', sourceId: 's2', hubId: 'h2',
        resourceType: 'bundle', rating: 3,
        timestamp: new Date().toISOString(), synced: false
      };

      await storage.savePendingFeedback(synced);
      await storage.savePendingFeedback(unsynced);
      const result = await storage.getUnsyncedFeedback();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'pf-unsynced');
    });

    test('should update synced status', async () => {
      const pending: PendingFeedback = {
        id: 'pf-1', bundleId: 'b1', sourceId: 's1', hubId: 'h1',
        resourceType: 'bundle', rating: 4,
        timestamp: new Date().toISOString(), synced: false
      };

      await storage.savePendingFeedback(pending);
      await storage.markFeedbackSynced('pf-1');
      const result = await storage.getPendingFeedback();
      assert.strictEqual(result[0].synced, true);
    });

    test('should delete pending feedback by id', async () => {
      const pending: PendingFeedback = {
        id: 'pf-1', bundleId: 'b1', sourceId: 's1', hubId: 'h1',
        resourceType: 'bundle', rating: 4,
        timestamp: new Date().toISOString(), synced: false
      };

      await storage.savePendingFeedback(pending);
      await storage.deletePendingFeedback('pf-1');
      const result = await storage.getPendingFeedback();
      assert.strictEqual(result.length, 0);
    });

    test('should update existing entry when saving with same id', async () => {
      const pending: PendingFeedback = {
        id: 'pf-1', bundleId: 'b1', sourceId: 's1', hubId: 'h1',
        resourceType: 'bundle', rating: 3,
        timestamp: new Date().toISOString(), synced: false
      };

      await storage.savePendingFeedback(pending);
      await storage.savePendingFeedback({ ...pending, rating: 5 });
      const result = await storage.getPendingFeedback();
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].rating, 5);
    });
  });

  // ========================================================================
  // Cache and Clear Tests
  // ========================================================================

  suite('Cache Management', () => {
    test('clearCache should not affect persisted data', async () => {
      await storage.saveRating(createRating('r1', 'bundle-1', 5));

      storage.clearCache();

      // Data should still be retrievable from disk
      const rating = await storage.getRating('bundle', 'bundle-1');

      assert.ok(rating);
    });

    test('clearAll should remove all data', async () => {
      await storage.saveRating(createRating('r1', 'bundle-1', 5));
      await storage.saveFeedback(createFeedback('f1', 'bundle-1'));

      await storage.clearAll();

      const ratings = await storage.getAllRatings();
      const feedback = await storage.getAllFeedback();

      assert.strictEqual(ratings.length, 0);
      assert.strictEqual(feedback.length, 0);
    });
  });
});
