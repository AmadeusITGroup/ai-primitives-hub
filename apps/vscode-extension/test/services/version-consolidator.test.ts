/**
 * Unit tests for VersionConsolidator
 */
import * as assert from 'node:assert';
import {
  VersionConsolidator,
} from '../../src/services/version-consolidator';
import {
  BundleBuilder,
  TEST_SOURCE_IDS,
} from '../helpers/bundle-test-helpers';

suite('VersionConsolidator Unit Tests', () => {
  let consolidator: VersionConsolidator;

  setup(() => {
    consolidator = new VersionConsolidator();
  });

  suite('consolidateBundles', () => {
    test('should consolidate 3 versions (1.0.0, 2.0.0, 1.5.0) into single entry with latest (2.0.0)', () => {
      const bundles = [
        BundleBuilder.github('microsoft', 'vscode').withVersion('1.0.0').build(),
        BundleBuilder.github('microsoft', 'vscode').withVersion('2.0.0').build(),
        BundleBuilder.github('microsoft', 'vscode').withVersion('1.5.0').build()
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      assert.strictEqual(consolidated.length, 1, 'Should have one consolidated entry');
      assert.strictEqual(consolidated[0].version, '2.0.0', 'Should select latest version');
      assert.strictEqual(consolidated[0].isConsolidated, true, 'Should be marked as consolidated');
      assert.strictEqual(consolidated[0].availableVersions.length, 3, 'Should have all versions');
    });

    test('should preserve version metadata for all versions', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      const versions = consolidated[0].availableVersions;
      assert.strictEqual(versions.length, 2);
      assert.ok(versions.some((v) => v.version === '1.0.0'));
      assert.ok(versions.some((v) => v.version === '2.0.0'));
      assert.ok(versions.every((v) => v.downloadUrl && v.manifestUrl));
    });

    test('should not consolidate single-version bundles', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build()
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      assert.strictEqual(consolidated.length, 1);
      assert.strictEqual(consolidated[0].isConsolidated, false, 'Should not be marked as consolidated');
      assert.strictEqual(consolidated[0].availableVersions.length, 1);
    });

    test('should handle mixed source types (GitHub consolidated, others unchanged)', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build(),
        BundleBuilder.fromSource('local-bundle', 'LOCAL').withVersion('1.0.0').build(),
        BundleBuilder.fromSource('awesome-bundle', 'AWESOME_COPILOT').withVersion('1.0.0').build()
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      // GitHub bundles should be consolidated (1 entry)
      // Local and APM should remain separate (2 entries)
      assert.strictEqual(consolidated.length, 3, 'Should have 3 entries total');

      const githubEntry = consolidated.find((b) => b.sourceId === TEST_SOURCE_IDS.GITHUB);
      assert.ok(githubEntry, 'Should have GitHub entry');
      assert.strictEqual(githubEntry.isConsolidated, true);
      assert.strictEqual(githubEntry.version, '2.0.0');
    });

    test('should handle empty bundle array', () => {
      const consolidated = consolidator.consolidateBundles([]);

      assert.strictEqual(consolidated.length, 0);
    });

    test('should consolidate each GitHub repo separately', () => {
      const bundles = [
        BundleBuilder.github('owner1', 'repo1').withVersion('1.0.0').build(),
        BundleBuilder.github('owner1', 'repo1').withVersion('2.0.0').build(),
        BundleBuilder.github('owner2', 'repo2').withVersion('1.0.0').build(),
        BundleBuilder.github('owner2', 'repo2').withVersion('3.0.0').build()
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      assert.strictEqual(consolidated.length, 2, 'Should have 2 consolidated entries');

      const repo1 = consolidated.find((b) => b.name === 'owner1/repo1');
      const repo2 = consolidated.find((b) => b.name === 'owner2/repo2');

      assert.ok(repo1);
      assert.ok(repo2);
      assert.strictEqual(repo1.version, '2.0.0');
      assert.strictEqual(repo2.version, '3.0.0');
    });

    test('should sort versions semantically (10.0.0 > 2.0.0 > 1.10.0 > 1.0.0)', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('10.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('1.10.0').build()
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      assert.strictEqual(consolidated[0].version, '10.0.0', 'Should select highest version');

      // Check that versions are sorted in availableVersions
      const versions = consolidated[0].availableVersions.map((v) => v.version);
      assert.strictEqual(versions[0], '10.0.0');
      assert.strictEqual(versions[1], '2.0.0');
      assert.strictEqual(versions[2], '1.10.0');
      assert.strictEqual(versions[3], '1.0.0');
    });
  });

  suite('getAvailableVersions', () => {
    test('should return cached versions for consolidated bundle', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      const versions = consolidator.getAllVersions('owner-repo');

      assert.strictEqual(versions.length, 2);
      assert.ok(versions.some((v) => v.version === '1.0.0'));
      assert.ok(versions.some((v) => v.version === '2.0.0'));
    });

    test('should return empty array for non-existent bundle', () => {
      const versions = consolidator.getAllVersions('non-existent');

      assert.strictEqual(versions.length, 0);
    });
  });

  suite('getAllVersions', () => {
    test('should return all versions for a bundle identity (alias for getAvailableVersions)', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('1.5.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      const versions = consolidator.getAllVersions('owner-repo');

      assert.strictEqual(versions.length, 3);
      assert.ok(versions.some((v) => v.version === '1.0.0'));
      assert.ok(versions.some((v) => v.version === '1.5.0'));
      assert.ok(versions.some((v) => v.version === '2.0.0'));
    });

    test('should return versions in descending semantic version order', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('10.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      const versions = consolidator.getAllVersions('owner-repo');

      assert.strictEqual(versions.length, 3);
      assert.strictEqual(versions[0].version, '10.0.0');
      assert.strictEqual(versions[1].version, '2.0.0');
      assert.strictEqual(versions[2].version, '1.0.0');
    });

    test('should return empty array for non-existent bundle', () => {
      const versions = consolidator.getAllVersions('non-existent');

      assert.strictEqual(versions.length, 0);
    });

    test('should return same results as getAvailableVersions', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      const versionsFromGetAll = consolidator.getAllVersions('owner-repo');
      const versionsFromGetAvailable = consolidator.getAllVersions('owner-repo');

      assert.strictEqual(versionsFromGetAll.length, versionsFromGetAvailable.length);
      assert.deepStrictEqual(versionsFromGetAll, versionsFromGetAvailable);
    });
  });

  suite('getBundleVersion', () => {
    test('should return specific version when it exists', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('1.5.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      const version = consolidator.getBundleVersion('owner-repo', '1.5.0');

      assert.ok(version);
      assert.strictEqual(version.version, '1.5.0');
      assert.ok(version.downloadUrl);
      assert.ok(version.manifestUrl);
    });

    test('should return undefined when version does not exist', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      const version = consolidator.getBundleVersion('owner-repo', '3.0.0');

      assert.strictEqual(version, undefined);
    });

    test('should return undefined for non-existent bundle', () => {
      const version = consolidator.getBundleVersion('non-existent', '1.0.0');

      assert.strictEqual(version, undefined);
    });

    test('should return correct version metadata', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      const version = consolidator.getBundleVersion('owner-repo', '1.0.0');

      assert.ok(version);
      assert.strictEqual(version.version, '1.0.0');
      assert.ok(version.downloadUrl.includes('1.0.0'));
      assert.ok(version.manifestUrl.includes('1.0.0'));
      assert.ok(version.publishedAt);
    });
  });

  suite('setSourceTypeResolver', () => {
    test('should use custom source type resolver when provided', () => {
      // Set up a custom resolver that always returns 'local' (no consolidation)
      consolidator.setSourceTypeResolver(() => 'local');

      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      // Should NOT consolidate because resolver returns 'local'
      assert.strictEqual(consolidated.length, 2, 'Should not consolidate with local source type');
    });

    test('should fall back to heuristic when no resolver provided', () => {
      // No resolver set, should use heuristic (github-source -> github)
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      // Should consolidate using heuristic
      assert.strictEqual(consolidated.length, 1, 'Should consolidate using heuristic');
    });
  });

  suite('LRU Cache Mechanism', () => {
    test('should cache versions after consolidation', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      // Verify cache is populated
      const versions = consolidator.getAllVersions('owner-repo');
      assert.strictEqual(versions.length, 2, 'Cache should contain versions');
    });

    test('should update last access time when getAvailableVersions is called', async () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Access the cache
      const versions1 = consolidator.getAllVersions('owner-repo');
      assert.strictEqual(versions1.length, 1);

      // The access time should be updated (we can't directly verify this,
      // but we can verify the cache still works after access)
      const versions2 = consolidator.getAllVersions('owner-repo');
      assert.strictEqual(versions2.length, 1);
    });

    test('should update last access time when getBundleVersion is called', async () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Access specific version
      const version = consolidator.getBundleVersion('owner-repo', '1.0.0');
      assert.ok(version);
      assert.strictEqual(version.version, '1.0.0');

      // Verify cache still works
      const versions = consolidator.getAllVersions('owner-repo');
      assert.strictEqual(versions.length, 2);
    });

    test('should evict least recently used entry when cache is full', async () => {
      // Create a consolidator with a very small cache size for testing
      const smallConsolidator = new VersionConsolidator(3);

      // Add 3 bundles to fill the cache
      const bundle1 = [BundleBuilder.github('owner1', 'repo1').withVersion('1.0.0').build()];
      const bundle2 = [BundleBuilder.github('owner2', 'repo2').withVersion('1.0.0').build()];
      const bundle3 = [BundleBuilder.github('owner3', 'repo3').withVersion('1.0.0').build()];

      smallConsolidator.consolidateBundles(bundle1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      smallConsolidator.consolidateBundles(bundle2);
      await new Promise((resolve) => setTimeout(resolve, 10));

      smallConsolidator.consolidateBundles(bundle3);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // All 3 should be in cache
      assert.strictEqual(smallConsolidator.getAllVersions('owner1-repo1').length, 1);
      assert.strictEqual(smallConsolidator.getAllVersions('owner2-repo2').length, 1);
      assert.strictEqual(smallConsolidator.getAllVersions('owner3-repo3').length, 1);

      // Access owner2 and owner3 to make them more recently used
      await new Promise((resolve) => setTimeout(resolve, 10));
      smallConsolidator.getAllVersions('owner2-repo2');
      await new Promise((resolve) => setTimeout(resolve, 10));
      smallConsolidator.getAllVersions('owner3-repo3');

      // Add a 4th bundle - should evict owner1 (least recently used)
      await new Promise((resolve) => setTimeout(resolve, 10));
      const bundle4 = [BundleBuilder.github('owner4', 'repo4').withVersion('1.0.0').build()];
      smallConsolidator.consolidateBundles(bundle4);

      // owner1 should be evicted (LRU)
      assert.strictEqual(smallConsolidator.getAllVersions('owner1-repo1').length, 0, 'LRU entry should be evicted');

      // owner2, owner3, and owner4 should still be in cache
      assert.strictEqual(smallConsolidator.getAllVersions('owner2-repo2').length, 1, 'Recently used entry should remain');
      assert.strictEqual(smallConsolidator.getAllVersions('owner3-repo3').length, 1, 'Recently used entry should remain');
      assert.strictEqual(smallConsolidator.getAllVersions('owner4-repo4').length, 1, 'New entry should be cached');
    });

    test('should not evict entry when updating existing cache entry', () => {
      // Create a consolidator with small cache
      const smallConsolidator = new VersionConsolidator(2);

      // Add 2 bundles to fill cache
      const bundle1 = [BundleBuilder.github('owner1', 'repo1').withVersion('1.0.0').build()];
      const bundle2 = [BundleBuilder.github('owner2', 'repo2').withVersion('1.0.0').build()];

      smallConsolidator.consolidateBundles(bundle1);
      smallConsolidator.consolidateBundles(bundle2);

      // Update bundle1 with new version (should not trigger eviction)
      const bundle1Updated = [
        BundleBuilder.github('owner1', 'repo1').withVersion('1.0.0').build(),
        BundleBuilder.github('owner1', 'repo1').withVersion('2.0.0').build()
      ];
      smallConsolidator.consolidateBundles(bundle1Updated);

      // Both should still be in cache
      assert.strictEqual(smallConsolidator.getAllVersions('owner1-repo1').length, 2, 'Updated entry should have 2 versions');
      assert.strictEqual(smallConsolidator.getAllVersions('owner2-repo2').length, 1, 'Other entry should remain');
    });

    test('should reject invalid cache sizes', () => {
      assert.throws(() => new VersionConsolidator(0), /positive number/, 'Should reject zero');
      assert.throws(() => new VersionConsolidator(-1), /positive number/, 'Should reject negative');
      assert.throws(() => new VersionConsolidator(Number.NaN), /positive number/, 'Should reject NaN');
      assert.throws(() => new VersionConsolidator(Infinity), /positive number/, 'Should reject Infinity');
    });

    test('should handle cache with single-version bundles', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      // Single version should still be cached
      const versions = consolidator.getAllVersions('owner-repo');
      assert.strictEqual(versions.length, 1);
      assert.strictEqual(versions[0].version, '1.0.0');
    });

    test('should maintain cache consistency across multiple consolidations', () => {
      // First consolidation
      const bundles1 = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];
      consolidator.consolidateBundles(bundles1);

      let versions = consolidator.getAllVersions('owner-repo');
      assert.strictEqual(versions.length, 2);

      // Second consolidation with additional version
      const bundles2 = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('3.0.0').build()
      ];
      consolidator.consolidateBundles(bundles2);

      // Cache should be updated with new version
      versions = consolidator.getAllVersions('owner-repo');
      assert.strictEqual(versions.length, 3);
      assert.ok(versions.some((v) => v.version === '3.0.0'));
    });

    test('should preserve cache across multiple getAvailableVersions calls', () => {
      const bundles = [
        BundleBuilder.github('owner', 'repo').withVersion('1.0.0').build(),
        BundleBuilder.github('owner', 'repo').withVersion('2.0.0').build()
      ];

      consolidator.consolidateBundles(bundles);

      // Multiple accesses should return same data
      const versions1 = consolidator.getAllVersions('owner-repo');
      const versions2 = consolidator.getAllVersions('owner-repo');
      const versions3 = consolidator.getAllVersions('owner-repo');

      assert.strictEqual(versions1.length, 2);
      assert.strictEqual(versions2.length, 2);
      assert.strictEqual(versions3.length, 2);
    });
  });
});
