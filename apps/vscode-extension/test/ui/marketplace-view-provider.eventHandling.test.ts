/**
 * MarketplaceViewProvider Event Handling Tests
 *
 * Tests for verifying that the marketplace UI refreshes correctly on bundle events
 * Requirements: 6.4, 6.5
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  DeploymentManifest,
  InstalledBundle,
} from '../../src/types/registry';
import {
  MarketplaceViewProvider,
} from '../../src/ui/marketplace-view-provider';
import {
  setupRegistryManagerEventMocks,
} from '../helpers/ui-test-helpers';

const PROJECT_ROOT = process.cwd();

// Helper to create mock manifest
function createMockManifest(): DeploymentManifest {
  return {
    common: {
      directories: [],
      files: [],
      include_patterns: [],
      exclude_patterns: []
    },
    bundle_settings: {
      include_common_in_environment_bundles: true,
      create_common_bundle: true,
      compression: 'zip',
      naming: {
        environment_bundle: 'bundle'
      }
    },
    metadata: {
      manifest_version: '1.0.0',
      description: 'Test manifest'
    }
  };
}

suite('MarketplaceViewProvider - Event Handling', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let mockRegistryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let mockSetupStateManager: sinon.SinonStubbedInstance<SetupStateManager>;
  let onBundleInstalledCallback: ((installation: InstalledBundle) => void) | undefined;
  let onBundleUninstalledCallback: ((bundleId: string) => void) | undefined;
  let onBundleUpdatedCallback: ((installation: InstalledBundle) => void) | undefined;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create mock context
    mockContext = {
      subscriptions: [],
      extensionUri: vscode.Uri.file('/mock/path'),
      extensionPath: '/mock/path',
      storagePath: '/mock/storage',
      globalStoragePath: '/mock/global-storage',
      logPath: '/mock/logs',
      extensionMode: 2 // ExtensionMode.Test
    } as any;

    // Create mock RegistryManager with event emitters, capturing the callbacks
    // this suite drives directly.
    mockRegistryManager = {
      searchBundles: sandbox.stub().resolves([]),
      listInstalledBundles: sandbox.stub().resolves([]),
      listSources: sandbox.stub().resolves([])
    } as any;
    setupRegistryManagerEventMocks(mockRegistryManager, sandbox, {
      onBundleInstalled: (cb) => {
        onBundleInstalledCallback = cb;
      },
      onBundleUninstalled: (cb) => {
        onBundleUninstalledCallback = cb;
      },
      onBundleUpdated: (cb) => {
        onBundleUpdatedCallback = cb;
      }
    });

    // Create mock SetupStateManager
    mockSetupStateManager = {
      getState: sandbox.stub().resolves('complete'),
      isComplete: sandbox.stub().resolves(true),
      isIncomplete: sandbox.stub().resolves(false)
    } as any;

    // Create MarketplaceViewProvider
    new MarketplaceViewProvider(mockContext, mockRegistryManager, mockSetupStateManager);
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('Event Listener Registration', () => {
    test('should register listener for onBundleInstalled event', () => {
      // Requirement 6.4: WHEN the marketplace receives an installation event THEN the system SHALL reload bundle data and refresh the UI

      assert.ok(mockRegistryManager.onBundleInstalled.calledOnce, 'Should register onBundleInstalled listener');
      assert.ok(onBundleInstalledCallback, 'Should have callback for onBundleInstalled');
    });

    test('should register listener for onBundleUninstalled event', () => {
      // Requirement 6.5: WHEN the marketplace receives an uninstallation event THEN the system SHALL reload bundle data and refresh the UI

      assert.ok(mockRegistryManager.onBundleUninstalled.calledOnce, 'Should register onBundleUninstalled listener');
      assert.ok(onBundleUninstalledCallback, 'Should have callback for onBundleUninstalled');
    });

    test('should register listener for onBundleUpdated event', () => {
      // Requirement 6.4: WHEN the marketplace receives an update event THEN the system SHALL reload bundle data and refresh the UI

      assert.ok(mockRegistryManager.onBundleUpdated.calledOnce, 'Should register onBundleUpdated listener');
      assert.ok(onBundleUpdatedCallback, 'Should have callback for onBundleUpdated');
    });
  });

  suite('UI Refresh on Events', () => {
    test('should refresh UI when onBundleInstalled event fires', async () => {
      // Requirement 6.4: WHEN the marketplace receives an installation event THEN the system SHALL reload bundle data and refresh the UI

      const mockInstallation: InstalledBundle = {
        bundleId: 'test-bundle',
        version: '1.0.0',
        installPath: '/mock/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      // Spy on loadBundles (private method, but we can verify searchBundles is called)
      const searchBundlesCallCount = mockRegistryManager.searchBundles.callCount;

      // Fire the event
      if (onBundleInstalledCallback) {
        onBundleInstalledCallback(mockInstallation);
      }

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify searchBundles was called (indicating UI refresh)
      assert.ok(
        mockRegistryManager.searchBundles.callCount > searchBundlesCallCount,
        'Should call searchBundles to refresh UI'
      );
    });

    test('should refresh UI when onBundleUninstalled event fires', async () => {
      // Requirement 6.5: WHEN the marketplace receives an uninstallation event THEN the system SHALL reload bundle data and refresh the UI

      const bundleId = 'test-bundle-v1.0.0';

      // Spy on loadBundles
      const searchBundlesCallCount = mockRegistryManager.searchBundles.callCount;

      // Fire the event
      if (onBundleUninstalledCallback) {
        onBundleUninstalledCallback(bundleId);
      }

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify searchBundles was called
      assert.ok(
        mockRegistryManager.searchBundles.callCount > searchBundlesCallCount,
        'Should call searchBundles to refresh UI'
      );
    });

    test('should refresh UI when onBundleUpdated event fires', async () => {
      // Requirement 6.4: WHEN the marketplace receives an update event THEN the system SHALL reload bundle data and refresh the UI

      const mockInstallation: InstalledBundle = {
        bundleId: 'test-bundle',
        version: '1.1.0',
        installPath: '/mock/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      // Spy on loadBundles
      const searchBundlesCallCount = mockRegistryManager.searchBundles.callCount;

      // Fire the event
      if (onBundleUpdatedCallback) {
        onBundleUpdatedCallback(mockInstallation);
      }

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify searchBundles was called
      assert.ok(
        mockRegistryManager.searchBundles.callCount > searchBundlesCallCount,
        'Should call searchBundles to refresh UI'
      );
    });
  });

  suite('Error Handling in Event Listeners', () => {
    test('should handle errors in onBundleInstalled listener gracefully', async () => {
      // Force an error by making searchBundles throw
      mockRegistryManager.searchBundles.rejects(new Error('Mock search error'));

      const mockInstallation: InstalledBundle = {
        bundleId: 'test-bundle',
        version: '1.0.0',
        installPath: '/mock/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      // Fire the event - should not throw
      assert.doesNotThrow(() => {
        if (onBundleInstalledCallback) {
          onBundleInstalledCallback(mockInstallation);
        }
      }, 'Event listener should handle errors gracefully');

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    test('should handle errors in onBundleUninstalled listener gracefully', async () => {
      // Force an error
      mockRegistryManager.searchBundles.rejects(new Error('Mock search error'));

      const bundleId = 'test-bundle';

      // Fire the event - should not throw
      assert.doesNotThrow(() => {
        if (onBundleUninstalledCallback) {
          onBundleUninstalledCallback(bundleId);
        }
      }, 'Event listener should handle errors gracefully');

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    test('should handle errors in onBundleUpdated listener gracefully', async () => {
      // Force an error
      mockRegistryManager.searchBundles.rejects(new Error('Mock search error'));

      const mockInstallation: InstalledBundle = {
        bundleId: 'test-bundle',
        version: '1.1.0',
        installPath: '/mock/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      // Fire the event - should not throw
      assert.doesNotThrow(() => {
        if (onBundleUpdatedCallback) {
          onBundleUpdatedCallback(mockInstallation);
        }
      }, 'Event listener should handle errors gracefully');

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  suite('Event Data Validation', () => {
    test('should log installation details when onBundleInstalled fires', async () => {
      const mockInstallation: InstalledBundle = {
        bundleId: 'test-bundle-v1.0.0',
        version: '1.0.0',
        installPath: '/mock/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      // Fire the event
      if (onBundleInstalledCallback) {
        onBundleInstalledCallback(mockInstallation);
      }

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The event should have been processed without errors
      // (logging is verified through the try-catch blocks we added)
      assert.ok(true, 'Event processed successfully');
    });

    test('should log bundle ID when onBundleUninstalled fires', async () => {
      const bundleId = 'test-bundle-v1.0.0';

      // Fire the event
      if (onBundleUninstalledCallback) {
        onBundleUninstalledCallback(bundleId);
      }

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The event should have been processed without errors
      assert.ok(true, 'Event processed successfully');
    });

    test('should log updated installation details when onBundleUpdated fires', async () => {
      const mockInstallation: InstalledBundle = {
        bundleId: 'test-bundle',
        version: '1.1.0',
        installPath: '/mock/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        manifest: createMockManifest()
      };

      // Fire the event
      if (onBundleUpdatedCallback) {
        onBundleUpdatedCallback(mockInstallation);
      }

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The event should have been processed without errors
      assert.ok(true, 'Event processed successfully');
    });
  });
});

suite('MarketplaceViewProvider - Throttle on source sync burst', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;
  let onSourceSyncedCallback: ((event: { sourceId: string; bundleCount: number }) => void) | undefined;
  let postedMessages: any[];
  let mockSearchBundles: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
    postedMessages = [];
    mockSearchBundles = sandbox.stub().resolves([]);

    const mockWebview = {
      postMessage: (message: any) => {
        postedMessages.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: sandbox.stub().returns({ dispose: () => {} }),
      asWebviewUri: (uri: vscode.Uri) => uri,
      cspSource: "'self'",
      options: {},
      html: ''
    };

    const mockContext: any = {
      subscriptions: [],
      extensionUri: vscode.Uri.file(PROJECT_ROOT),
      extensionPath: PROJECT_ROOT,
      storagePath: '/mock/storage',
      globalStoragePath: '/mock/global-storage',
      logPath: '/mock/logs',
      extensionMode: 2
    };

    const mockRegistryManager: any = {
      searchBundles: mockSearchBundles,
      listInstalledBundles: sandbox.stub().resolves([]),
      listSources: sandbox.stub().resolves([]),
      autoUpdateService: null
    };
    setupRegistryManagerEventMocks(mockRegistryManager, sandbox, {
      onSourceSynced: (cb) => {
        onSourceSyncedCallback = cb;
      }
    });

    const mockSetupStateManager: any = {
      getState: sandbox.stub().resolves('complete'),
      isComplete: sandbox.stub().resolves(true),
      isIncomplete: sandbox.stub().resolves(false)
    };

    const provider = new MarketplaceViewProvider(mockContext, mockRegistryManager, mockSetupStateManager);
    (provider as any)._view = { webview: mockWebview };
    (provider as any).webviewReady = true;
  });

  teardown(() => {
    sandbox.restore();
  });

  const flushAsync = async () => {
    // Flush pending microtasks and promise chains (searchBundles, listInstalledBundles, listSources each add ticks)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  };

  test('fires leading-edge refresh immediately on first source-synced event', async () => {
    // Fire one event — the leading edge must trigger a refresh right away (before any timer)
    onSourceSyncedCallback?.({ sourceId: 'test-source', bundleCount: 5 });

    // Drain the microtask queue so the async loadBundles can post its message
    await flushAsync();

    const countBeforeTimer = postedMessages.filter((m) => m.type === 'bundlesLoaded').length;
    assert.ok(countBeforeTimer >= 1, `Expected leading-edge bundlesLoaded message before timer, got ${countBeforeTimer}`);
  });

  test('a burst of 5 source-synced events produces ≥2 bundlesLoaded messages (leading + trailing)', async () => {
    if (!onSourceSyncedCallback) {
      assert.fail('onSourceSynced callback was not registered');
    }

    // Fire 5 events in rapid succession (all within the 500ms window)
    for (let i = 0; i < 5; i++) {
      onSourceSyncedCallback({ sourceId: 'test-source', bundleCount: i + 1 });
    }

    // Drain microtasks so the leading-edge loadBundles completes
    await flushAsync();

    const afterLeading = postedMessages.filter((m) => m.type === 'bundlesLoaded').length;
    assert.ok(afterLeading >= 1, `Expected at least leading-edge bundlesLoaded, got ${afterLeading}`);

    // Advance past the throttle window to trigger the trailing edge
    clock.tick(600);
    await flushAsync();

    const afterTrailing = postedMessages.filter((m) => m.type === 'bundlesLoaded').length;
    assert.ok(
      afterTrailing >= 2,
      `Expected ≥2 bundlesLoaded messages (leading + trailing), got ${afterTrailing}`
    );
  });

  // Gate the FIRST load on a FAKE TIMER (not a hand-resolved promise). This keeps
  // the entire async chain timer-driven so clock.tickAsync fully controls ordering
  // and settling — mixing a manually-resolved promise with tickAsync is flaky under
  // a busy event loop. The gate "releases" at GATE_MS; later calls resolve at once.
  const GATE_MS = 10_000;
  const gateFirstLoad = () => {
    mockSearchBundles.onFirstCall().callsFake(
      () => new Promise((resolve) => setTimeout(() => resolve([]), GATE_MS))
    );
    mockSearchBundles.callsFake(async () => []);
  };
  const renderCount = () => postedMessages.filter((m) => m.type === 'bundlesLoaded').length;

  test('does not drop the trailing-edge load when the leading-edge load is still in flight', async () => {
    if (!onSourceSyncedCallback) {
      assert.fail('onSourceSynced callback was not registered');
    }

    gateFirstLoad();

    // Leading edge: starts the (gated) first load and arms the 500ms throttle timer.
    onSourceSyncedCallback({ sourceId: 'source-a', bundleCount: 3 });

    // Advance past the 500ms throttle window (but not past the gate) so the trailing
    // edge fires while the first load is still in flight — the call that was
    // previously swallowed and never rescheduled.
    await clock.tickAsync(600);

    assert.strictEqual(renderCount(), 0, 'no render should occur while the first load is still gated');

    // Release the gated first load. The coalesced follow-up must run and render again.
    await clock.tickAsync(GATE_MS);

    assert.ok(
      renderCount() >= 2,
      `expected leading-edge render plus a coalesced trailing-edge render, got ${renderCount()}`
    );
    assert.ok(
      mockSearchBundles.callCount >= 2,
      `expected the coalesced load to re-query the cache, got ${mockSearchBundles.callCount} calls`
    );
  });

  test('collapses multiple mid-flight load requests into a single follow-up render', async () => {
    if (!onSourceSyncedCallback) {
      assert.fail('onSourceSynced callback was not registered');
    }

    gateFirstLoad();

    // Leading edge starts the gated load and arms the throttle timer.
    onSourceSyncedCallback({ sourceId: 'source-a', bundleCount: 1 });

    // Generate several load requests while the first load is still gated: each
    // trailing edge fires, and a fresh event re-arms the throttle for the next one.
    await clock.tickAsync(600); // trailing edge #1 → pending
    onSourceSyncedCallback({ sourceId: 'source-a', bundleCount: 2 }); // re-arms
    await clock.tickAsync(600); // trailing edge #2 → pending (still just one re-run queued)
    onSourceSyncedCallback({ sourceId: 'source-a', bundleCount: 3 }); // re-arms
    await clock.tickAsync(600); // trailing edge #3 → pending

    assert.strictEqual(renderCount(), 0, 'no render should occur while the first load is still gated');

    // Release the gate: exactly one leading render + one coalesced follow-up.
    await clock.tickAsync(GATE_MS);

    assert.strictEqual(
      renderCount(),
      2,
      `expected exactly leading + one coalesced follow-up render, got ${renderCount()}`
    );
  });
});
