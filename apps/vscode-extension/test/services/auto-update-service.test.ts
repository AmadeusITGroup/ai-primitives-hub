/**
 * Unit tests for AutoUpdateService
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  BundleUpdateNotifications,
} from '../../src/notifications/bundle-update-notifications';
import {
  AutoUpdateService,
} from '../../src/services/auto-update-service';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  InstalledBundle,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';

suite('AutoUpdateService', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRegistryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let mockBundleNotifications: sinon.SinonStubbedInstance<BundleUpdateNotifications>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let service: AutoUpdateService;
  let loggerStub: sinon.SinonStubbedInstance<Logger>;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Stub logger
    const loggerInstance = Logger.getInstance();
    loggerStub = sandbox.stub(loggerInstance);
    loggerStub.debug.returns();
    loggerStub.info.returns();
    loggerStub.warn.returns();
    loggerStub.error.returns();

    // Create stubbed instances
    mockRegistryManager = sandbox.createStubInstance(RegistryManager);
    mockBundleNotifications = sandbox.createStubInstance(BundleUpdateNotifications);
    mockStorage = sandbox.createStubInstance(RegistryStorage);

    // Create service with mocked dependencies
    service = new AutoUpdateService(
      mockRegistryManager, // BundleOperations
      mockRegistryManager, // SourceOperations
      mockBundleNotifications,
      mockStorage
    );
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('autoUpdateBundle()', () => {
    test('should call updateBundle with correct parameters', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';
      const oldVersion = '1.0.0';

      const installedBundle: InstalledBundle = {
        bundleId,
        version: oldVersion,
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: targetVersion
      };

      // First call: before update, Second call: after update for verification
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();

      await service.autoUpdateBundle({
        bundleId,
        targetVersion,
        showProgress: false
      });

      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1);
      assert.strictEqual(mockRegistryManager.updateBundle.firstCall.args[0], bundleId);
      assert.strictEqual(mockRegistryManager.updateBundle.firstCall.args[1], targetVersion);
    });

    test('should show completion notification on success', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';
      const oldVersion = '1.0.0';

      const installedBundle: InstalledBundle = {
        bundleId,
        version: oldVersion,
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: targetVersion
      };

      // First call: before update, Second call: after update for verification
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();

      await service.autoUpdateBundle({
        bundleId,
        targetVersion,
        showProgress: false
      });

      assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.callCount, 1);
      assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.firstCall.args[0], bundleId);
      assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.firstCall.args[1], oldVersion);
      assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.firstCall.args[2], targetVersion);
    });

    test('should show failure notification on error', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';
      const errorMessage = 'Update failed';

      const installedBundle: InstalledBundle = {
        bundleId,
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      // All calls return old version (update fails, rollback also fails)
      mockRegistryManager.listInstalledBundles.resolves([installedBundle]);
      mockRegistryManager.updateBundle.rejects(new Error(errorMessage));
      mockBundleNotifications.showUpdateFailure.resolves();

      try {
        await service.autoUpdateBundle({
          bundleId,
          targetVersion,
          showProgress: false
        });
        assert.fail('Should have thrown an error');
      } catch {
        // Expected
      }

      assert.strictEqual(mockBundleNotifications.showUpdateFailure.callCount, 1);
      assert.strictEqual(mockBundleNotifications.showUpdateFailure.firstCall.args[0], bundleId);
      // Error message now includes rollback failure message
      const failureMessage = mockBundleNotifications.showUpdateFailure.firstCall.args[1];
      assert.ok(
        failureMessage.includes(errorMessage) || failureMessage.includes('Rollback failed'),
        'Error message should include original error or rollback failure'
      );
    });

    test('should prevent concurrent updates for the same bundle', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';

      const installedBundle: InstalledBundle = {
        bundleId,
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: targetVersion
      };

      // First call: before update, Second call: after update for verification
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);

      // Make update slow
      let resolveUpdate: () => void;
      const updatePromise = new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      });
      mockRegistryManager.updateBundle.returns(updatePromise);
      mockBundleNotifications.showAutoUpdateComplete.resolves();

      // Start first update
      const firstUpdate = service.autoUpdateBundle({
        bundleId,
        targetVersion,
        showProgress: false
      });

      // Verify update is in progress
      assert.strictEqual(service.isUpdateInProgress(bundleId), true);

      // Try second update
      try {
        await service.autoUpdateBundle({
          bundleId,
          targetVersion,
          showProgress: false
        });
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('already in progress'));
      }

      // Complete first update
      resolveUpdate!();
      await firstUpdate;

      // Verify update is no longer in progress
      assert.strictEqual(service.isUpdateInProgress(bundleId), false);
    });
  });

  suite('autoUpdateBundles()', () => {
    test('should update only bundles with auto-update enabled', async () => {
      const updates = [
        {
          bundleId: 'bundle1',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          releaseDate: new Date().toISOString(),
          downloadUrl: 'https://example.com/bundle1.zip',
          autoUpdateEnabled: true
        },
        {
          bundleId: 'bundle2',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          releaseDate: new Date().toISOString(),
          downloadUrl: 'https://example.com/bundle2.zip',
          autoUpdateEnabled: false
        }
      ];

      const bundle1: InstalledBundle = {
        bundleId: 'bundle1',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path1',
        manifest: {} as any
      };

      const bundle2: InstalledBundle = {
        bundleId: 'bundle2',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path2',
        manifest: {} as any
      };

      const updatedBundle1: InstalledBundle = {
        ...bundle1,
        version: '2.0.0'
      };

      // First call: before update, Second call: after update for verification
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([bundle1, bundle2])
        .onSecondCall().resolves([updatedBundle1, bundle2]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();
      mockBundleNotifications.showBatchUpdateSummary.resolves();

      await service.autoUpdateBundles(updates);

      // Only bundle1 should be updated
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1);
      assert.strictEqual(mockRegistryManager.updateBundle.firstCall.args[0], 'bundle1');
    });

    test('should show batch summary after completion', async () => {
      const updates = [
        {
          bundleId: 'bundle1',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          releaseDate: new Date().toISOString(),
          downloadUrl: 'https://example.com/bundle1.zip',
          autoUpdateEnabled: true
        }
      ];

      const installedBundle: InstalledBundle = {
        bundleId: 'bundle1',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: '2.0.0'
      };

      // First call: before update, Second call: after update for verification
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();
      mockBundleNotifications.showBatchUpdateSummary.resolves();

      await service.autoUpdateBundles(updates);

      assert.strictEqual(mockBundleNotifications.showBatchUpdateSummary.callCount, 1);
      const [successful, failed] = mockBundleNotifications.showBatchUpdateSummary.firstCall.args;
      assert.deepStrictEqual(successful, ['bundle1']);
      assert.deepStrictEqual(failed, []);
    });
  });

  suite('isAutoUpdateEnabled()', () => {
    test('should return storage preference', async () => {
      const bundleId = 'test-bundle';
      mockStorage.getUpdatePreference.resolves(true);

      const result = await service.isAutoUpdateEnabled(bundleId);

      assert.strictEqual(result, true);
      assert.strictEqual(mockStorage.getUpdatePreference.callCount, 1);
      assert.strictEqual(mockStorage.getUpdatePreference.firstCall.args[0], bundleId);
    });
  });

  suite('setAutoUpdate()', () => {
    test('should update storage preference', async () => {
      const bundleId = 'test-bundle';
      mockStorage.setUpdatePreference.resolves();

      await service.setAutoUpdate(bundleId, true);

      assert.strictEqual(mockStorage.setUpdatePreference.callCount, 1);
      assert.strictEqual(mockStorage.setUpdatePreference.firstCall.args[0], bundleId);
      assert.strictEqual(mockStorage.setUpdatePreference.firstCall.args[1], true);
    });
  });

  suite('isUpdateInProgress()', () => {
    test('should return false when no update in progress', () => {
      const result = service.isUpdateInProgress('test-bundle');
      assert.strictEqual(result, false);
    });
  });

  suite('syncSourceForBundle() - conditional source syncing', () => {
    test('should sync source when bundle is from GitHub release source', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';
      const sourceId = 'github-source';

      const bundle = {
        id: bundleId,
        name: 'Test Bundle',
        version: '1.0.0',
        sourceId: sourceId,
        description: 'Test',
        author: 'Test',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '1MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.yml',
        downloadUrl: 'https://example.com/bundle.zip'
      };

      const source = {
        id: sourceId,
        name: 'GitHub Source',
        type: 'github' as const,
        url: 'https://github.com/owner/repo',
        enabled: true,
        priority: 1
      };

      const installedBundle: InstalledBundle = {
        bundleId,
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: targetVersion
      };

      mockRegistryManager.getBundleDetails.resolves(bundle);
      mockRegistryManager.listSources.resolves([source]);
      mockRegistryManager.syncSource.resolves();
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();

      await service.autoUpdateBundle({
        bundleId,
        targetVersion,
        showProgress: false
      });

      // Verify syncSource was called for GitHub source
      assert.strictEqual(mockRegistryManager.syncSource.callCount, 1);
      assert.strictEqual(mockRegistryManager.syncSource.firstCall.args[0], sourceId);
    });

    test('should NOT sync source when bundle is from awesome-copilot source', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';
      const sourceId = 'awesome-copilot-source';

      const bundle = {
        id: bundleId,
        name: 'Test Bundle',
        version: '1.0.0',
        sourceId: sourceId,
        description: 'Test',
        author: 'Test',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '1MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.yml',
        downloadUrl: 'https://example.com/bundle.zip'
      };

      const source = {
        id: sourceId,
        name: 'Awesome Copilot Source',
        type: 'awesome-copilot' as const,
        url: 'https://github.com/owner/awesome-copilot',
        enabled: true,
        priority: 1
      };

      const installedBundle: InstalledBundle = {
        bundleId,
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: targetVersion
      };

      mockRegistryManager.getBundleDetails.resolves(bundle);
      mockRegistryManager.listSources.resolves([source]);
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();

      await service.autoUpdateBundle({
        bundleId,
        targetVersion,
        showProgress: false
      });

      // Verify syncSource was NOT called for awesome-copilot source
      assert.strictEqual(mockRegistryManager.syncSource.callCount, 0);
    });

    test('should NOT sync source when bundle is from local source', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';
      const sourceId = 'local-source';

      const bundle = {
        id: bundleId,
        name: 'Test Bundle',
        version: '1.0.0',
        sourceId: sourceId,
        description: 'Test',
        author: 'Test',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '1MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'file:///local/manifest.yml',
        downloadUrl: 'file:///local/bundle.zip'
      };

      const source = {
        id: sourceId,
        name: 'Local Source',
        type: 'local' as const,
        url: 'file:///local/bundles',
        enabled: true,
        priority: 1
      };

      const installedBundle: InstalledBundle = {
        bundleId,
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: targetVersion
      };

      mockRegistryManager.getBundleDetails.resolves(bundle);
      mockRegistryManager.listSources.resolves([source]);
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();

      await service.autoUpdateBundle({
        bundleId,
        targetVersion,
        showProgress: false
      });

      // Verify syncSource was NOT called for local source
      assert.strictEqual(mockRegistryManager.syncSource.callCount, 0);
    });

    test('should continue with update even if source sync fails', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';
      const sourceId = 'github-source';

      const bundle = {
        id: bundleId,
        name: 'Test Bundle',
        version: '1.0.0',
        sourceId: sourceId,
        description: 'Test',
        author: 'Test',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '1MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.yml',
        downloadUrl: 'https://example.com/bundle.zip'
      };

      const source = {
        id: sourceId,
        name: 'GitHub Source',
        type: 'github' as const,
        url: 'https://github.com/owner/repo',
        enabled: true,
        priority: 1
      };

      const installedBundle: InstalledBundle = {
        bundleId,
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: targetVersion
      };

      mockRegistryManager.getBundleDetails.resolves(bundle);
      mockRegistryManager.listSources.resolves([source]);
      mockRegistryManager.syncSource.rejects(new Error('Sync failed'));
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();

      // Should not throw - sync failure should be handled gracefully
      await service.autoUpdateBundle({
        bundleId,
        targetVersion,
        showProgress: false
      });

      // Verify update was still called despite sync failure
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1);
      assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.callCount, 1);
    });

    test('should continue with update if source is not found', async () => {
      const bundleId = 'test-bundle';
      const targetVersion = '2.0.0';
      const sourceId = 'missing-source';

      const bundle = {
        id: bundleId,
        name: 'Test Bundle',
        version: '1.0.0',
        sourceId: sourceId,
        description: 'Test',
        author: 'Test',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '1MB',
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'https://example.com/manifest.yml',
        downloadUrl: 'https://example.com/bundle.zip'
      };

      const installedBundle: InstalledBundle = {
        bundleId,
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        scope: 'user',
        installPath: '/mock/path',
        manifest: {} as any
      };

      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        version: targetVersion
      };

      mockRegistryManager.getBundleDetails.resolves(bundle);
      mockRegistryManager.listSources.resolves([]); // No sources found
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
      mockBundleNotifications.showAutoUpdateComplete.resolves();

      // Should not throw - missing source should be handled gracefully
      await service.autoUpdateBundle({
        bundleId,
        targetVersion,
        showProgress: false
      });

      // Verify update was still called despite missing source
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1);
      assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.callCount, 1);
    });
  });
});
