/**
 * RegistryManager Workspace Change Property-Based Tests
 *
 * Property-based tests for workspace folder change handling.
 * These tests verify correctness properties for the lockfile-as-source-of-truth feature.
 *
 * Properties covered:
 * - Property 9: Workspace Change Triggers Refresh (Requirements 4.3)
 */

import * as assert from 'node:assert';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('RegistryManager Workspace Change Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  /**
   * Create a mock VS Code ExtensionContext for testing.
   * Uses sinon sandbox for proper cleanup.
   * @param mockSandbox
   */
  const createMockContext = (mockSandbox: sinon.SinonSandbox): vscode.ExtensionContext => {
    return {
      globalState: {
        get: mockSandbox.stub(),
        update: mockSandbox.stub().resolves(),
        keys: mockSandbox.stub().returns([]),
        setKeysForSync: mockSandbox.stub()
      } as any,
      workspaceState: {
        get: mockSandbox.stub(),
        update: mockSandbox.stub().resolves(),
        keys: mockSandbox.stub().returns([]),
        setKeysForSync: mockSandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;
  };

  /**
   * Create a fresh RegistryManager instance for testing.
   * Resets the singleton and creates a new instance with mock storage.
   */
  const createFreshManager = (): RegistryManager => {
    (RegistryManager as any).instance = undefined;
    const manager = RegistryManager.getInstance(mockContext);
    (manager as any).storage = mockStorage;
    return manager;
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    mockContext = createMockContext(sandbox);

    // Create mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([]);
    mockStorage.getProfiles.resolves([]);
    mockStorage.getInstalledBundles.resolves([]);
  });

  teardown(() => {
    sandbox.restore();
    // Reset singleton to ensure clean state for next test
    (RegistryManager as any).instance = undefined;
  });

  /**
   * Property 9: Workspace Change Triggers Refresh
   *
   * For any workspace folder change event (add, remove, or switch), the repository
   * bundle list SHALL be refreshed from the new workspace configuration's lockfile(s).
   *
   * This is verified by checking that the onRepositoryBundlesChanged event is fired
   * when handleWorkspaceFoldersChanged() is called.
   *
   * **Validates: Requirements 4.3**
   * **Feature: lockfile-source-of-truth, Property 9: Workspace Change Triggers Refresh**
   */
  suite('Property 9: Workspace Change Triggers Refresh', () => {
    test('handleWorkspaceFoldersChanged should fire onRepositoryBundlesChanged event', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          (callCount: number) => {
            // Create fresh manager for each iteration
            const manager = createFreshManager();

            // Arrange: Set up event listener to track event fires
            let eventFiredCount = 0;
            const disposable = manager.onRepositoryBundlesChanged(() => {
              eventFiredCount++;
            });

            try {
              // Act: Call handleWorkspaceFoldersChanged multiple times
              for (let i = 0; i < callCount; i++) {
                manager.handleWorkspaceFoldersChanged();
              }

              // Assert: Event should be fired exactly once per call
              assert.strictEqual(
                eventFiredCount,
                callCount,
                `Event should be fired ${callCount} times, but was fired ${eventFiredCount} times`
              );

              return Promise.resolve(true);
            } finally {
              // Cleanup
              disposable.dispose();
              manager.dispose();
            }
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('onRepositoryBundlesChanged event should be subscribable by multiple listeners', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          (listenerCount: number) => {
            // Create fresh manager for each iteration
            const manager = createFreshManager();

            // Arrange: Set up multiple event listeners
            const eventCounts: number[] = Array.from({ length: listenerCount }, () => 0);
            const disposables: vscode.Disposable[] = [];

            for (let i = 0; i < listenerCount; i++) {
              const index = i;
              const disposable = manager.onRepositoryBundlesChanged(() => {
                eventCounts[index]++;
              });
              disposables.push(disposable);
            }

            try {
              // Act: Call handleWorkspaceFoldersChanged
              manager.handleWorkspaceFoldersChanged();

              // Assert: All listeners should receive the event
              for (let i = 0; i < listenerCount; i++) {
                assert.strictEqual(
                  eventCounts[i],
                  1,
                  `Listener ${i} should receive exactly 1 event`
                );
              }

              return Promise.resolve(true);
            } finally {
              // Cleanup
              disposables.forEach((d) => d.dispose());
              manager.dispose();
            }
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.QUICK
        }
      );
    });

    test('disposed listener should not receive events', () => {
      // Create fresh manager for this test
      const manager = createFreshManager();

      try {
        // Arrange: Set up event listener
        let eventFiredCount = 0;
        const disposable = manager.onRepositoryBundlesChanged(() => {
          eventFiredCount++;
        });

        // Act: Call handleWorkspaceFoldersChanged before dispose
        manager.handleWorkspaceFoldersChanged();
        manager.handleWorkspaceFoldersChanged();

        const countBeforeDispose = eventFiredCount;

        // Dispose the listener
        disposable.dispose();

        // Call handleWorkspaceFoldersChanged after dispose
        manager.handleWorkspaceFoldersChanged();
        manager.handleWorkspaceFoldersChanged();

        // Assert: Should only count events before dispose
        assert.strictEqual(
          eventFiredCount,
          countBeforeDispose,
          `Should not receive events after dispose (count should remain ${countBeforeDispose})`
        );
        assert.strictEqual(
          countBeforeDispose,
          2,
          'Should have received 2 events before dispose'
        );
      } finally {
        manager.dispose();
      }
    });

    test('event should fire synchronously when handleWorkspaceFoldersChanged is called', () => {
      // Create fresh manager for this test
      const manager = createFreshManager();

      try {
        // Arrange: Track event timing
        let eventFired = false;
        let eventFiredBeforeReturn = false;

        const disposable = manager.onRepositoryBundlesChanged(() => {
          eventFired = true;
        });

        // Act: Call handleWorkspaceFoldersChanged and check immediately
        manager.handleWorkspaceFoldersChanged();
        eventFiredBeforeReturn = eventFired;

        // Assert: Event should fire synchronously
        assert.strictEqual(
          eventFiredBeforeReturn,
          true,
          'Event should fire synchronously during handleWorkspaceFoldersChanged call'
        );

        // Cleanup
        disposable.dispose();
      } finally {
        manager.dispose();
      }
    });
  });
});
