/**
 * Tests for marketplace filtering and relevance ranking utilities.
 */

import * as assert from 'node:assert';
import {
  Bundle,
} from '../../src/types/registry';
import {
  filterBundlesBySearch,
  filterBundlesBySource,
  filterBundlesByTags,
} from '../../src/utils/filter-utils';
import {
  createMockBundleDetails,
} from '../helpers/bundle-test-helpers';

suite('filterUtils', () => {
  suite('filterBundlesBySearch relevance ranking', () => {
    test('ranks a partial structured-field match above a description-only mention', () => {
      // Regression: searching "renovate" used to rank a bundle that only
      // mentioned the word in its description ABOVE a bundle whose id/tags
      // matched partially, because partial structured matches fell to the
      // floor score. Structured (id/tag/env) matches must now win.
      const structuredMatch = createMockBundleDetails('renovate-config', {
        name: 'Dependency Updater',
        description: 'Keeps project dependencies fresh.',
        tags: ['renovate', 'dependencies']
      });
      const descriptionOnly = createMockBundleDetails('some-other-bundle', {
        name: 'Generic Helper',
        description: 'A helper that also works alongside renovate pipelines.',
        tags: ['ci']
      });

      const bundles: Bundle[] = [descriptionOnly, structuredMatch];
      const ranked = filterBundlesBySearch(bundles, 'renovate');

      assert.strictEqual(ranked.length, 2, 'both bundles match "renovate"');
      assert.strictEqual(
        ranked[0].id,
        'renovate-config',
        'the id/tag match must rank first'
      );
      assert.strictEqual(ranked[1].id, 'some-other-bundle');
    });

    test('ranks an exact name match above a substring name match', () => {
      const exactName = createMockBundleDetails('a-exact', {
        name: 'security',
        description: 'unrelated',
        tags: []
      });
      const substringName = createMockBundleDetails('b-substr', {
        name: 'security-scanner',
        description: 'unrelated',
        tags: []
      });

      const ranked = filterBundlesBySearch([substringName, exactName], 'security');

      assert.strictEqual(ranked[0].id, 'a-exact');
      assert.strictEqual(ranked[1].id, 'b-substr');
    });

    test('honours field-scoped terms and exclusions', () => {
      const tagged = createMockBundleDetails('tagged', {
        name: 'Alpha',
        tags: ['security']
      });
      const untagged = createMockBundleDetails('untagged', {
        name: 'Beta security',
        tags: ['ci']
      });

      const scoped = filterBundlesBySearch([tagged, untagged], 'tag:security');
      assert.deepStrictEqual(scoped.map((b) => b.id), ['tagged']);

      const excluded = filterBundlesBySearch(
        [tagged, untagged],
        'security -tag:security'
      );
      assert.deepStrictEqual(excluded.map((b) => b.id), ['untagged']);
    });

    test('returns all bundles for empty search text', () => {
      const bundles = [
        createMockBundleDetails('one'),
        createMockBundleDetails('two')
      ];
      assert.strictEqual(filterBundlesBySearch(bundles, '').length, 2);
      assert.strictEqual(filterBundlesBySearch(bundles, '   ').length, 2);
    });
  });

  suite('filterBundlesBySource', () => {
    test('filters by source id and passes through "all"', () => {
      const a = createMockBundleDetails('a', { sourceId: 'src-a' });
      const b = createMockBundleDetails('b', { sourceId: 'src-b' });

      assert.deepStrictEqual(
        filterBundlesBySource([a, b], 'src-a').map((x) => x.id),
        ['a']
      );
      assert.strictEqual(filterBundlesBySource([a, b], 'all').length, 2);
    });
  });

  suite('filterBundlesByTags', () => {
    test('supports any and all match modes', () => {
      const a = createMockBundleDetails('a', { tags: ['x', 'y'] });
      const b = createMockBundleDetails('b', { tags: ['x'] });

      assert.strictEqual(filterBundlesByTags([a, b], ['x'], 'any').length, 2);
      assert.deepStrictEqual(
        filterBundlesByTags([a, b], ['x', 'y'], 'all').map((x) => x.id),
        ['a']
      );
    });
  });
});
