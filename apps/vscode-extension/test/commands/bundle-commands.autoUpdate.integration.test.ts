/**
 * Integration test for auto-update preference storage during bundle installation
 *
 * Tests the integration between:
 * - RegistryManager (provides getStorage() method)
 * - RegistryStorage (stores auto-update preferences)
 * - AutoUpdateService (reads auto-update preferences)
 *
 * Validates Requirement 3.1: Auto-update preference storage after installation
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  AutoUpdateService,
} from '../../src/services/auto-update-service';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';

suite('Auto-Update Preference Storage - Integration', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let registryManager: RegistryManager;
  let storage: RegistryStorage;
  let autoUpdateService: AutoUpdateService;

  setup(async () => {
    sandbox = sinon.createSandbox();

    // Create mock context with real storage behavior
    const globalStateData: Map<string, any> = new Map();

    mockContext = {
      globalState: {
        get: (key: string, defaultValue?: any) => {
          const value = globalStateData.get(key);
          return value === undefined ? defaultValue : value;
        },
        update: (key: string, value: any) => {
          globalStateData.set(key, value);
        },
        keys: () => Array.from(globalStateData.keys()),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/extension/path',
      extensionUri: vscode.Uri.file('/mock/extension/path'),
      environmentVariableCollection: {} as any,
      extensionMode: 3,
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global/storage'),
      logUri: vscode.Uri.file('/mock/log'),
      secrets: {} as any,
      languageModelAccessInformation: {} as any,
      asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
      storagePath: '/mock/storage',
      globalStoragePath: '/mock/global/storage',
      logPath: '/mock/log',
      extension: {} as any
    };

    // Initialize real RegistryManager and RegistryStorage
    registryManager = RegistryManager.getInstance(mockContext);
    storage = new RegistryStorage(mockContext);

    // Stub file system operations to avoid creating real directories/files
    sandbox.stub(storage as any, 'ensureDirectories').resolves();
    sandbox.stub(storage as any, 'loadConfig').resolves({ sources: [], profiles: [] });
    sandbox.stub(storage as any, 'saveConfig').resolves();

    // Initialize storage (won't create directories due to stub)
    await storage.initialize();

    // Replace RegistryManager's storage with our test storage
    (registryManager as any).storage = storage;

    // Create AutoUpdateService with real storage
    autoUpdateService = new AutoUpdateService(
      registryManager, // BundleOperations
      registryManager, // SourceOperations
      {} as any, // BundleUpdateNotifications not needed for this test
      storage
    );
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('RegistryManager.getStorage() integration', () => {
    test('should provide access to storage for setting auto-update preferences', () => {
      // Execute: Get storage from RegistryManager
      const storageFromManager = registryManager.getStorage();

      // Verify: Storage is accessible
      assert.ok(storageFromManager, 'Should return storage instance');
      assert.strictEqual(storageFromManager, storage, 'Should return the same storage instance');
    });

    test('should allow storing and retrieving auto-update preference', async () => {
      const bundleId = 'test-bundle';

      // Execute: Store auto-update preference via RegistryManager's storage
      const storageFromManager = registryManager.getStorage();
      await storageFromManager.setUpdatePreference(bundleId, true);

      // Verify: Preference can be retrieved
      const preference = await storageFromManager.getUpdatePreference(bundleId);
      assert.strictEqual(preference, true, 'Should retrieve stored preference');
    });

    test('should integrate with AutoUpdateService', async () => {
      const bundleId = 'test-bundle-auto';

      // Execute: Store preference via RegistryManager's storage
      const storageFromManager = registryManager.getStorage();
      await storageFromManager.setUpdatePreference(bundleId, true);

      // Verify: AutoUpdateService can read the preference
      const isEnabled = await autoUpdateService.isAutoUpdateEnabled(bundleId);
      assert.strictEqual(isEnabled, true, 'AutoUpdateService should read stored preference');
    });

    test('should default to false for bundles without stored preference', async () => {
      const bundleId = 'new-bundle-without-preference';

      // Execute: Check preference for bundle that hasn't been configured
      const storageFromManager = registryManager.getStorage();
      const preference = await storageFromManager.getUpdatePreference(bundleId);

      // Verify: Defaults to false (opt-in model)
      assert.strictEqual(preference, false, 'Should default to false for unconfigured bundles');
    });

    test('should allow updating existing preference', async () => {
      const bundleId = 'test-bundle-update';
      const storageFromManager = registryManager.getStorage();

      // Execute: Set initial preference
      await storageFromManager.setUpdatePreference(bundleId, true);
      let preference = await storageFromManager.getUpdatePreference(bundleId);
      assert.strictEqual(preference, true, 'Initial preference should be true');

      // Execute: Update preference
      await storageFromManager.setUpdatePreference(bundleId, false);
      preference = await storageFromManager.getUpdatePreference(bundleId);

      // Verify: Preference was updated
      assert.strictEqual(preference, false, 'Updated preference should be false');
    });

    test('should store preferences for multiple bundles independently', async () => {
      const storageFromManager = registryManager.getStorage();

      // Execute: Store different preferences for different bundles
      await storageFromManager.setUpdatePreference('bundle-1', true);
      await storageFromManager.setUpdatePreference('bundle-2', false);
      await storageFromManager.setUpdatePreference('bundle-3', true);

      // Verify: Each bundle has its own preference
      assert.strictEqual(await storageFromManager.getUpdatePreference('bundle-1'), true);
      assert.strictEqual(await storageFromManager.getUpdatePreference('bundle-2'), false);
      assert.strictEqual(await storageFromManager.getUpdatePreference('bundle-3'), true);
    });
  });

  suite('Auto-Update Event Emission and Synchronization', () => {
    test('should emit onAutoUpdatePreferenceChanged event when enabling auto-update via RegistryManager', async () => {
      const bundleId = 'test-bundle-event';
      let eventFired = false;
      let eventData: any = null;

      // Setup: Initialize AutoUpdateService first
      registryManager.setAutoUpdateService(autoUpdateService);

      // Setup: Register listener for event
      registryManager.onAutoUpdatePreferenceChanged((data) => {
        eventFired = true;
        eventData = data;
      });

      // Execute: Enable auto-update via RegistryManager
      await registryManager.enableAutoUpdate(bundleId);

      // Verify: Event was fired with correct data
      assert.strictEqual(eventFired, true, 'Event should be fired');
      assert.strictEqual(eventData.bundleId, bundleId, 'Event should contain correct bundleId');
      assert.strictEqual(eventData.enabled, true, 'Event should indicate enabled = true');
    });

    test('should emit onAutoUpdatePreferenceChanged event when disabling auto-update via RegistryManager', async () => {
      const bundleId = 'test-bundle-disable';
      let eventFired = false;
      let eventData: any = null;

      // Setup: Enable it first
      registryManager.setAutoUpdateService(autoUpdateService);
      await registryManager.enableAutoUpdate(bundleId);

      // Reset event tracking
      eventFired = false;
      eventData = null;

      // Setup: Register listener for event
      registryManager.onAutoUpdatePreferenceChanged((data) => {
        eventFired = true;
        eventData = data;
      });

      // Execute: Disable auto-update via RegistryManager
      await registryManager.disableAutoUpdate(bundleId);

      // Verify: Event was fired with correct data
      assert.strictEqual(eventFired, true, 'Event should be fired');
      assert.strictEqual(eventData.bundleId, bundleId, 'Event should contain correct bundleId');
      assert.strictEqual(eventData.enabled, false, 'Event should indicate enabled = false');
    });

    test('should NOT emit event when directly calling autoUpdateService.setAutoUpdate', async () => {
      const bundleId = 'test-bundle-direct-service';
      let eventFired = false;

      // Setup: Register listener for RegistryManager event
      registryManager.onAutoUpdatePreferenceChanged(() => {
        eventFired = true;
      });

      // Execute: Call AutoUpdateService directly (bypass RegistryManager facade)
      // NOTE: This documents a limitation—direct service calls bypass event emission.
      // Always use RegistryManager.enableAutoUpdate() / disableAutoUpdate() to ensure UI stays in sync.
      await autoUpdateService.setAutoUpdate(bundleId, true);

      // Verify: Event should NOT be fired (because we bypassed RegistryManager)
      assert.strictEqual(eventFired, false, 'Event should not be fired when bypassing RegistryManager');
    });

    test('should allow multiple components to listen to auto-update changes independently', async () => {
      const bundleId = 'test-bundle-multi-listener';
      registryManager.setAutoUpdateService(autoUpdateService);

      let treeViewEventFired = false;
      let marketplaceEventFired = false;

      // Setup: Component 1 (tree view) listener
      registryManager.onAutoUpdatePreferenceChanged((data) => {
        if (data.bundleId === bundleId) {
          treeViewEventFired = true;
        }
      });

      // Setup: Component 2 (marketplace) listener
      registryManager.onAutoUpdatePreferenceChanged((data) => {
        if (data.bundleId === bundleId) {
          marketplaceEventFired = true;
        }
      });

      // Execute: Change auto-update via RegistryManager
      await registryManager.enableAutoUpdate(bundleId);

      // Verify: Both listeners received the event
      assert.strictEqual(treeViewEventFired, true, 'Tree view should receive event');
      assert.strictEqual(marketplaceEventFired, true, 'Marketplace should receive event');
    });
  });
});
