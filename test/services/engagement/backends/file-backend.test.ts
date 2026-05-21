/**
 * Tests for FileBackend
 * Local file-based storage backend for engagement data
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileBackend,
} from '../../../../src/services/engagement/backends/file-backend';
import {
  FileBackendConfig,
} from '../../../../src/types/engagement';

suite('FileBackend', () => {
  let backend: FileBackend;
  let tempDir: string;

  // ===== Test Utilities =====
  const createConfig = (storagePath: string): FileBackendConfig => ({
    type: 'file',
    storagePath
  });

  setup(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-backend-test-'));
    backend = new FileBackend();
    await backend.initialize(createConfig(tempDir));
  });

  teardown(() => {
    backend.dispose();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Lifecycle', () => {
    suite('initialize()', () => {
      test('should initialize successfully with valid config', async () => {
        const newBackend = new FileBackend();
        const newTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-backend-init-'));

        await newBackend.initialize(createConfig(newTempDir));

        assert.strictEqual(newBackend.initialized, true);
        assert.strictEqual(newBackend.type, 'file');

        newBackend.dispose();
        fs.rmSync(newTempDir, { recursive: true, force: true });
      });

      test('should throw error for invalid config type', async () => {
        const newBackend = new FileBackend();

        await assert.rejects(
          async () => newBackend.initialize({ type: 'github-issues', repository: 'test/repo' }),
          /Invalid config type/
        );
      });

      test('should throw error when storagePath is missing', async () => {
        const newBackend = new FileBackend();

        await assert.rejects(
          async () => newBackend.initialize({ type: 'file' }),
          /storagePath is required/
        );
      });
    });

    suite('dispose()', () => {
      test('should set initialized to false', () => {
        assert.strictEqual(backend.initialized, true);
        backend.dispose();
        assert.strictEqual(backend.initialized, false);
      });
    });

    suite('ensureInitialized', () => {
      test('should throw error when calling methods before initialization', async () => {
        const uninitializedBackend = new FileBackend();

        await assert.rejects(
          async () => uninitializedBackend.getRating('bundle', 'test-bundle'),
          /not initialized/
        );
      });
    });
  });

  suite('Rating Operations', () => {
    suite('submitRating()', () => {
      test('should submit a rating', async () => {
        const rating = FileBackend.createRating('bundle', 'test-bundle', 5, '1.0.0');

        await backend.submitRating(rating);

        const retrieved = await backend.getRating('bundle', 'test-bundle');
        assert.ok(retrieved);
        assert.strictEqual(retrieved.score, 5);
      });

      test('should update existing rating', async () => {
        await backend.submitRating(FileBackend.createRating('bundle', 'test-bundle', 3));
        await backend.submitRating(FileBackend.createRating('bundle', 'test-bundle', 5));

        const rating = await backend.getRating('bundle', 'test-bundle');
        assert.ok(rating);
        assert.strictEqual(rating.score, 5);
      });
    });

    suite('getRating()', () => {
      test('should return undefined for non-existent rating', async () => {
        const rating = await backend.getRating('bundle', 'non-existent');
        assert.strictEqual(rating, undefined);
      });
    });

    suite('getAggregatedRatings()', () => {
      test('should return undefined when no rating exists', async () => {
        const stats = await backend.getAggregatedRatings('bundle', 'non-existent');
        assert.strictEqual(stats, undefined);
      });

      test('should return stats for single rating', async () => {
        await backend.submitRating(FileBackend.createRating('bundle', 'test-bundle', 4));

        const stats = await backend.getAggregatedRatings('bundle', 'test-bundle');

        assert.ok(stats);
        assert.strictEqual(stats.averageRating, 4);
        assert.strictEqual(stats.ratingCount, 1);
        assert.strictEqual(stats.distribution[4], 1);
      });
    });

    suite('deleteRating()', () => {
      test('should delete existing rating', async () => {
        await backend.submitRating(FileBackend.createRating('bundle', 'test-bundle', 5));

        await backend.deleteRating('bundle', 'test-bundle');

        const rating = await backend.getRating('bundle', 'test-bundle');
        assert.strictEqual(rating, undefined);
      });
    });
  });

  suite('Feedback Operations', () => {
    suite('submitFeedback()', () => {
      test('should submit feedback', async () => {
        const feedback = FileBackend.createFeedback(
          'bundle',
          'test-bundle',
          'Great bundle!',
          '1.0.0',
          5
        );

        await backend.submitFeedback(feedback);

        const retrieved = await backend.getFeedback('bundle', 'test-bundle');
        assert.strictEqual(retrieved.length, 1);
        assert.strictEqual(retrieved[0].comment, 'Great bundle!');
      });
    });

    suite('getFeedback()', () => {
      test('should return empty array when no feedback exists', async () => {
        const feedback = await backend.getFeedback('bundle', 'non-existent');
        assert.deepStrictEqual(feedback, []);
      });

      test('should limit results', async () => {
        for (let i = 0; i < 10; i++) {
          await backend.submitFeedback(
            FileBackend.createFeedback('bundle', 'test-bundle', `Comment ${i}`)
          );
        }

        const feedback = await backend.getFeedback('bundle', 'test-bundle', 3);
        assert.strictEqual(feedback.length, 3);
      });
    });

    suite('deleteFeedback()', () => {
      test('should delete feedback by ID', async () => {
        const f1 = FileBackend.createFeedback('bundle', 'test-bundle', 'First');
        const f2 = FileBackend.createFeedback('bundle', 'test-bundle', 'Second');

        await backend.submitFeedback(f1);
        await backend.submitFeedback(f2);

        await backend.deleteFeedback(f1.id);

        const feedback = await backend.getFeedback('bundle', 'test-bundle');
        assert.strictEqual(feedback.length, 1);
        assert.strictEqual(feedback[0].id, f2.id);
      });
    });
  });

  suite('getResourceEngagement()', () => {
    test('should return combined engagement data', async () => {
      // Add rating
      await backend.submitRating(FileBackend.createRating('bundle', 'test-bundle', 4));

      // Add feedback
      await backend.submitFeedback(
        FileBackend.createFeedback('bundle', 'test-bundle', 'Great!')
      );

      const engagement = await backend.getResourceEngagement('bundle', 'test-bundle');

      assert.strictEqual(engagement.resourceId, 'test-bundle');
      assert.strictEqual(engagement.resourceType, 'bundle');
      assert.ok(engagement.ratings);
      assert.strictEqual(engagement.ratings.averageRating, 4);
      assert.ok(engagement.recentFeedback);
      assert.strictEqual(engagement.recentFeedback.length, 1);
    });

    test('should handle resource with no engagement data', async () => {
      const engagement = await backend.getResourceEngagement('bundle', 'empty-bundle');

      assert.strictEqual(engagement.resourceId, 'empty-bundle');
      assert.strictEqual(engagement.ratings, undefined);
      assert.strictEqual(engagement.recentFeedback, undefined);
    });
  });

  suite('Static Factory Methods', () => {
    suite('createRating()', () => {
      test('should create rating with auto-generated ID and timestamp', () => {
        const rating = FileBackend.createRating('bundle', 'test-bundle', 5);

        assert.ok(rating.id);
        assert.ok(rating.timestamp);
        assert.strictEqual(rating.resourceType, 'bundle');
        assert.strictEqual(rating.resourceId, 'test-bundle');
        assert.strictEqual(rating.score, 5);
      });
    });

    suite('createFeedback()', () => {
      test('should create feedback with auto-generated ID and timestamp', () => {
        const feedback = FileBackend.createFeedback(
          'bundle',
          'test-bundle',
          'Great bundle!'
        );

        assert.ok(feedback.id);
        assert.ok(feedback.timestamp);
        assert.strictEqual(feedback.resourceType, 'bundle');
        assert.strictEqual(feedback.resourceId, 'test-bundle');
        assert.strictEqual(feedback.comment, 'Great bundle!');
      });

      test('should include optional version and rating', () => {
        const feedback = FileBackend.createFeedback(
          'bundle',
          'test-bundle',
          'Great!',
          '1.0.0',
          5
        );

        assert.strictEqual(feedback.version, '1.0.0');
        assert.strictEqual(feedback.rating, 5);
      });
    });
  });
});
