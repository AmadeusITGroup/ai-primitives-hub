/**
 * Property-based tests for AutoUpdateService
 * Tests universal properties that should hold across all inputs
 */

import * as assert from 'node:assert';
import * as fc from 'fast-check';
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
  UpdateCheckResult,
} from '../../src/services/update-cache';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  Bundle,
  InstalledBundle,
  RegistrySource,
  SourceType,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';
import {
  createMockInstalledBundle,
  createUniqueUpdateCheckResult,
} from '../helpers/bundle-test-helpers';
import {
  BundleGenerators,
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('AutoUpdateService - Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRegistryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let mockBundleNotifications: sinon.SinonStubbedInstance<BundleUpdateNotifications>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let service: AutoUpdateService;
  let loggerStub: sinon.SinonStubbedInstance<Logger>;

  // ===== Test Utilities =====

  /**
   * Shared generators from propertyTestHelpers
   */
  const versionArb = BundleGenerators.version();
  const bundleIdArb = BundleGenerators.bundleId();

  /**
   * Create an InstalledBundle from an UpdateCheckResult
   * Helper for converting update results to installed bundles in tests
   * @param update
   * @param useLatestVersion
   */
  const createInstalledBundle = (update: UpdateCheckResult, useLatestVersion = false): InstalledBundle =>
    createMockInstalledBundle(
      update.bundleId,
      useLatestVersion ? update.latestVersion : update.currentVersion
    );

  /**
   * Setup mocks for a single bundle update (success or failure)
   * @param bundleId
   * @param currentVersion
   * @param targetVersion
   * @param shouldSucceed
   */
  const setupSingleBundleUpdate = (
    bundleId: string,
    currentVersion: string,
    targetVersion: string,
    shouldSucceed: boolean
  ): void => {
    const installedBundle = createMockInstalledBundle(bundleId, currentVersion);

    if (shouldSucceed) {
      const updatedBundle = createMockInstalledBundle(bundleId, targetVersion);
      mockRegistryManager.listInstalledBundles
        .onFirstCall().resolves([installedBundle])
        .onSecondCall().resolves([updatedBundle]);
      mockRegistryManager.updateBundle.resolves();
    } else {
      mockRegistryManager.listInstalledBundles.resolves([installedBundle]);
      mockRegistryManager.updateBundle.rejects(new Error('Update failed'));
    }
  };

  /**
   * Setup mocks for batch updates with success/failure flags
   * @param updates
   * @param failureFlags
   */
  const setupBatchUpdates = (updates: UpdateCheckResult[], failureFlags: boolean[]): void => {
    const bundles: InstalledBundle[] = updates.map((u) => createInstalledBundle(u));

    let callCount = 0;
    mockRegistryManager.listInstalledBundles.callsFake(() => {
      callCount++;
      return Promise.resolve(bundles.map((b, index) => {
        const shouldFail = failureFlags[index];
        // After first call, successful updates show new version
        if (callCount > 1 && !shouldFail) {
          return { ...b, version: updates[index].latestVersion };
        }
        return b;
      }));
    });

    updates.forEach((update, index) => {
      if (failureFlags[index]) {
        mockRegistryManager.updateBundle
          .withArgs(update.bundleId, update.latestVersion)
          .rejects(new Error('Update failed'));
      } else {
        mockRegistryManager.updateBundle
          .withArgs(update.bundleId, update.latestVersion)
          .resolves();
      }
    });
  };

  /**
   * Reset all mocks
   * Centralized reset to ensure consistent state between tests
   */
  const resetAllMocks = (): void => {
    mockRegistryManager.updateBundle.reset();
    mockRegistryManager.listInstalledBundles.reset();
    mockRegistryManager.getBundleDetails?.reset();
    mockRegistryManager.listSources?.reset();
    mockRegistryManager.syncSource?.reset();
    mockBundleNotifications.showAutoUpdateComplete.reset();
    mockBundleNotifications.showUpdateFailure.reset();
    mockBundleNotifications.showBatchUpdateSummary.reset();
    mockStorage.getUpdatePreference.reset();
    mockStorage.setUpdatePreference.reset();
    // Reset logger history to prevent cross-test pollution
    loggerStub.debug.resetHistory();
    loggerStub.info.resetHistory();
    loggerStub.warn.resetHistory();
    loggerStub.error.resetHistory();
  };

  // ===== Test Setup/Teardown =====

  setup(() => {
    sandbox = sinon.createSandbox();

    // Stub logger to prevent console output during tests
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

  /**
   * Property 12: Auto-update triggers automatic installation
   * Validates: Requirements 3.2
   *
   * For any bundle with auto-update enabled, the service should automatically
   * install updates without user intervention.
   */
  suite('Property 12: Auto-update triggers automatic installation', () => {
    test('should trigger updateBundle for any bundle with auto-update enabled', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          versionArb,
          versionArb,
          async (bundleId, currentVersion, latestVersion) => {
            if (currentVersion === latestVersion) {
              return true;
            }

            resetAllMocks();

            setupSingleBundleUpdate(bundleId, currentVersion, latestVersion, true);
            mockStorage.getUpdatePreference.resolves(true);
            mockBundleNotifications.showAutoUpdateComplete.resolves();

            await service.autoUpdateBundle({
              bundleId,
              targetVersion: latestVersion,
              showProgress: false
            });

            assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1);
            const [calledBundleId, calledVersion] = mockRegistryManager.updateBundle.firstCall.args;
            assert.strictEqual(calledBundleId, bundleId);
            assert.strictEqual(calledVersion, latestVersion);
            assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.callCount, 1);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should handle update failures gracefully', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          versionArb,
          fc.string({ minLength: 1, maxLength: 50 }),
          async (bundleId, version, _errorMessage) => {
            resetAllMocks();

            setupSingleBundleUpdate(bundleId, '1.0.0', version, false);
            mockBundleNotifications.showUpdateFailure.resolves();

            try {
              await service.autoUpdateBundle({
                bundleId,
                targetVersion: version,
                showProgress: false
              });
              assert.fail('Should have thrown an error');
            } catch {
              // Expected
            }

            assert.strictEqual(mockBundleNotifications.showUpdateFailure.callCount, 1);
            const [calledBundleId, calledError] = mockBundleNotifications.showUpdateFailure.firstCall.args;
            assert.strictEqual(calledBundleId, bundleId);
            assert.ok(
              calledError.includes('Update failed') || calledError.includes('Rollback failed')
            );

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });
  });

  /**
   * Property 41: Auto-update rollback on failure
   * Validates: Requirements 3.4, 8.4
   *
   * When an auto-update fails, the service should attempt rollback to the
   * previous version and verify the rollback succeeded.
   */
  suite('Property 41: Auto-update rollback on failure', () => {
    test('should rollback to previous version when update fails', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          versionArb,
          versionArb,
          async (bundleId, oldVersion, newVersion) => {
            if (oldVersion === newVersion) {
              return true;
            }

            resetAllMocks();

            const installedBundle = createMockInstalledBundle(bundleId, oldVersion);

            mockRegistryManager.listInstalledBundles.resolves([installedBundle]);
            mockRegistryManager.updateBundle.withArgs(bundleId, newVersion).rejects(new Error('Update failed'));
            mockRegistryManager.updateBundle.withArgs(bundleId, oldVersion).resolves();
            mockBundleNotifications.showUpdateFailure.resolves();

            try {
              await service.autoUpdateBundle({ bundleId, targetVersion: newVersion, showProgress: false });
              assert.fail('Should have thrown an error');
            } catch {
              // Expected
            }

            const rollbackCall = mockRegistryManager.updateBundle.getCalls()
              .find((call) => call.args[0] === bundleId && call.args[1] === oldVersion);
            assert.ok(rollbackCall, 'Rollback should be attempted');

            const [, failureMessage] = mockBundleNotifications.showUpdateFailure.firstCall.args;
            assert.ok(failureMessage.includes('Rolled back'));

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should handle rollback failure and mark as corrupted', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          versionArb,
          versionArb,
          async (bundleId, oldVersion, newVersion) => {
            if (oldVersion === newVersion) {
              return true;
            }

            resetAllMocks();

            const installedBundle = createMockInstalledBundle(bundleId, oldVersion);

            mockRegistryManager.listInstalledBundles.resolves([installedBundle]);
            mockRegistryManager.updateBundle.rejects(new Error('Update failed'));
            mockBundleNotifications.showUpdateFailure.resolves();

            try {
              await service.autoUpdateBundle({ bundleId, targetVersion: newVersion, showProgress: false });
              assert.fail('Should have thrown an error');
            } catch {
              // Expected
            }

            const [, failureMessage] = mockBundleNotifications.showUpdateFailure.firstCall.args;
            assert.ok(failureMessage.includes('reinstall'));

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });
  });

  /**
   * Property 24: Concurrent update prevention
   * Validates: Requirements 5.5
   *
   * When an update is in progress, the service should reject concurrent
   * update operations on the same bundle.
   */
  suite('Property 24: Concurrent update prevention', () => {
    test('should prevent concurrent updates for the same bundle', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          versionArb,
          async (bundleId, version) => {
            resetAllMocks();

            // Setup: Slow update operation
            const installedBundle = createMockInstalledBundle(bundleId, '1.0.0');
            const updatedBundle = createMockInstalledBundle(bundleId, version);

            // First call: returns old version (before update)
            // Second call: returns new version (after update for verification)
            mockRegistryManager.listInstalledBundles
              .onFirstCall().resolves([installedBundle])
              .onSecondCall().resolves([updatedBundle]);

            let updateResolve: () => void;
            const updatePromise = new Promise<void>((resolve) => {
              updateResolve = resolve;
            });
            mockRegistryManager.updateBundle.returns(updatePromise);
            mockBundleNotifications.showAutoUpdateComplete.resolves();

            // Act: Start first update (don't await)
            const firstUpdate = service.autoUpdateBundle({
              bundleId,
              targetVersion: version,
              showProgress: false
            });

            // Verify update is in progress
            assert.strictEqual(
              service.isUpdateInProgress(bundleId),
              true,
              'Update should be marked as in progress'
            );

            // Act: Try to start second update while first is in progress
            let secondUpdateFailed = false;
            try {
              await service.autoUpdateBundle({
                bundleId,
                targetVersion: version,
                showProgress: false
              });
            } catch (error) {
              secondUpdateFailed = true;
              assert.ok(
                error instanceof Error && error.message.includes('already in progress'),
                'Should throw error about update in progress'
              );
            }

            // Assert: Second update was rejected
            assert.strictEqual(
              secondUpdateFailed,
              true,
              'Concurrent update should be rejected'
            );

            // Complete first update
            updateResolve!();
            await firstUpdate;

            // Assert: Update is no longer in progress
            assert.strictEqual(
              service.isUpdateInProgress(bundleId),
              false,
              'Update should no longer be in progress'
            );

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should allow updates for different bundles concurrently', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          bundleIdArb,
          versionArb,
          async (bundleId1, bundleId2, version) => {
            // Ensure different bundle IDs
            if (bundleId1 === bundleId2) {
              return true;
            }

            resetAllMocks();

            // Setup: Both bundles installed
            const bundle1 = createMockInstalledBundle(bundleId1, '1.0.0', { installPath: '/mock/path1' });
            const bundle2 = createMockInstalledBundle(bundleId2, '1.0.0', { installPath: '/mock/path2' });
            const updatedBundle1 = createMockInstalledBundle(bundleId1, version, { installPath: '/mock/path1' });
            const updatedBundle2 = createMockInstalledBundle(bundleId2, version, { installPath: '/mock/path2' });

            // Setup listInstalledBundles to return appropriate versions
            // First two calls: before updates (one for each bundle)
            // Next two calls: after updates for verification (one for each bundle)
            mockRegistryManager.listInstalledBundles
              .onCall(0).resolves([bundle1, bundle2])
              .onCall(1).resolves([bundle1, bundle2])
              .onCall(2).resolves([updatedBundle1, bundle2])
              .onCall(3).resolves([updatedBundle1, updatedBundle2]);

            // Setup: Slow updates
            let update1Resolve: () => void;
            let update2Resolve: () => void;
            const update1Promise = new Promise<void>((resolve) => {
              update1Resolve = resolve;
            });
            const update2Promise = new Promise<void>((resolve) => {
              update2Resolve = resolve;
            });

            mockRegistryManager.updateBundle
              .withArgs(bundleId1, version)
              .returns(update1Promise);
            mockRegistryManager.updateBundle
              .withArgs(bundleId2, version)
              .returns(update2Promise);
            mockBundleNotifications.showAutoUpdateComplete.resolves();

            // Act: Start both updates concurrently
            const firstUpdate = service.autoUpdateBundle({
              bundleId: bundleId1,
              targetVersion: version,
              showProgress: false
            });

            const secondUpdate = service.autoUpdateBundle({
              bundleId: bundleId2,
              targetVersion: version,
              showProgress: false
            });

            // Assert: Both updates should be in progress
            assert.strictEqual(
              service.isUpdateInProgress(bundleId1),
              true,
              'First bundle update should be in progress'
            );
            assert.strictEqual(
              service.isUpdateInProgress(bundleId2),
              true,
              'Second bundle update should be in progress'
            );

            // Complete both updates
            update1Resolve!();
            update2Resolve!();
            await Promise.all([firstUpdate, secondUpdate]);

            // Assert: Both updates completed successfully
            assert.strictEqual(
              mockRegistryManager.updateBundle.callCount,
              2,
              'Both updates should have been called'
            );

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });
  });

  /**
   * Property 22: Batch update controlled concurrency processing
   * Validates: Requirements 5.3
   *
   * For any batch update operation, the Registry Manager should update bundles
   * using controlled concurrency (batch size 3) and report progress after each batch.
   */
  suite('Property 22: Batch update controlled concurrency processing', () => {
    test('should process updates in batches with controlled concurrency', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (numUpdates) => {
            const updates = Array.from({ length: numUpdates }, (_, i) => createUniqueUpdateCheckResult(i));
            resetAllMocks();

            const failureFlags = updates.map(() => false);
            setupBatchUpdates(updates, failureFlags);
            mockBundleNotifications.showAutoUpdateComplete.resolves();
            mockBundleNotifications.showBatchUpdateSummary.resolves();

            await service.autoUpdateBundles(updates);

            assert.strictEqual(mockRegistryManager.updateBundle.callCount, updates.length);
            assert.strictEqual(mockBundleNotifications.showBatchUpdateSummary.callCount, 1);

            const [successful, failed] = mockBundleNotifications.showBatchUpdateSummary.firstCall.args;
            assert.strictEqual(successful.length, updates.length);
            assert.strictEqual(failed.length, 0);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });
  });

  /**
   * Property 23: Batch update summary display
   * Validates: Requirements 5.4
   *
   * For any completed batch update, the Notification System should display a summary
   * showing the count of successful updates and the count of failed updates.
   */
  suite('Property 23: Batch update summary display', () => {
    test('should display summary with success and failure counts', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
          async (numUpdates, failureFlags) => {
            const updates = Array.from({ length: numUpdates }, (_, i) => createUniqueUpdateCheckResult(i));
            resetAllMocks();

            const mappedFailureFlags = updates.map((_, i) => failureFlags[i % failureFlags.length]);
            setupBatchUpdates(updates, mappedFailureFlags);
            mockBundleNotifications.showAutoUpdateComplete.resolves();
            mockBundleNotifications.showUpdateFailure.resolves();
            mockBundleNotifications.showBatchUpdateSummary.resolves();

            await service.autoUpdateBundles(updates);

            assert.strictEqual(mockBundleNotifications.showBatchUpdateSummary.callCount, 1);

            const [successful, failed] = mockBundleNotifications.showBatchUpdateSummary.firstCall.args;
            const expectedSuccesses = mappedFailureFlags.filter((f) => !f).length;
            const expectedFailures = mappedFailureFlags.filter(Boolean).length;

            assert.strictEqual(successful.length, expectedSuccesses);
            assert.strictEqual(failed.length, expectedFailures);
            failed.forEach((f) => {
              assert.ok(f.bundleId);
              assert.ok(f.error);
            });

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should show summary even when all updates fail', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (numUpdates) => {
            const updates = Array.from({ length: numUpdates }, (_, i) => createUniqueUpdateCheckResult(i));
            resetAllMocks();

            const failureFlags = updates.map(() => true);
            setupBatchUpdates(updates, failureFlags);
            mockBundleNotifications.showUpdateFailure.resolves();
            mockBundleNotifications.showBatchUpdateSummary.resolves();

            await service.autoUpdateBundles(updates);

            const [successful, failed] = mockBundleNotifications.showBatchUpdateSummary.firstCall.args;
            assert.strictEqual(successful.length, 0);
            assert.strictEqual(failed.length, updates.length);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });
  });

  /**
   * Property 42: Batch updates use controlled concurrency
   * Validates: Requirements 5.3
   *
   * For any batch update operation with N bundles, the AutoUpdateService should
   * process them in batches of size B (where B = 3) using Promise.allSettled
   * for parallel processing within each batch.
   */
  suite('Property 42: Batch updates use controlled concurrency', () => {
    test('should process updates in batches of size 3', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 4, max: 10 }), // At least 4 to test batching
          async (numUpdates) => {
            // Generate unique updates
            const updates = Array.from({ length: numUpdates }, (_, i) => createUniqueUpdateCheckResult(i));

            resetAllMocks();

            // Track concurrent updates
            let maxConcurrent = 0;
            let currentConcurrent = 0;

            // Setup: listInstalledBundles returns appropriate bundles based on current state
            // Create a map to track bundle versions
            const bundleVersions = new Map<string, string>();
            updates.forEach((u) => bundleVersions.set(u.bundleId, u.currentVersion));

            mockRegistryManager.listInstalledBundles.callsFake(() => {
              // Return all bundles with their current versions
              return Promise.resolve(
                Array.from(bundleVersions.entries()).map(([bundleId, version]) =>
                  createMockInstalledBundle(bundleId, version)
                )
              );
            });

            // Setup: Track concurrency AND update bundle versions
            mockRegistryManager.updateBundle.callsFake(async (bundleId: string, version?: string) => {
              currentConcurrent++;
              maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

              // Simulate async work
              await new Promise((resolve) => setTimeout(resolve, 10));

              // Update the version in our map
              if (version) {
                bundleVersions.set(bundleId, version);
              }

              currentConcurrent--;
              return Promise.resolve();
            });

            mockBundleNotifications.showAutoUpdateComplete.resolves();
            mockBundleNotifications.showBatchUpdateSummary.resolves();

            // Act: Perform batch update
            await service.autoUpdateBundles(updates);

            // Assert: Maximum concurrency should not exceed batch size (3)
            assert.ok(
              maxConcurrent <= 3,
              `Maximum concurrent updates should be <= 3, but was ${maxConcurrent}`
            );

            // Assert: All updates were processed
            assert.strictEqual(
              mockRegistryManager.updateBundle.callCount,
              updates.length,
              'All bundles should be updated'
            );

            // Assert: Batch summary was shown
            assert.strictEqual(
              mockBundleNotifications.showBatchUpdateSummary.callCount,
              1,
              'Batch summary should be shown'
            );

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should handle partial failures in batches', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 4, max: 10 }),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
          async (numUpdates, failureFlags) => {
            const updates = Array.from({ length: numUpdates }, (_, i) => createUniqueUpdateCheckResult(i));
            resetAllMocks();

            const mappedFailureFlags = updates.map((_, i) => failureFlags[i % failureFlags.length]);
            setupBatchUpdates(updates, mappedFailureFlags);
            mockBundleNotifications.showAutoUpdateComplete.resolves();
            mockBundleNotifications.showUpdateFailure.resolves();
            mockBundleNotifications.showBatchUpdateSummary.resolves();

            await service.autoUpdateBundles(updates);

            const expectedSuccesses = mappedFailureFlags.filter((f) => !f).length;
            const expectedFailures = mappedFailureFlags.filter(Boolean).length;
            const expectedUpdateCalls = expectedSuccesses + (expectedFailures * 2); // Failures trigger rollback

            assert.strictEqual(mockRegistryManager.updateBundle.callCount, expectedUpdateCalls);
            assert.strictEqual(mockBundleNotifications.showBatchUpdateSummary.callCount, 1);

            const [successful, failed] = mockBundleNotifications.showBatchUpdateSummary.firstCall.args;
            assert.strictEqual(successful.length, expectedSuccesses);
            assert.strictEqual(failed.length, expectedFailures);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });
  });

  /**
   * Property 47: Auto-update syncs source only for GitHub release bundles
   * Validates: Requirements 3.4, 3.5
   *
   * When auto-updating a bundle, the service should sync the source before updating
   * ONLY for bundles from 'github' sources. It should NOT sync sources for bundles
   * from 'awesome-copilot', 'local-awesome-copilot', or 'local' sources.
   */
  suite('Property 47: Auto-update syncs source only for GitHub release bundles', () => {
    test('should sync source only for GitHub release bundles', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          versionArb,
          versionArb,
          fc.constantFrom('github', 'awesome-copilot', 'local-awesome-copilot', 'local'),
          async (bundleId, currentVersion, latestVersion, sourceType) => {
            if (currentVersion === latestVersion) {
              return true;
            }

            resetAllMocks();

            // Create mock source with the specified type
            const mockSource: RegistrySource = {
              id: `${sourceType}-source`,
              name: `${sourceType} Source`,
              type: sourceType as SourceType,
              url: `https://example.com/${sourceType}`,
              enabled: true,
              priority: 1
            };

            // Create mock bundle with source reference
            const mockBundle: Bundle = {
              id: bundleId,
              name: bundleId,
              version: currentVersion,
              description: 'Test bundle',
              author: 'test',
              sourceId: mockSource.id,
              environments: ['vscode'],
              tags: ['test'],
              downloads: 0,
              lastUpdated: new Date().toISOString(),
              size: '1MB',
              dependencies: [],
              license: 'MIT',
              manifestUrl: 'https://example.com/manifest.yml',
              downloadUrl: 'https://example.com/bundle.zip'
            };

            // Setup mocks
            const installedBundle = createMockInstalledBundle(bundleId, currentVersion);
            const updatedBundle = createMockInstalledBundle(bundleId, latestVersion);

            mockRegistryManager.listInstalledBundles
              .onFirstCall().resolves([installedBundle])
              .onSecondCall().resolves([updatedBundle]);

            mockRegistryManager.getBundleDetails.withArgs(bundleId).resolves(mockBundle);
            mockRegistryManager.listSources.resolves([mockSource]);
            mockRegistryManager.updateBundle.resolves();
            mockRegistryManager.syncSource.resolves();
            mockBundleNotifications.showAutoUpdateComplete.resolves();

            // Act: Perform auto-update
            await service.autoUpdateBundle({
              bundleId,
              targetVersion: latestVersion,
              showProgress: false
            });

            // Assert: syncSource should be called ONLY for 'github' sources
            if (sourceType === 'github') {
              assert.strictEqual(
                mockRegistryManager.syncSource.callCount,
                1,
                `syncSource should be called for GitHub source type`
              );
              assert.strictEqual(
                mockRegistryManager.syncSource.firstCall.args[0],
                mockSource.id,
                'syncSource should be called with correct source ID'
              );
            } else {
              assert.strictEqual(
                mockRegistryManager.syncSource.callCount,
                0,
                `syncSource should NOT be called for ${sourceType} source type`
              );
            }

            // Assert: Update should always be called regardless of source type
            assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1);
            assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.callCount, 1);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should handle missing source gracefully', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          versionArb,
          versionArb,
          async (bundleId, currentVersion, latestVersion) => {
            if (currentVersion === latestVersion) {
              return true;
            }

            resetAllMocks();

            // Create mock bundle with non-existent source reference
            const mockBundle: Bundle = {
              id: bundleId,
              name: bundleId,
              version: currentVersion,
              description: 'Test bundle',
              author: 'test',
              sourceId: 'non-existent-source',
              environments: ['vscode'],
              tags: ['test'],
              downloads: 0,
              lastUpdated: new Date().toISOString(),
              size: '1MB',
              dependencies: [],
              license: 'MIT',
              manifestUrl: 'https://example.com/manifest.yml',
              downloadUrl: 'https://example.com/bundle.zip'
            };

            // Setup mocks - no sources returned
            const installedBundle = createMockInstalledBundle(bundleId, currentVersion);
            const updatedBundle = createMockInstalledBundle(bundleId, latestVersion);

            mockRegistryManager.listInstalledBundles
              .onFirstCall().resolves([installedBundle])
              .onSecondCall().resolves([updatedBundle]);

            mockRegistryManager.getBundleDetails.withArgs(bundleId).resolves(mockBundle);
            mockRegistryManager.listSources.resolves([]); // No sources
            mockRegistryManager.updateBundle.resolves();
            mockBundleNotifications.showAutoUpdateComplete.resolves();

            // Act: Perform auto-update (should not fail)
            await service.autoUpdateBundle({
              bundleId,
              targetVersion: latestVersion,
              showProgress: false
            });

            // Assert: syncSource should not be called when source is missing
            assert.strictEqual(
              mockRegistryManager.syncSource.callCount,
              0,
              'syncSource should not be called when source is missing'
            );

            // Assert: Update should still proceed
            assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1);
            assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.callCount, 1);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should continue update even if source sync fails', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          versionArb,
          versionArb,
          async (bundleId, currentVersion, latestVersion) => {
            if (currentVersion === latestVersion) {
              return true;
            }

            resetAllMocks();

            // Create mock GitHub source
            const mockSource: RegistrySource = {
              id: 'github-source',
              name: 'GitHub Source',
              type: 'github',
              url: 'https://github.com/owner/repo',
              enabled: true,
              priority: 1
            };

            // Create mock bundle with GitHub source reference
            const mockBundle: Bundle = {
              id: bundleId,
              name: bundleId,
              version: currentVersion,
              description: 'Test bundle',
              author: 'test',
              sourceId: mockSource.id,
              environments: ['vscode'],
              tags: ['test'],
              downloads: 0,
              lastUpdated: new Date().toISOString(),
              size: '1MB',
              dependencies: [],
              license: 'MIT',
              manifestUrl: 'https://example.com/manifest.yml',
              downloadUrl: 'https://example.com/bundle.zip'
            };

            // Setup mocks
            const installedBundle = createMockInstalledBundle(bundleId, currentVersion);
            const updatedBundle = createMockInstalledBundle(bundleId, latestVersion);

            mockRegistryManager.listInstalledBundles
              .onFirstCall().resolves([installedBundle])
              .onSecondCall().resolves([updatedBundle]);

            mockRegistryManager.getBundleDetails.withArgs(bundleId).resolves(mockBundle);
            mockRegistryManager.listSources.resolves([mockSource]);
            mockRegistryManager.updateBundle.resolves();
            mockRegistryManager.syncSource.rejects(new Error('Sync failed')); // Sync fails
            mockBundleNotifications.showAutoUpdateComplete.resolves();

            // Act: Perform auto-update (should not fail despite sync failure)
            await service.autoUpdateBundle({
              bundleId,
              targetVersion: latestVersion,
              showProgress: false
            });

            // Assert: syncSource was attempted
            assert.strictEqual(
              mockRegistryManager.syncSource.callCount,
              1,
              'syncSource should be attempted for GitHub source'
            );

            // Assert: Update should still proceed despite sync failure
            assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1);
            assert.strictEqual(mockBundleNotifications.showAutoUpdateComplete.callCount, 1);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });
  });
});
