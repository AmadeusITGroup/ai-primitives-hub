/**
 * Tests for app/registry/version-consolidator.ts.
 *
 * Ported behavior coverage from the extension's
 * `test/services/version-consolidator.test.ts`/`.property.test.ts`,
 * translated into Vitest since `VersionConsolidator` now depends only on
 * `@ai-primitives-hub/core`'s pure version/identity functions, not the
 * extension's `Logger`.
 */
import type {
  Bundle,
} from '@ai-primitives-hub/core';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  VersionConsolidator,
} from '../../src/registry';
import type {
  LogEvent,
} from '../../src/update';

function makeBundle(id: string, sourceId: string, version: string, overrides: Partial<Bundle> = {}): Bundle {
  return {
    id,
    name: id,
    version,
    description: 'Test bundle',
    author: 'test',
    sourceId,
    environments: [],
    tags: [],
    lastUpdated: '2024-01-01T00:00:00.000Z',
    size: '1KB',
    dependencies: [],
    license: 'MIT',
    manifestUrl: `https://example.com/${id}/${version}/manifest.yml`,
    downloadUrl: `https://example.com/${id}/${version}/bundle.zip`,
    ...overrides
  };
}

function githubBundle(owner: string, repo: string, version: string): Bundle {
  return makeBundle(`${owner}-${repo}-v${version}`, 'github-source', version, { name: `${owner}/${repo}` });
}

describe('VersionConsolidator', () => {
  let consolidator: VersionConsolidator;

  beforeEach(() => {
    consolidator = new VersionConsolidator();
  });

  describe('consolidateBundles', () => {
    it('consolidates multiple versions into a single entry with the latest selected', () => {
      const bundles = [
        githubBundle('microsoft', 'vscode', '1.0.0'),
        githubBundle('microsoft', 'vscode', '2.0.0'),
        githubBundle('microsoft', 'vscode', '1.5.0')
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      expect(consolidated).toHaveLength(1);
      expect(consolidated[0].version).toBe('2.0.0');
      expect(consolidated[0].isConsolidated).toBe(true);
      expect(consolidated[0].availableVersions).toHaveLength(3);
    });

    it('does not consolidate a single-version bundle', () => {
      const consolidated = consolidator.consolidateBundles([githubBundle('owner', 'repo', '1.0.0')]);

      expect(consolidated).toHaveLength(1);
      expect(consolidated[0].isConsolidated).toBe(false);
      expect(consolidated[0].availableVersions).toHaveLength(1);
    });

    it('consolidates GitHub bundles but leaves other source types unchanged', () => {
      const bundles = [
        githubBundle('owner', 'repo', '1.0.0'),
        githubBundle('owner', 'repo', '2.0.0'),
        makeBundle('local-bundle', 'local-source', '1.0.0'),
        makeBundle('awesome-bundle', 'awesome-copilot-source', '1.0.0')
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      expect(consolidated).toHaveLength(3);
      const githubEntry = consolidated.find((b) => b.sourceId === 'github-source');
      expect(githubEntry?.isConsolidated).toBe(true);
      expect(githubEntry?.version).toBe('2.0.0');
    });

    it('handles an empty bundle array', () => {
      expect(consolidator.consolidateBundles([])).toEqual([]);
    });

    it('consolidates each GitHub repo separately', () => {
      const bundles = [
        githubBundle('owner1', 'repo1', '1.0.0'),
        githubBundle('owner1', 'repo1', '2.0.0'),
        githubBundle('owner2', 'repo2', '1.0.0'),
        githubBundle('owner2', 'repo2', '3.0.0')
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      expect(consolidated).toHaveLength(2);
      expect(consolidated.find((b) => b.name === 'owner1/repo1')?.version).toBe('2.0.0');
      expect(consolidated.find((b) => b.name === 'owner2/repo2')?.version).toBe('3.0.0');
    });

    it('sorts versions semantically, not lexicographically', () => {
      const bundles = [
        githubBundle('owner', 'repo', '1.0.0'),
        githubBundle('owner', 'repo', '10.0.0'),
        githubBundle('owner', 'repo', '2.0.0'),
        githubBundle('owner', 'repo', '1.10.0')
      ];

      const consolidated = consolidator.consolidateBundles(bundles);

      expect(consolidated[0].version).toBe('10.0.0');
      expect(consolidated[0].availableVersions.map((v) => v.version)).toEqual(['10.0.0', '2.0.0', '1.10.0', '1.0.0']);
    });

    it('emits a debug log summarizing the consolidation via onLog', () => {
      const events: LogEvent[] = [];
      const withLogging = new VersionConsolidator(1000, (event) => events.push(event));

      withLogging.consolidateBundles([githubBundle('owner', 'repo', '1.0.0')]);

      expect(events.some((e) => e.level === 'debug' && e.message.includes('Consolidating'))).toBe(true);
    });

    it('falls back to comparing lastUpdated when version comparison throws, emitting a warn log', () => {
      const events: LogEvent[] = [];
      const withLogging = new VersionConsolidator(1000, (event) => events.push(event));

      // Same identity (id, sourceId) so both bundles group together; one has an
      // empty version, which makes compareVersions() throw and forces the
      // date-comparison fallback path.
      const bundles: Bundle[] = [
        makeBundle('owner-repo', 'github-source', '1.0.0', { lastUpdated: '2024-01-01T00:00:00.000Z' }),
        makeBundle('owner-repo', 'github-source', '', { lastUpdated: '2024-02-01T00:00:00.000Z' })
      ];

      const consolidated = withLogging.consolidateBundles(bundles);

      expect(consolidated).toHaveLength(1);
      expect(events.some((e) => e.level === 'warn' && e.message.includes('Version comparison failed'))).toBe(true);
    });
  });

  describe('getAllVersions / getBundleVersion', () => {
    it('returns cached versions for a consolidated identity', () => {
      consolidator.consolidateBundles([
        githubBundle('owner', 'repo', '1.0.0'),
        githubBundle('owner', 'repo', '2.0.0')
      ]);

      const versions = consolidator.getAllVersions('owner-repo');

      expect(versions).toHaveLength(2);
      expect(versions.map((v) => v.version).toSorted()).toEqual(['1.0.0', '2.0.0']);
    });

    it('returns an empty array for an unknown identity', () => {
      expect(consolidator.getAllVersions('non-existent')).toEqual([]);
    });

    it('returns a specific version when it exists', () => {
      consolidator.consolidateBundles([
        githubBundle('owner', 'repo', '1.0.0'),
        githubBundle('owner', 'repo', '1.5.0')
      ]);

      const version = consolidator.getBundleVersion('owner-repo', '1.5.0');

      expect(version?.version).toBe('1.5.0');
      expect(version?.downloadUrl).toContain('1.5.0');
    });

    it('returns undefined for a version that does not exist', () => {
      consolidator.consolidateBundles([githubBundle('owner', 'repo', '1.0.0')]);

      expect(consolidator.getBundleVersion('owner-repo', '9.9.9')).toBeUndefined();
    });
  });

  describe('setSourceTypeResolver', () => {
    it('overrides the heuristic source-type inference', () => {
      consolidator.setSourceTypeResolver(() => 'local');

      const consolidated = consolidator.consolidateBundles([
        githubBundle('owner', 'repo', '1.0.0'),
        githubBundle('owner', 'repo', '2.0.0')
      ]);

      // Forced to 'local' identity rules -> exact-id match only, so these two
      // distinct bundle IDs (which include the version) don't consolidate.
      expect(consolidated).toHaveLength(2);
    });
  });

  describe('LRU cache', () => {
    it('evicts the least recently used entry once maxCacheSize is exceeded', () => {
      const small = new VersionConsolidator(2);

      small.consolidateBundles([githubBundle('owner1', 'repo1', '1.0.0')]);
      small.consolidateBundles([githubBundle('owner2', 'repo2', '1.0.0')]);
      // Touch owner1 so owner2 becomes the least recently used.
      small.getAllVersions('owner1-repo1');
      small.consolidateBundles([githubBundle('owner3', 'repo3', '1.0.0')]);

      expect(small.getAllVersions('owner2-repo2')).toEqual([]);
      expect(small.getAllVersions('owner1-repo1')).toHaveLength(1);
      expect(small.getAllVersions('owner3-repo3')).toHaveLength(1);
    });

    it('does not evict when updating an existing entry', () => {
      const small = new VersionConsolidator(2);

      small.consolidateBundles([githubBundle('owner1', 'repo1', '1.0.0')]);
      small.consolidateBundles([githubBundle('owner2', 'repo2', '1.0.0')]);
      small.consolidateBundles([
        githubBundle('owner1', 'repo1', '1.0.0'),
        githubBundle('owner1', 'repo1', '2.0.0')
      ]);

      expect(small.getAllVersions('owner1-repo1')).toHaveLength(2);
      expect(small.getAllVersions('owner2-repo2')).toHaveLength(1);
    });

    it('rejects a non-positive maxCacheSize', () => {
      expect(() => new VersionConsolidator(0)).toThrow(/positive number/);
      expect(() => new VersionConsolidator(-1)).toThrow(/positive number/);
      expect(() => new VersionConsolidator(Number.NaN)).toThrow(/positive number/);
    });
  });
});
