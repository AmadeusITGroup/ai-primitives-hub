/**
 * Bundle ID module tests
 */
import * as assert from 'node:assert';
import {
  generateBundleId,
} from '@prompt-registry/cli';

describe('Bundle ID Module', () => {
  describe('generateBundleId()', () => {
    it('should generate bundle ID with slash-separated repo slug', () => {
      const result = generateBundleId('owner/repo', 'my-collection', '1.0.0');
      assert.strictEqual(result, 'owner-repo-my-collection-v1.0.0');
    });

    it('should generate bundle ID with hyphen-separated repo slug', () => {
      const result = generateBundleId('owner-repo', 'my-collection', '1.0.0');
      assert.strictEqual(result, 'owner-repo-my-collection-v1.0.0');
    });

    it('should handle different versions', () => {
      assert.strictEqual(
        generateBundleId('owner/repo', 'collection', '2.0.0'),
        'owner-repo-collection-v2.0.0'
      );
      assert.strictEqual(
        generateBundleId('owner/repo', 'collection', '0.1.0'),
        'owner-repo-collection-v0.1.0'
      );
    });

    it('should handle complex collection IDs', () => {
      const result = generateBundleId('org/my-repo', 'my-awesome-collection', '1.2.3');
      assert.strictEqual(result, 'org-my-repo-my-awesome-collection-v1.2.3');
    });
  });
});
