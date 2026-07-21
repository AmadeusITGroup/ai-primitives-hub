/**
 * SourceTypeReconciler Unit Tests
 *
 * Tests for the static methods: buildBundleIdMapping() and detectTypeChange()
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  ReconcilerHubStorageOperations,
  ReconcilerRegistryOperations,
  ReconcilerStorageOperations,
  SourceTypeReconciler,
} from '../../src/services/source-type-reconciler';
import {
  HubSource,
} from '../../src/types/hub';
import {
  RegistrySource,
} from '../../src/types/registry';
import {
  BundleBuilder,
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';

suite('SourceTypeReconciler', () => {
  suite('buildBundleIdMapping()', () => {
    const oldSourceId = 'old-awesome-source';

    // BundleBuilder.github('owner', 'my-collection') produces bundles with IDs
    // of the form 'owner-my-collection-<version>'. The github source URL
    // therefore needs owner='owner' and repo='my-collection' for the matcher
    // to extract the (empty) collection segment correctly — but that would
    // match a single-collection repo. Instead we use URLs that match the
    // synthesized owner/repo in each test.

    const githubSourceFor = (owner: string, repo: string): RegistrySource => ({
      id: 'new-github-source',
      name: 'Test Source',
      type: 'github',
      url: `https://github.com/${owner}/${repo}`,
      enabled: true,
      priority: 10
    });

    test('maps awesome-copilot ID to matching github bundle', () => {
      // github bundle id: 'org-repo-my-collection-2.0.0' → collection 'my-collection'
      const installed = [
        createMockInstalledBundle('my-collection', '1.0.0', { sourceId: oldSourceId })
      ];
      const githubBundle = BundleBuilder.github('org', 'repo').withVersion('2.0.0').build();
      githubBundle.id = 'org-repo-my-collection-2.0.0';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [githubBundle],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mapping.size, 1);
      assert.ok(mapping.has('my-collection'));
      assert.strictEqual(mapping.get('my-collection')!.id, 'org-repo-my-collection-2.0.0');
    });

    test('selects latest version when multiple github bundles share a collection ID', () => {
      // Repository exposes multiple versions of the same collection via separate
      // GitHub releases. The reconciler must resolve this by picking the latest
      // version, not skip the bundle entirely (which would leave it orphaned
      // after the old source is removed).
      const installed = [
        createMockInstalledBundle('my-collection', '1.0.0', { sourceId: oldSourceId })
      ];
      const bundle1 = BundleBuilder.github('org', 'repo').withVersion('1.0.0').build();
      bundle1.id = 'org-repo-my-collection-1.0.0';
      const bundle2 = BundleBuilder.github('org', 'repo').withVersion('1.0.1').build();
      bundle2.id = 'org-repo-my-collection-1.0.1';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [bundle1, bundle2],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mapping.size, 1);
      assert.strictEqual(mapping.get('my-collection')!.id, 'org-repo-my-collection-1.0.1');
      assert.strictEqual(mapping.get('my-collection')!.version, '1.0.1');
    });

    test('selects latest version regardless of github bundle order', () => {
      // Order of candidates must not affect which version wins — prevents
      // regressions where the first-seen candidate was picked.
      const installed = [
        createMockInstalledBundle('my-collection', '1.0.0', { sourceId: oldSourceId })
      ];
      const latest = BundleBuilder.github('org', 'repo').withVersion('2.5.0').build();
      latest.id = 'org-repo-my-collection-2.5.0';
      const middle = BundleBuilder.github('org', 'repo').withVersion('2.0.0').build();
      middle.id = 'org-repo-my-collection-2.0.0';
      const oldest = BundleBuilder.github('org', 'repo').withVersion('1.0.0').build();
      oldest.id = 'org-repo-my-collection-1.0.0';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [latest, middle, oldest],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mapping.get('my-collection')!.id, 'org-repo-my-collection-2.5.0');

      const mappingReversed = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [oldest, middle, latest],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mappingReversed.get('my-collection')!.id, 'org-repo-my-collection-2.5.0');
    });

    test('skips bundles with no matching github bundle', () => {
      const installed = [
        createMockInstalledBundle('no-match-bundle', '1.0.0', { sourceId: oldSourceId })
      ];
      const githubBundle = BundleBuilder.github('org', 'repo').withVersion('1.0.0').build();
      githubBundle.id = 'org-repo-completely-different-1.0.0';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [githubBundle],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mapping.size, 0);
    });

    test('maps multiple bundles correctly', () => {
      const installed = [
        createMockInstalledBundle('collection-a', '1.0.0', { sourceId: oldSourceId }),
        createMockInstalledBundle('collection-b', '1.0.0', { sourceId: oldSourceId })
      ];
      const bundleA = BundleBuilder.github('org', 'repo').withVersion('2.0.0').build();
      bundleA.id = 'org-repo-collection-a-2.0.0';
      const bundleB = BundleBuilder.github('org', 'repo').withVersion('3.0.0').build();
      bundleB.id = 'org-repo-collection-b-3.0.0';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [bundleA, bundleB],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mapping.size, 2);
      assert.ok(mapping.has('collection-a'));
      assert.ok(mapping.has('collection-b'));
      assert.strictEqual(mapping.get('collection-a')!.id, 'org-repo-collection-a-2.0.0');
      assert.strictEqual(mapping.get('collection-b')!.id, 'org-repo-collection-b-3.0.0');
    });

    test('ignores installed bundles from other sources', () => {
      const installed = [
        createMockInstalledBundle('my-collection', '1.0.0', { sourceId: 'different-source' })
      ];
      const githubBundle = BundleBuilder.github('org', 'repo').withVersion('2.0.0').build();
      githubBundle.id = 'org-repo-my-collection-2.0.0';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [githubBundle],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mapping.size, 0);
    });

    test('does NOT map awesome-copilot ID to github bundle with partial suffix match', () => {
      // 'development' must not match github collection 'azure-development'
      const installed = [
        createMockInstalledBundle('development', '1.0.0', { sourceId: oldSourceId })
      ];
      const githubBundle = BundleBuilder.github('org', 'repo').withVersion('2.0.0').build();
      githubBundle.id = 'org-repo-azure-development-2.0.0';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [githubBundle],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mapping.size, 0, 'Partial suffix must not produce a mapping');
    });

    test('maps each bundle to its exact collection ID when both exist', () => {
      // Both 'development' and 'azure-development' installed, and github source
      // provides exactly those two bundles — each should map to its exact match.
      const installed = [
        createMockInstalledBundle('development', '1.0.0', { sourceId: oldSourceId }),
        createMockInstalledBundle('azure-development', '1.0.0', { sourceId: oldSourceId })
      ];
      const devBundle = BundleBuilder.github('org', 'repo').withVersion('2.0.0').build();
      devBundle.id = 'org-repo-development-2.0.0';
      const azureDevBundle = BundleBuilder.github('org', 'repo').withVersion('2.0.0').build();
      azureDevBundle.id = 'org-repo-azure-development-2.0.0';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [devBundle, azureDevBundle],
        oldSourceId,
        githubSourceFor('org', 'repo')
      );

      assert.strictEqual(mapping.size, 2);
      assert.strictEqual(mapping.get('development')!.id, 'org-repo-development-2.0.0');
      assert.strictEqual(mapping.get('azure-development')!.id, 'org-repo-azure-development-2.0.0');
    });

    test('returns empty mapping when source metadata is not provided', () => {
      // Without a github source, matcher refuses to match — cannot extract
      // the collection ID reliably.
      const installed = [
        createMockInstalledBundle('my-collection', '1.0.0', { sourceId: oldSourceId })
      ];
      const githubBundle = BundleBuilder.github('org', 'repo').withVersion('2.0.0').build();
      githubBundle.id = 'org-repo-my-collection-2.0.0';

      const mapping = SourceTypeReconciler.buildBundleIdMapping(
        installed,
        [githubBundle],
        oldSourceId
      );

      assert.strictEqual(mapping.size, 0);
    });
  });

  suite('detectTypeChange()', () => {
    const createHubSource = (overrides: Partial<HubSource>): HubSource => {
      return {
        id: 'new-github-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/owner/repo',
        enabled: true,
        priority: 10,
        ...overrides
      };
    };

    const createRegistrySource = (overrides: Partial<RegistrySource>): RegistrySource => {
      return {
        id: 'old-awesome-source',
        name: 'Test Source',
        type: 'awesome-copilot',
        url: 'https://github.com/owner/repo',
        enabled: true,
        priority: 10,
        ...overrides
      };
    };

    test('detects awesome-copilot to github type change by URL match', () => {
      const newSource = createHubSource({
        type: 'github',
        url: 'https://github.com/owner/repo'
      });
      const existing = [
        createRegistrySource({
          type: 'awesome-copilot',
          url: 'https://github.com/owner/repo'
        })
      ];

      const result = SourceTypeReconciler.detectTypeChange(newSource, existing);

      assert.ok(result);
      assert.strictEqual(result.type, 'awesome-copilot');
    });

    test('detects type change with URL case differences', () => {
      const newSource = createHubSource({
        type: 'github',
        url: 'https://GitHub.com/Owner/Repo'
      });
      const existing = [
        createRegistrySource({
          type: 'awesome-copilot',
          url: 'https://github.com/owner/repo'
        })
      ];

      const result = SourceTypeReconciler.detectTypeChange(newSource, existing);

      assert.ok(result);
      assert.strictEqual(result.type, 'awesome-copilot');
    });

    test('does not detect when URLs differ', () => {
      const newSource = createHubSource({
        type: 'github',
        url: 'https://github.com/owner/different-repo'
      });
      const existing = [
        createRegistrySource({
          type: 'awesome-copilot',
          url: 'https://github.com/owner/repo'
        })
      ];

      const result = SourceTypeReconciler.detectTypeChange(newSource, existing);

      assert.strictEqual(result, undefined);
    });

    test('does not detect when new source is not github', () => {
      const newSource = createHubSource({
        type: 'awesome-copilot',
        url: 'https://github.com/owner/repo'
      });
      const existing = [
        createRegistrySource({
          type: 'awesome-copilot',
          url: 'https://github.com/owner/repo'
        })
      ];

      const result = SourceTypeReconciler.detectTypeChange(newSource, existing);

      assert.strictEqual(result, undefined);
    });

    test('does not detect when existing source is not awesome-copilot', () => {
      const newSource = createHubSource({
        type: 'github',
        url: 'https://github.com/owner/repo'
      });
      const existing = [
        createRegistrySource({
          type: 'github',
          url: 'https://github.com/owner/repo'
        })
      ];

      const result = SourceTypeReconciler.detectTypeChange(newSource, existing);

      assert.strictEqual(result, undefined);
    });

    test('detects type change with trailing slash difference', () => {
      const newSource = createHubSource({
        type: 'github',
        url: 'https://github.com/owner/repo/'
      });
      const existing = [
        createRegistrySource({
          type: 'awesome-copilot',
          url: 'https://github.com/owner/repo'
        })
      ];

      const result = SourceTypeReconciler.detectTypeChange(newSource, existing);

      assert.ok(result);
      assert.strictEqual(result.type, 'awesome-copilot');
    });
  });

  suite('reconcile()', () => {
    const sandbox = sinon.createSandbox();

    const oldSourceId = 'old-awesome-source';
    const newSourceId = 'new-github-source';
    const hubId = 'test-hub';
    const sourceUrl = 'https://github.com/owner/repo';

    const oldSource: RegistrySource = {
      id: oldSourceId,
      name: 'Old Source',
      type: 'awesome-copilot',
      url: sourceUrl,
      enabled: true,
      priority: 10
    };

    const newHubSource: HubSource = {
      id: newSourceId,
      name: 'New Source',
      type: 'github',
      url: sourceUrl,
      enabled: true,
      priority: 10
    };

    let registry: ReconcilerRegistryOperations;
    let storage: ReconcilerStorageOperations;
    let hubStorage: ReconcilerHubStorageOperations;

    // Helper: produce a github Bundle whose ID has the form
    // `owner-repo-<collectionId>-<version>` matching the reconcile() source URL.
    const makeGithubBundle = (collectionId: string, version: string) => {
      const bundle = BundleBuilder.github('owner', 'repo').withVersion(version).build();
      bundle.id = `owner-repo-${collectionId}-${version}`;
      return bundle;
    };

    setup(() => {
      registry = {
        uninstallBundle: sandbox.stub().resolves(),
        installBundle: sandbox.stub().resolves(
          createMockInstalledBundle('probe', '1.0.0')
        ),
        removeSource: sandbox.stub().resolves(),
        addSource: sandbox.stub().resolves(),
        syncSource: sandbox.stub().resolves(),
        getBundleDetails: sandbox.stub().resolves(makeGithubBundle('my-collection', '2.0.0')),
        listSources: sandbox.stub().resolves([]),
        listInstalledBundles: sandbox.stub().resolves([])
      };

      storage = {
        getCachedSourceBundles: sandbox.stub().resolves([])
      };

      hubStorage = {
        listActiveProfiles: sandbox.stub().resolves([]),
        saveProfileActivationState: sandbox.stub().resolves()
      };
    });

    teardown(() => {
      sandbox.restore();
    });

    test('migrates a bundle from awesome-copilot to github', async () => {
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // Source was added and synced
      assert.ok((registry.addSource as sinon.SinonStub).calledOnce);
      assert.ok((registry.syncSource as sinon.SinonStub).calledOnce);

      // New bundle installed, then old bundle uninstalled
      assert.ok((registry.installBundle as sinon.SinonStub).calledOnce);
      assert.ok((registry.uninstallBundle as sinon.SinonStub).calledOnce);

      // Old source removed
      assert.ok((registry.removeSource as sinon.SinonStub).calledOnce);
      assert.strictEqual(
        (registry.removeSource as sinon.SinonStub).firstCall.args[0],
        oldSourceId
      );

      // Result has 1 successful bundle result
      assert.strictEqual(result.bundleResults.length, 1);
      assert.strictEqual(result.bundleResults[0].success, true);
      assert.strictEqual(result.bundleResults[0].oldBundleId, 'my-collection');
      assert.strictEqual(result.bundleResults[0].newBundleId, 'owner-repo-my-collection-2.0.0');
    });

    test('skips bundle when github release is not available', async () => {
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      // getBundleDetails fails — bundle not available
      (registry.getBundleDetails as sinon.SinonStub).rejects(new Error('404 Not Found'));

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // Old bundle must NOT be uninstalled (safety invariant)
      assert.ok(
        (registry.uninstallBundle as sinon.SinonStub).notCalled,
        'Old bundle should not be uninstalled when new bundle is unavailable'
      );

      // Result has 1 failed bundle result
      assert.strictEqual(result.bundleResults.length, 1);
      assert.strictEqual(result.bundleResults[0].success, false);
      assert.ok(result.bundleResults[0].error);

      // Old source must NOT be removed when bundles fail to migrate
      assert.ok(
        (registry.removeSource as sinon.SinonStub).notCalled,
        'Old source should not be removed when bundle migration fails'
      );
    });

    test('updates profile activation state', async () => {
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      // Active profile referencing old bundle ID
      (hubStorage.listActiveProfiles as sinon.SinonStub).resolves([{
        hubId,
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: ['my-collection'],
        syncedBundleVersions: { 'my-collection': '1.0.0' }
      }]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // Profile state was saved with new bundle IDs
      assert.ok((hubStorage.saveProfileActivationState as sinon.SinonStub).calledOnce);
      const savedState = (hubStorage.saveProfileActivationState as sinon.SinonStub).firstCall.args[2];
      assert.deepStrictEqual(savedState.syncedBundles, ['owner-repo-my-collection-2.0.0']);
      assert.strictEqual(savedState.syncedBundleVersions['owner-repo-my-collection-2.0.0'], '2.0.0');

      assert.strictEqual(result.profilesUpdated, 1);
    });

    test('handles no installed bundles gracefully', async () => {
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      // No installed bundles, but github bundles available
      (registry.listInstalledBundles as sinon.SinonStub).resolves([]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // Old source still removed
      assert.ok((registry.removeSource as sinon.SinonStub).calledOnce);
      assert.strictEqual(
        (registry.removeSource as sinon.SinonStub).firstCall.args[0],
        oldSourceId
      );

      // No bundle results since no mapping was found
      assert.strictEqual(result.bundleResults.length, 0);
    });

    test('migrates a bundle found only in lockfile (repository scope)', async () => {
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'repository'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      // Bundle only in lockfile (repository scope)
      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // Old bundle uninstalled, new bundle installed in repository scope
      assert.ok((registry.uninstallBundle as sinon.SinonStub).calledOnce);
      assert.strictEqual(
        (registry.uninstallBundle as sinon.SinonStub).firstCall.args[1],
        'repository'
      );
      assert.ok((registry.installBundle as sinon.SinonStub).calledOnce);
      assert.strictEqual(
        (registry.installBundle as sinon.SinonStub).firstCall.args[1].scope,
        'repository'
      );

      assert.strictEqual(result.bundleResults.length, 1);
      assert.strictEqual(result.bundleResults[0].success, true);
      assert.strictEqual(result.bundleResults[0].scope, 'repository');
    });

    test('deduplicates bundles present in both storage and lockfile', async () => {
      const userInstalled = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const lockfileInstalled = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      // Same bundle in both storage and lockfile (simulates duplicate from combined query)
      (registry.listInstalledBundles as sinon.SinonStub).resolves([userInstalled, lockfileInstalled]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // Should only migrate once (dedup by bundleId:scope key)
      assert.strictEqual(result.bundleResults.length, 1);
      assert.strictEqual(result.bundleResults[0].success, true);
      assert.ok((registry.uninstallBundle as sinon.SinonStub).calledOnce);
      assert.ok((registry.installBundle as sinon.SinonStub).calledOnce);
    });

    test('install failure after preflight does not remove old bundle', async () => {
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      // Preflight succeeds (getBundleDetails resolves) but installBundle fails
      (registry.installBundle as sinon.SinonStub).rejects(new Error('Download failed'));

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // Install was attempted but failed → old bundle NOT uninstalled (install-first order)
      assert.ok((registry.uninstallBundle as sinon.SinonStub).notCalled);
      assert.strictEqual(result.bundleResults.length, 1);
      assert.strictEqual(result.bundleResults[0].success, false);
      assert.ok(result.bundleResults[0].error!.includes('Download failed'));

      // Old source kept because migration failed
      assert.ok((registry.removeSource as sinon.SinonStub).notCalled);
    });

    test('partial multi-scope failure: profile state only reflects successes', async () => {
      const userInstalled = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const repoInstalled = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'repository'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      (registry.listInstalledBundles as sinon.SinonStub).resolves([userInstalled, repoInstalled]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      // First scope (user) succeeds, second (repository) fails
      (registry.installBundle as sinon.SinonStub)
        .onFirstCall().resolves(createMockInstalledBundle('owner-repo-my-collection-2.0.0', '2.0.0'))
        .onSecondCall().rejects(new Error('Workspace not open'));

      // Profile references old bundle
      (hubStorage.listActiveProfiles as sinon.SinonStub).resolves([{
        hubId,
        profileId: 'profile-1',
        activatedAt: new Date().toISOString(),
        syncedBundles: ['my-collection'],
        syncedBundleVersions: { 'my-collection': '1.0.0' }
      }]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // One success (user), one failure (repository)
      assert.strictEqual(result.bundleResults.length, 2);
      const successes = result.bundleResults.filter((r) => r.success);
      const failures = result.bundleResults.filter((r) => !r.success);
      assert.strictEqual(successes.length, 1);
      assert.strictEqual(failures.length, 1);

      // Profile IS updated because at least one scope succeeded for this bundle
      assert.strictEqual(result.profilesUpdated, 1);

      // Old source is NOT removed (partial failure)
      assert.ok((registry.removeSource as sinon.SinonStub).notCalled);
    });

    test('empty cache with remaining installs keeps old source', async () => {
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });

      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      // New source has no bundles cached
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // No bundle migration attempted
      assert.strictEqual(result.bundleResults.length, 0);

      // Old source NOT removed because installed bundles still reference it
      assert.ok(
        (registry.removeSource as sinon.SinonStub).notCalled,
        'Old source should be preserved when installed bundles still reference it'
      );
    });

    test('no mapping with remaining installs keeps old source', async () => {
      const installed = createMockInstalledBundle('unmatchable-bundle', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const githubBundle = makeGithubBundle('completely-different', '2.0.0');

      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // No bundle migration (no mapping found)
      assert.strictEqual(result.bundleResults.length, 0);

      // Old source NOT removed because installed bundles still reference it
      assert.ok(
        (registry.removeSource as sinon.SinonStub).notCalled,
        'Old source should be preserved when installed bundles reference it and no mapping exists'
      );
    });

    test('skips addSource when new source is already registered', async () => {
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      // New github source already exists in the registry (e.g. a concurrent
      // hub load or retried reconciliation). addSource would reject on a
      // duplicate ID — reconcile() should detect this and skip.
      (registry.listSources as sinon.SinonStub).resolves([{
        id: newSourceId,
        name: 'New Source',
        type: 'github',
        url: sourceUrl,
        enabled: true,
        priority: 10
      }]);
      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // addSource must NOT be called when the source already exists
      assert.ok(
        (registry.addSource as sinon.SinonStub).notCalled,
        'addSource should be skipped when new source is already registered'
      );

      // Reconciliation still proceeds for the bundle
      assert.strictEqual(result.bundleResults.length, 1);
      assert.strictEqual(result.bundleResults[0].success, true);
    });

    test('migrates bundle when github source publishes multiple versions (picks latest)', async () => {
      // Real-world scenario: repo has releases v1.0.0 AND v1.0.1 of the same
      // collection. Before the fix, the reconciler logged "Ambiguous mapping"
      // and skipped migration, then removed the old source anyway — orphaning
      // the bundle (install record kept but source gone → "bundle not found").
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      const olderVersion = makeGithubBundle('my-collection', '1.0.0');
      const latestVersion = makeGithubBundle('my-collection', '1.0.1');

      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([olderVersion, latestVersion]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      assert.strictEqual(result.bundleResults.length, 1);
      assert.strictEqual(result.bundleResults[0].success, true);
      assert.strictEqual(
        result.bundleResults[0].newBundleId,
        'owner-repo-my-collection-1.0.1',
        'Latest version must be installed'
      );

      // New bundle actually installed with latest version's ID
      const installBundleArgs = (registry.installBundle as sinon.SinonStub).firstCall.args;
      assert.strictEqual(installBundleArgs[0], 'owner-repo-my-collection-1.0.1');

      // Old bundle cleaned up
      assert.ok((registry.uninstallBundle as sinon.SinonStub).calledOnce);
      // Old source removed (full migration success)
      assert.ok((registry.removeSource as sinon.SinonStub).calledOnce);
    });

    test('skips reinstall when target bundle is already installed', async () => {
      const installed = createMockInstalledBundle('my-collection', '1.0.0', {
        sourceId: oldSourceId,
        scope: 'user'
      });
      // Target bundle already installed in the same scope (e.g. manual install)
      const preExisting = createMockInstalledBundle('owner-repo-my-collection-2.0.0', '2.0.0', {
        sourceId: newSourceId,
        scope: 'user'
      });
      const githubBundle = makeGithubBundle('my-collection', '2.0.0');

      (registry.listInstalledBundles as sinon.SinonStub).resolves([installed, preExisting]);
      (storage.getCachedSourceBundles as sinon.SinonStub).resolves([githubBundle]);

      const reconciler = new SourceTypeReconciler(registry, storage, hubStorage);
      const result = await reconciler.reconcile(oldSource, newHubSource, hubId, newSourceId);

      // Should not try to install over the existing bundle
      assert.ok(
        (registry.installBundle as sinon.SinonStub).notCalled,
        'Should not reinstall when target bundle already installed'
      );
      // Old bundle is still uninstalled to clean up
      assert.ok((registry.uninstallBundle as sinon.SinonStub).calledOnce);

      assert.strictEqual(result.bundleResults.length, 1);
      assert.strictEqual(result.bundleResults[0].success, true);
    });
  });
});
