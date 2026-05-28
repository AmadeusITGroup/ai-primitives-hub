/**
 * Property-based tests for Auto-Update Toggle functionality
 * Tests universal properties for auto-update toggle functionality
 *
 * **Feature: bundle-update-notifications, Property 15: Auto-update toggle for existing bundles**
 * **Validates: Requirements 3.5**
 */

import * as assert from 'node:assert';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import {
  AutoUpdateService,
} from '../../src/services/auto-update-service';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  Logger,
} from '../../src/utils/logger';
import {
  AutoUpdateTestHelpers,
} from '../helpers/auto-update-test-helpers';
import {
  BundleGenerators,
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('Auto-Update Toggle - Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockAutoUpdateService: AutoUpdateService;
  let loggerStub: sinon.SinonStubbedInstance<Logger>;

  // ===== Test Utilities =====

  /**
   * Shared generators from propertyTestHelpers
   */
  const bundleIdArb = BundleGenerators.bundleId();
  const booleanArb = fc.boolean();

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
    mockStorage = sandbox.createStubInstance(RegistryStorage);

    // Create AutoUpdateService with mocked dependencies
    mockAutoUpdateService = new AutoUpdateService(
      {} as any, // bundleOps - not used in these tests
      {} as any, // sourceOps - not used in these tests
      {} as any, // bundleNotifications - not used in these tests
      mockStorage
    );
  });

  teardown(() => {
    sandbox.restore();
  });

  /**
   * Property 15: Auto-update toggle for existing bundles
   * Validates: Requirements 3.5
   *
   * For any installed bundle, users should be able to toggle auto-update
   * on/off through the UI, and the change should persist.
   */
  suite('Property 15: Auto-update toggle for existing bundles', () => {
    test('should toggle auto-update state for any installed bundle', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          booleanArb,
          async (bundleId, initialState) => {
            AutoUpdateTestHelpers.resetAutoUpdateMocks(mockStorage, loggerStub);

            const finalState = !initialState;
            AutoUpdateTestHelpers.setupStorageMock(mockStorage, bundleId, [initialState, finalState]);

            // Test auto-update toggle functionality
            await mockAutoUpdateService.setAutoUpdate(bundleId, finalState);

            // Verify setUpdatePreference was called with correct parameters
            AutoUpdateTestHelpers.assertPreferenceStored(mockStorage, bundleId, finalState);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
      );
    });

    test('should handle toggle errors gracefully', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          booleanArb,
          fc.string({ minLength: 1, maxLength: 50 }),
          async (bundleId, enabled, errorMessage) => {
            AutoUpdateTestHelpers.resetAutoUpdateMocks(mockStorage, loggerStub);

            AutoUpdateTestHelpers.setupStorageError(mockStorage, bundleId, enabled, errorMessage);

            // Test error handling in AutoUpdateService
            try {
              await mockAutoUpdateService.setAutoUpdate(bundleId, enabled);
              assert.fail('Should have thrown an error');
            } catch (error) {
              assert.ok(error instanceof Error);
              assert.strictEqual(error.message, errorMessage);
            }

            // Verify storage was called
            assert.strictEqual(mockStorage.setUpdatePreference.callCount, 1);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should retrieve auto-update status correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          booleanArb,
          async (bundleId, enabled) => {
            AutoUpdateTestHelpers.resetAutoUpdateMocks(mockStorage, loggerStub);

            AutoUpdateTestHelpers.setupStorageMock(mockStorage, bundleId, enabled);

            // Test auto-update status retrieval
            const result = await mockAutoUpdateService.isAutoUpdateEnabled(bundleId);

            // Verify correct status was returned
            assert.strictEqual(result, enabled);
            AutoUpdateTestHelpers.assertPreferenceRetrieved(mockStorage, bundleId);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.QUICK }
      );
    });

    test('should handle state transitions correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          booleanArb,
          async (bundleId, initialState) => {
            AutoUpdateTestHelpers.resetAutoUpdateMocks(mockStorage, loggerStub);

            const finalState = !initialState;
            AutoUpdateTestHelpers.setupStorageMock(mockStorage, bundleId, [initialState, finalState]);

            // Test initial state
            const initialResult = await mockAutoUpdateService.isAutoUpdateEnabled(bundleId);
            assert.strictEqual(initialResult, initialState);

            // Test state change
            await mockAutoUpdateService.setAutoUpdate(bundleId, finalState);

            // Test final state
            const finalResult = await mockAutoUpdateService.isAutoUpdateEnabled(bundleId);
            assert.strictEqual(finalResult, finalState);

            // Verify storage interactions
            assert.strictEqual(mockStorage.getUpdatePreference.callCount, 2);
            assert.strictEqual(mockStorage.setUpdatePreference.callCount, 1);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
      );
    });

    test('should persist auto-update preference changes', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleIdArb,
          booleanArb,
          async (bundleId, newState) => {
            AutoUpdateTestHelpers.resetAutoUpdateMocks(mockStorage, loggerStub);

            AutoUpdateTestHelpers.setupStorageMock(mockStorage, bundleId, newState);

            // Test persistence operation
            await mockAutoUpdateService.setAutoUpdate(bundleId, newState);

            // Verify persistence call was made with correct parameters
            AutoUpdateTestHelpers.assertPreferenceStored(mockStorage, bundleId, newState);

            return true;
          }
        ),
        { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
      );
    });
  });
});
