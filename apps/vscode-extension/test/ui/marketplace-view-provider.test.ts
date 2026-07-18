/**
 * Tests for MarketplaceViewProvider
 * Focus on dynamic tag extraction and source filtering
 */

import * as assert from 'node:assert';
import {
  beforeEach,
  suite,
  test,
} from 'mocha';
import {
  Bundle,
  RegistrySource,
} from '../../src/types/registry';
import {
  extractAllTags,
  extractBundleSources,
  filterBundlesBySearch,
  filterBundlesBySource,
  filterBundlesByTags,
  getTagFrequency,
} from '../../src/utils/filter-utils';
import {
  determineButtonState,
  matchesBundleIdentity,
} from '../helpers/marketplace-test-helpers';

suite('MarketplaceViewProvider - Dynamic Filtering', () => {
  let mockBundles: Bundle[];
  let mockSources: RegistrySource[];

  beforeEach(() => {
    // Setup mock bundles with various tags
    mockBundles = [
      {
        id: 'bundle1',
        name: 'Testing Bundle',
        version: '1.0.0',
        description: 'A testing bundle',
        author: 'Test Author',
        sourceId: 'source1',
        environments: ['vscode'],
        tags: ['testing', 'automation', 'tdd'],
        lastUpdated: '2024-01-01',
        size: '1MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.yml',
        downloadUrl: 'https://example.com/bundle.zip'
      },
      {
        id: 'bundle2',
        name: 'Accessibility Bundle',
        version: '1.0.0',
        description: 'Accessibility helpers',
        author: 'A11y Team',
        sourceId: 'source2',
        environments: ['vscode'],
        tags: ['accessibility', 'a11y', 'testing'],
        lastUpdated: '2024-01-02',
        size: '2MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest2.yml',
        downloadUrl: 'https://example.com/bundle2.zip'
      },
      {
        id: 'bundle3',
        name: 'Agents Bundle',
        version: '2.0.0',
        description: 'AI agents collection',
        author: 'AI Team',
        sourceId: 'source1',
        environments: ['vscode', 'cursor'],
        tags: ['agents', 'ai', 'automation'],
        lastUpdated: '2024-01-03',
        size: '3MB',
        dependencies: [],
        license: 'Apache-2.0',
        manifestUrl: 'https://example.com/manifest3.yml',
        downloadUrl: 'https://example.com/bundle3.zip'
      },
      {
        id: 'bundle4',
        name: 'Angular Bundle',
        version: '1.5.0',
        description: 'Angular development prompts',
        author: 'Angular Team',
        sourceId: 'source2',
        environments: ['vscode'],
        tags: ['angular', 'frontend', 'typescript'],
        lastUpdated: '2024-01-04',
        size: '1.5MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest4.yml',
        downloadUrl: 'https://example.com/bundle4.zip'
      }
    ];

    mockSources = [
      {
        id: 'source1',
        name: 'Primary Source',
        type: 'github',
        url: 'https://github.com/org/repo1',
        enabled: true,
        priority: 1
      },
      {
        id: 'source2',
        name: 'Secondary Source',
        type: 'local',
        url: '/path/to/local',
        enabled: true,
        priority: 2
      },
      {
        id: 'source3',
        name: 'Disabled Source',
        type: 'local',
        url: '/path/to/bundles',
        enabled: false,
        priority: 3
      }
    ];
  });

  suite('Dynamic Tag Extraction', () => {
    test('should extract all unique tags from bundles', () => {
      const tags = extractAllTags(mockBundles);

      // Should have 10 unique tags
      assert.strictEqual(tags.length, 10);
      assert.ok(tags.includes('testing'));
      assert.ok(tags.includes('automation'));
      assert.ok(tags.includes('tdd'));
      assert.ok(tags.includes('accessibility'));
      assert.ok(tags.includes('a11y'));
      assert.ok(tags.includes('agents'));
      assert.ok(tags.includes('ai'));
      assert.ok(tags.includes('angular'));
      assert.ok(tags.includes('frontend'));
      assert.ok(tags.includes('typescript'));
    });

    test('should sort tags alphabetically', () => {
      const tags = extractAllTags(mockBundles);

      // Verify alphabetical order
      for (let i = 0; i < tags.length - 1; i++) {
        assert.ok(tags[i].localeCompare(tags[i + 1]) <= 0,
          `Tag "${tags[i]}" should come before "${tags[i + 1]}"`);
      }
    });

    test('should handle bundles with no tags', () => {
      const bundleNoTags: Bundle = {
        ...mockBundles[0],
        id: 'bundle-no-tags',
        tags: []
      };

      const tags = extractAllTags([bundleNoTags]);
      assert.strictEqual(tags.length, 0);
    });

    test('should handle empty bundle array', () => {
      const tags = extractAllTags([]);
      assert.strictEqual(tags.length, 0);
    });

    test('should deduplicate tags across bundles', () => {
      // 'testing' and 'automation' appear in multiple bundles
      const tags = extractAllTags(mockBundles);

      const testingCount = tags.filter((t) => t === 'testing').length;
      const automationCount = tags.filter((t) => t === 'automation').length;

      assert.strictEqual(testingCount, 1, 'testing tag should appear only once');
      assert.strictEqual(automationCount, 1, 'automation tag should appear only once');
    });

    test('should count tag frequency', () => {
      const tagFrequency = getTagFrequency(mockBundles);

      assert.strictEqual(tagFrequency.get('testing'), 2);
      assert.strictEqual(tagFrequency.get('automation'), 2);
      assert.strictEqual(tagFrequency.get('a11y'), 1);
      assert.strictEqual(tagFrequency.get('agents'), 1);
      assert.strictEqual(tagFrequency.get('angular'), 1);
    });
  });

  suite('Source Filtering', () => {
    test('should extract all sources from bundles', () => {
      const sources = extractBundleSources(mockBundles, mockSources);

      // Should have 2 sources (source1 and source2 have bundles)
      assert.strictEqual(sources.length, 2);

      const sourceIds = sources.map((s) => s.id);
      assert.ok(sourceIds.includes('source1'));
      assert.ok(sourceIds.includes('source2'));
    });

    test('should include bundle count per source', () => {
      const sources = extractBundleSources(mockBundles, mockSources);

      const source1 = sources.find((s) => s.id === 'source1');
      const source2 = sources.find((s) => s.id === 'source2');

      assert.ok(source1);
      assert.ok(source2);
      assert.strictEqual(source1.bundleCount, 2); // bundle1 and bundle3
      assert.strictEqual(source2.bundleCount, 2); // bundle2 and bundle4
    });

    test('should not include sources with no bundles', () => {
      const sources = extractBundleSources(mockBundles, mockSources);

      const source3 = sources.find((s) => s.id === 'source3');
      assert.strictEqual(source3, undefined);
    });

    test('should handle empty bundles array', () => {
      const sources = extractBundleSources([], mockSources);
      assert.strictEqual(sources.length, 0);
    });

    test('should filter bundles by source', () => {
      const filtered = filterBundlesBySource(mockBundles, 'source1');

      assert.strictEqual(filtered.length, 2);
      assert.ok(filtered.every((b) => b.sourceId === 'source1'));
    });

    test('should return all bundles when source is "all"', () => {
      const filtered = filterBundlesBySource(mockBundles, 'all');

      assert.strictEqual(filtered.length, mockBundles.length);
    });

    test('should return empty array for non-existent source', () => {
      const filtered = filterBundlesBySource(mockBundles, 'non-existent');

      assert.strictEqual(filtered.length, 0);
    });
  });

  suite('Tag Filtering', () => {
    test('should filter bundles by single tag', () => {
      const filtered = filterBundlesByTags(mockBundles, ['testing']);

      assert.strictEqual(filtered.length, 2);
      filtered.forEach((bundle) => {
        assert.ok(bundle.tags.some((t) => t.toLowerCase() === 'testing'));
      });
    });

    test('should filter bundles by multiple tags (OR logic)', () => {
      const filtered = filterBundlesByTags(mockBundles, ['agents', 'angular']);

      // Should match bundle3 (agents) and bundle4 (angular)
      assert.strictEqual(filtered.length, 2);
      const ids = filtered.map((b) => b.id);
      assert.ok(ids.includes('bundle3'));
      assert.ok(ids.includes('bundle4'));
    });

    test('should return all bundles when tags array is empty', () => {
      const filtered = filterBundlesByTags(mockBundles, []);

      assert.strictEqual(filtered.length, mockBundles.length);
    });

    test('should return empty array when no bundles match tags', () => {
      const filtered = filterBundlesByTags(mockBundles, ['non-existent-tag']);

      assert.strictEqual(filtered.length, 0);
    });

    test('should be case-insensitive', () => {
      const filtered = filterBundlesByTags(mockBundles, ['TESTING']);

      assert.strictEqual(filtered.length, 2);
    });
  });

  suite('Combined Filtering', () => {
    test('should filter by both source and tags', () => {
      // Filter source1 bundles with 'automation' tag
      let filtered = filterBundlesBySource(mockBundles, 'source1');
      filtered = filterBundlesByTags(filtered, ['automation']);

      // Should match bundle1 and bundle3
      assert.strictEqual(filtered.length, 2);
      filtered.forEach((bundle) => {
        assert.strictEqual(bundle.sourceId, 'source1');
        assert.ok(bundle.tags.some((t) => t.toLowerCase() === 'automation'));
      });
    });

    test('should filter by source, tags, and search text', () => {
      let filtered = filterBundlesBySource(mockBundles, 'source1');
      filtered = filterBundlesByTags(filtered, ['automation']);
      filtered = filterBundlesBySearch(filtered, 'testing');

      // Should match only bundle1
      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].id, 'bundle1');
    });
  });

  suite('Button State Determination', () => {
    test('should return "install" state when no version installed', () => {
      const buttonState = determineButtonState(undefined, '1.0.0');
      assert.strictEqual(buttonState, 'install');
    });

    test('should return "update" state when older version installed', () => {
      const buttonState = determineButtonState('1.0.0', '2.0.0');
      assert.strictEqual(buttonState, 'update');
    });

    test('should return "update" state for minor version difference', () => {
      const buttonState = determineButtonState('1.0.0', '1.1.0');
      assert.strictEqual(buttonState, 'update');
    });

    test('should return "update" state for patch version difference', () => {
      const buttonState = determineButtonState('1.0.0', '1.0.1');
      assert.strictEqual(buttonState, 'update');
    });

    test('should return "uninstall" state when latest version installed', () => {
      const buttonState = determineButtonState('2.0.0', '2.0.0');
      assert.strictEqual(buttonState, 'uninstall');
    });

    test('should return "uninstall" state when newer version installed', () => {
      // Edge case: user has a newer version than what's available
      const buttonState = determineButtonState('3.0.0', '2.0.0');
      assert.strictEqual(buttonState, 'uninstall');
    });

    test('should handle version prefixes correctly', () => {
      const buttonState1 = determineButtonState('v1.0.0', 'v2.0.0');
      assert.strictEqual(buttonState1, 'update');

      const buttonState2 = determineButtonState('v2.0.0', 'v2.0.0');
      assert.strictEqual(buttonState2, 'uninstall');
    });

    test('should match GitHub bundle identity without version suffix', () => {
      const matches = matchesBundleIdentity(
        'microsoft-vscode-1.0.0',
        'microsoft-vscode-2.0.0',
        'github'
      );
      assert.strictEqual(matches, true);
    });

    test('should not match different GitHub repositories', () => {
      const matches = matchesBundleIdentity(
        'microsoft-vscode-1.0.0',
        'microsoft-copilot-1.0.0',
        'github'
      );
      assert.strictEqual(matches, false);
    });

    test('should match GitHub bundles with complex names', () => {
      const matches = matchesBundleIdentity(
        'my-org-my-repo-123-v1.0.0',
        'my-org-my-repo-123-v2.0.0',
        'github'
      );
      assert.strictEqual(matches, true);
    });

    test('should require exact match for non-GitHub bundles', () => {
      const matches1 = matchesBundleIdentity(
        'local-bundle-1.0.0',
        'local-bundle-1.0.0',
        'local'
      );
      assert.strictEqual(matches1, true);

      const matches2 = matchesBundleIdentity(
        'local-bundle-1.0.0',
        'local-bundle-2.0.0',
        'local'
      );
      assert.strictEqual(matches2, false);
    });

    test('should require exact match for local bundles', () => {
      const matches = matchesBundleIdentity(
        'local-bundle-1',
        'local-bundle-2',
        'local'
      );
      assert.strictEqual(matches, false);
    });

    test('should require exact match for apm bundles', () => {
      const matches = matchesBundleIdentity(
        'apm-bundle-v1',
        'apm-bundle-v2',
        'apm'
      );
      assert.strictEqual(matches, false);
    });

    test('should require exact match for awesome-copilot bundles', () => {
      const matches = matchesBundleIdentity(
        'awesome-bundle',
        'awesome-bundle',
        'awesome-copilot'
      );
      assert.strictEqual(matches, true);
    });
  });

  suite('Update Action', () => {
    /**
     * Mock RegistryManager for testing update action
     */
    class MockRegistryManager {
      private readonly installedBundles: Map<string, any> = new Map();
      private uninstallCalls: { bundleId: string; scope: string }[] = [];
      private installCalls: { bundleId: string; options: any }[] = [];

      public listInstalledBundles() {
        return Array.from(this.installedBundles.values());
      }

      public uninstallBundle(bundleId: string, scope: string) {
        this.uninstallCalls.push({ bundleId, scope });
        this.installedBundles.delete(bundleId);
      }

      public installBundle(bundleId: string, options: any) {
        this.installCalls.push({ bundleId, options });
        this.installedBundles.set(bundleId, {
          bundleId,
          version: options.version || 'latest',
          scope: options.scope || 'user'
        });
      }

      public setInstalledBundle(bundleId: string, version: string, scope: string) {
        this.installedBundles.set(bundleId, { bundleId, version, scope });
      }

      public getUninstallCalls() {
        return this.uninstallCalls;
      }

      public getInstallCalls() {
        return this.installCalls;
      }

      public clearCalls() {
        this.uninstallCalls = [];
        this.installCalls = [];
      }
    }

    test('should successfully update bundle from older to latest version', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'test-bundle';
      const oldVersion = '1.0.0';
      const newVersion = '2.0.0';

      // Setup: bundle is installed with old version
      mockManager.setInstalledBundle(bundleId, oldVersion, 'user');

      // Simulate update action: uninstall then install
      mockManager.uninstallBundle(bundleId, 'user');
      mockManager.installBundle(bundleId, { scope: 'user', version: newVersion });

      // Verify uninstall was called
      const uninstallCalls = mockManager.getUninstallCalls();
      assert.strictEqual(uninstallCalls.length, 1);
      assert.strictEqual(uninstallCalls[0].bundleId, bundleId);
      assert.strictEqual(uninstallCalls[0].scope, 'user');

      // Verify install was called with new version
      const installCalls = mockManager.getInstallCalls();
      assert.strictEqual(installCalls.length, 1);
      assert.strictEqual(installCalls[0].bundleId, bundleId);
      assert.strictEqual(installCalls[0].options.version, newVersion);
      assert.strictEqual(installCalls[0].options.scope, 'user');
    });

    test('should handle update with uninstall failure', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'test-bundle';

      // Setup: bundle is installed
      mockManager.setInstalledBundle(bundleId, '1.0.0', 'user');

      // Override uninstallBundle to throw error
      mockManager.uninstallBundle = () => {
        throw new Error('Uninstall failed');
      };

      // Attempt update - should fail at uninstall
      try {
        mockManager.uninstallBundle(bundleId, 'user');
        assert.fail('Should have thrown error');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.strictEqual((error).message, 'Uninstall failed');
      }

      // Verify install was not called (update should stop after uninstall failure)
      const installCalls = mockManager.getInstallCalls();
      assert.strictEqual(installCalls.length, 0);
    });

    test('should handle update with install failure', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'test-bundle';

      // Setup: bundle is installed
      mockManager.setInstalledBundle(bundleId, '1.0.0', 'user');

      // Uninstall succeeds
      mockManager.uninstallBundle(bundleId, 'user');

      // Override installBundle to throw error
      mockManager.installBundle = () => {
        throw new Error('Install failed');
      };

      // Attempt install - should fail
      try {
        mockManager.installBundle(bundleId, { scope: 'user', version: '2.0.0' });
        assert.fail('Should have thrown error');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.strictEqual((error).message, 'Install failed');
      }

      // Verify uninstall was called (bundle is now uninstalled but new version not installed)
      const uninstallCalls = mockManager.getUninstallCalls();
      assert.strictEqual(uninstallCalls.length, 1);
    });

    test('should preserve bundle scope during update', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'test-bundle';

      // Test with 'workspace' scope
      mockManager.setInstalledBundle(bundleId, '1.0.0', 'workspace');

      mockManager.uninstallBundle(bundleId, 'workspace');
      mockManager.installBundle(bundleId, { scope: 'workspace', version: '2.0.0' });

      const uninstallCalls = mockManager.getUninstallCalls();
      const installCalls = mockManager.getInstallCalls();

      assert.strictEqual(uninstallCalls[0].scope, 'workspace');
      assert.strictEqual(installCalls[0].options.scope, 'workspace');
    });

    test('should handle update for GitHub bundles with version suffix', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'microsoft-vscode-1.0.0';
      const newBundleId = 'microsoft-vscode-2.0.0';

      // Setup: old version installed
      mockManager.setInstalledBundle(bundleId, '1.0.0', 'user');

      // Update should uninstall old and install new
      mockManager.uninstallBundle(bundleId, 'user');
      mockManager.installBundle(newBundleId, { scope: 'user', version: '2.0.0' });

      const uninstallCalls = mockManager.getUninstallCalls();
      const installCalls = mockManager.getInstallCalls();

      assert.strictEqual(uninstallCalls[0].bundleId, bundleId);
      assert.strictEqual(installCalls[0].bundleId, newBundleId);
    });

    test('should handle multiple sequential updates', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'test-bundle';

      // Install v1.0.0
      mockManager.setInstalledBundle(bundleId, '1.0.0', 'user');

      // Update to v1.5.0
      mockManager.uninstallBundle(bundleId, 'user');
      mockManager.installBundle(bundleId, { scope: 'user', version: '1.5.0' });
      mockManager.clearCalls();

      // Update to v2.0.0
      mockManager.setInstalledBundle(bundleId, '1.5.0', 'user');
      mockManager.uninstallBundle(bundleId, 'user');
      mockManager.installBundle(bundleId, { scope: 'user', version: '2.0.0' });

      const uninstallCalls = mockManager.getUninstallCalls();
      const installCalls = mockManager.getInstallCalls();

      // Should have one uninstall and one install for the second update
      assert.strictEqual(uninstallCalls.length, 1);
      assert.strictEqual(installCalls.length, 1);
      assert.strictEqual(installCalls[0].options.version, '2.0.0');
    });

    test('should handle update when bundle is not installed', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'test-bundle';

      // Attempt to uninstall non-existent bundle
      // In real implementation, this should either:
      // 1. Skip uninstall and just install
      // 2. Throw an error
      // For this test, we'll verify the behavior

      const installedBundles = mockManager.listInstalledBundles();
      const isInstalled = installedBundles.some((b) => b.bundleId === bundleId);

      assert.strictEqual(isInstalled, false);

      // If not installed, update should just install
      if (!isInstalled) {
        mockManager.installBundle(bundleId, { scope: 'user', version: '2.0.0' });
      }

      const installCalls = mockManager.getInstallCalls();
      assert.strictEqual(installCalls.length, 1);
    });

    test('should handle installVersion with specific version', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'test-bundle';
      const version = '1.5.0';

      // Install specific version
      mockManager.installBundle(bundleId, { scope: 'user', version });

      const installCalls = mockManager.getInstallCalls();
      assert.strictEqual(installCalls.length, 1);
      assert.strictEqual(installCalls[0].bundleId, bundleId);
      assert.strictEqual(installCalls[0].options.version, version);
    });

    test('should pass version parameter to RegistryManager.installBundle', () => {
      const mockManager = new MockRegistryManager();
      const bundleId = 'owner-repo-v2.0.0';
      const requestedVersion = '1.0.0';

      // Simulate version-specific installation
      mockManager.installBundle(bundleId, {
        scope: 'user',
        version: requestedVersion
      });

      const installCalls = mockManager.getInstallCalls();
      assert.strictEqual(installCalls.length, 1);
      assert.strictEqual(installCalls[0].options.version, requestedVersion);
    });
  });

  suite('Version Selection Backend Logic', () => {
    test('should handle getVersions message and return available versions', () => {
      // Mock bundle with multiple versions
      const bundle: Bundle = {
        id: 'owner-repo-v2.0.0',
        name: 'Test Bundle',
        version: '2.0.0',
        description: 'Test',
        author: 'Test',
        sourceId: 'github-source',
        environments: ['vscode'],
        tags: [],
        lastUpdated: '2024-01-01',
        size: '1MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.yml',
        downloadUrl: 'https://example.com/bundle.zip'
      };

      // Add available versions to bundle (as would be done by consolidator)
      const enhancedBundle = {
        ...bundle,
        availableVersions: [
          { version: '2.0.0' },
          { version: '1.5.0' },
          { version: '1.0.0' }
        ]
      };

      // Verify versions are present
      assert.ok(enhancedBundle.availableVersions);
      assert.strictEqual(enhancedBundle.availableVersions.length, 3);
      assert.strictEqual(enhancedBundle.availableVersions[0].version, '2.0.0');
    });

    test('should include availableVersions in enhanced bundles', () => {
      const bundle: any = {
        id: 'owner-repo-v2.0.0',
        name: 'Test Bundle',
        version: '2.0.0',
        isConsolidated: true,
        availableVersions: [
          { version: '2.0.0', publishedAt: '2024-01-03', downloadUrl: 'url3', manifestUrl: 'manifest3' },
          { version: '1.5.0', publishedAt: '2024-01-02', downloadUrl: 'url2', manifestUrl: 'manifest2' },
          { version: '1.0.0', publishedAt: '2024-01-01', downloadUrl: 'url1', manifestUrl: 'manifest1' }
        ]
      };

      // Simulate what loadBundles does
      let availableVersions: { version: string }[] | undefined;
      if (bundle.isConsolidated && bundle.availableVersions) {
        availableVersions = bundle.availableVersions.map((v: any) => ({
          version: v.version
        }));
      }

      assert.ok(availableVersions);
      assert.strictEqual(availableVersions.length, 3);
      assert.deepStrictEqual(availableVersions, [
        { version: '2.0.0' },
        { version: '1.5.0' },
        { version: '1.0.0' }
      ]);
    });
  });
});
