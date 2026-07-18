/**
 * Property-based tests for UpdateScheduler
 *
 * These tests use fast-check to generate random inputs and verify
 * correctness properties hold across all valid executions.
 *
 * Feature: bundle-update-notifications
 */
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  UpdateChecker,
} from '../../src/services/update-checker';
import {
  UpdateCheckFrequency,
  UpdateScheduler,
} from '../../src/services/update-scheduler';
import {
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('UpdateScheduler Property Tests', () => {
  let mockContext: vscode.ExtensionContext;
  let mockMemento: vscode.Memento;

  const originalAllowTimersEnv = process.env.UPDATE_SCHEDULER_ALLOW_TIMERS_IN_TESTS;

  setup(() => {
    // Property-based tests rely on real timer scheduling semantics.
    // Opt-in to scheduler timers in tests to validate timing behavior
    // while other tests keep timers disabled to avoid hangs.
    process.env.UPDATE_SCHEDULER_ALLOW_TIMERS_IN_TESTS = 'true';

    // Create mock memento
    const storage = new Map<string, any>();
    mockMemento = {
      get: (key: string, defaultValue?: any) => {
        return storage.get(key) ?? defaultValue;
      },
      update: (key: string, value: any) => {
        if (value === undefined) {
          storage.delete(key);
        } else {
          storage.set(key, value);
        }
      },
      keys: () => []
    } as any;

    // Create mock context
    mockContext = {
      globalState: mockMemento,
      workspaceState: mockMemento,
      extensionPath: '/mock/path'
    } as any;
  });

  teardown(() => {
    if (originalAllowTimersEnv === undefined) {
      delete process.env.UPDATE_SCHEDULER_ALLOW_TIMERS_IN_TESTS;
    } else {
      process.env.UPDATE_SCHEDULER_ALLOW_TIMERS_IN_TESTS = originalAllowTimersEnv;
    }
  });

  /**
   * Property 1: Update check triggers on startup
   * Feature: bundle-update-notifications, Property 1: Update check triggers on startup
   *
   * For any VS Code startup event, when the extension activates, the Update Scheduler
   * should initiate an update check within 5 seconds.
   *
   * Validates: Requirements 1.1
   */
  test('Property 1: Update check triggers within 5 seconds of startup', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // Generate random number of bundles that might have updates
          numUpdates: fc.integer({ min: 0, max: 10 }),
          // Generate random configuration states
          enabled: fc.constant(true), // Must be enabled for startup check
          frequency: fc.constantFrom<UpdateCheckFrequency>('daily', 'weekly', 'manual')
        }),
        async ({ numUpdates, enabled, frequency }) => {
          // Create fresh sandbox for this test run
          const testSandbox = sinon.createSandbox();

          try {
            // Create fresh fake timers for this test
            const testClock = sinon.useFakeTimers({
              now: Date.now(),
              shouldAdvanceTime: false,
              shouldClearNativeTimers: true
            });

            try {
              // Mock configuration
              const mockConfig = testSandbox.stub(vscode.workspace, 'getConfiguration');
              mockConfig.withArgs('promptregistry.updateCheck').returns({
                get: testSandbox.stub().callsFake((key: string, defaultValue?: any) => {
                  if (key === 'enabled') {
                    return enabled;
                  }
                  if (key === 'frequency') {
                    return frequency;
                  }
                  return defaultValue;
                })
              } as any);

              // Create test UpdateChecker
              const testUpdateChecker = testSandbox.createStubInstance(UpdateChecker);
              const mockUpdates = Array.from({ length: numUpdates }, (_, i) => ({
                bundleId: `bundle-${i}`,
                currentVersion: '1.0.0',
                latestVersion: '2.0.0',
                releaseDate: new Date().toISOString(),
                downloadUrl: 'https://example.com/bundle.zip',
                autoUpdateEnabled: false
              }));
              testUpdateChecker.checkForUpdates.resolves(mockUpdates);

              // Create scheduler
              const scheduler = new UpdateScheduler(mockContext, testUpdateChecker);

              // Initialize scheduler
              await scheduler.initialize();

              // Verify checkForUpdates was NOT called immediately
              if (testUpdateChecker.checkForUpdates.called) {
                return false;
              }

              // Advance time by 4.9 seconds (just before 5 seconds)
              await testClock.tickAsync(4900);

              // Verify checkForUpdates was NOT called yet
              if (testUpdateChecker.checkForUpdates.called) {
                return false;
              }

              // Advance time by 0.2 seconds (past 5 seconds total)
              await testClock.tickAsync(200);

              // Verify checkForUpdates WAS called exactly once
              if (testUpdateChecker.checkForUpdates.callCount !== 1) {
                return false;
              }

              // Verify it was called without bypassing cache (startup check uses cache)
              const callArgs = testUpdateChecker.checkForUpdates.getCall(0).args;
              if (callArgs[0] === true) {
                return false; // Should not bypass cache on startup
              }

              // Cleanup
              scheduler.dispose();

              return true;
            } finally {
              testClock.restore();
            }
          } finally {
            testSandbox.restore();
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, verbose: false }
    );
  });

  /**
   * Property 2: Scheduled update checks respect frequency
   * Feature: bundle-update-notifications, Property 2: Scheduled update checks respect frequency
   *
   * For any configured update check frequency (daily, weekly), the Update Scheduler
   * should perform checks at intervals matching the configured frequency with a
   * tolerance of ±10 minutes.
   *
   * Validates: Requirements 1.2, 6.4
   */
  test('Property 2: Scheduled checks respect configured frequency', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          frequency: fc.constantFrom<UpdateCheckFrequency>('daily', 'weekly'),
          numChecks: fc.integer({ min: 2, max: 4 }) // Test multiple check cycles
        }),
        async ({ frequency, numChecks }) => {
          // Create fresh sandbox for this test run
          const testSandbox = sinon.createSandbox();

          try {
            // Create fresh fake timers for this test
            const testClock = sinon.useFakeTimers({
              now: Date.now(),
              shouldAdvanceTime: false,
              shouldClearNativeTimers: true
            });

            try {
              // Mock configuration
              const mockConfig = testSandbox.stub(vscode.workspace, 'getConfiguration');
              mockConfig.withArgs('promptregistry.updateCheck').returns({
                get: testSandbox.stub().callsFake((key: string, defaultValue?: any) => {
                  if (key === 'enabled') {
                    return true;
                  }
                  if (key === 'frequency') {
                    return frequency;
                  }
                  return defaultValue;
                })
              } as any);

              // Create test UpdateChecker
              const testUpdateChecker = testSandbox.createStubInstance(UpdateChecker);
              testUpdateChecker.checkForUpdates.resolves([]);

              // Create scheduler
              const scheduler = new UpdateScheduler(mockContext, testUpdateChecker);

              // Initialize scheduler
              await scheduler.initialize();

              // Skip startup check (5 seconds)
              await testClock.tickAsync(5000);
              const startupCallCount = testUpdateChecker.checkForUpdates.callCount;

              // Calculate expected interval
              const expectedInterval = frequency === 'daily'
                ? 24 * 60 * 60 * 1000 // 24 hours
                : 7 * 24 * 60 * 60 * 1000; // 7 days

              // Test multiple check cycles
              for (let i = 0; i < numChecks; i++) {
                const beforeCallCount = testUpdateChecker.checkForUpdates.callCount;

                // Advance time by expected interval
                await testClock.tickAsync(expectedInterval);

                // Should have been called exactly once more
                const afterCallCount = testUpdateChecker.checkForUpdates.callCount;
                if (afterCallCount !== beforeCallCount + 1) {
                  // Log for debugging
                  console.log(`Check ${i}: Expected ${beforeCallCount + 1} calls, got ${afterCallCount}`);
                  return false;
                }
              }

              // Verify total number of calls (startup + periodic checks)
              const expectedTotalCalls = startupCallCount + numChecks;
              const actualCalls = testUpdateChecker.checkForUpdates.callCount;
              if (actualCalls !== expectedTotalCalls) {
                console.log(`Total: Expected ${expectedTotalCalls} calls, got ${actualCalls}`);
                return false;
              }

              // Cleanup
              scheduler.dispose();

              return true;
            } finally {
              testClock.restore();
            }
          } finally {
            testSandbox.restore();
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.STANDARD, verbose: false }
    );
  });

  /**
   * Property 28: Frequency change immediate application
   * Feature: bundle-update-notifications, Property 28: Frequency change immediate application
   *
   * For any user change to update check frequency, the Update Checker should apply
   * the new schedule immediately without requiring extension restart.
   *
   * Validates: Requirements 6.4
   */
  test('Property 28: Frequency change immediate application', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          initialFrequency: fc.constantFrom<UpdateCheckFrequency>('daily', 'weekly'),
          newFrequency: fc.constantFrom<UpdateCheckFrequency>('daily', 'weekly')
        }).filter(({ initialFrequency, newFrequency }) => initialFrequency !== newFrequency),
        async ({ initialFrequency, newFrequency }) => {
          // Create fresh sandbox for this test run
          const testSandbox = sinon.createSandbox();

          try {
            // Create fresh fake timers for this test
            const testClock = sinon.useFakeTimers({
              now: Date.now(),
              shouldAdvanceTime: false,
              shouldClearNativeTimers: true
            });

            try {
              // Mock configuration with initial frequency
              const mockConfig = testSandbox.stub(vscode.workspace, 'getConfiguration');
              mockConfig.withArgs('promptregistry.updateCheck').returns({
                get: testSandbox.stub().callsFake((key: string, defaultValue?: any) => {
                  if (key === 'enabled') {
                    return true;
                  }
                  if (key === 'frequency') {
                    return initialFrequency;
                  }
                  return defaultValue;
                })
              } as any);

              // Create test UpdateChecker
              const testUpdateChecker = testSandbox.createStubInstance(UpdateChecker);
              testUpdateChecker.checkForUpdates.resolves([]);

              // Create scheduler
              const scheduler = new UpdateScheduler(mockContext, testUpdateChecker);
              await scheduler.initialize();

              // Skip startup check
              await testClock.tickAsync(5000);
              const afterStartupCallCount = testUpdateChecker.checkForUpdates.callCount;

              // Change frequency
              scheduler.updateSchedule(newFrequency);

              // Calculate new expected interval
              const newInterval = newFrequency === 'daily'
                ? 24 * 60 * 60 * 1000
                : 7 * 24 * 60 * 60 * 1000;

              // Advance time by new interval
              await testClock.tickAsync(newInterval);

              // Should have been called with new frequency
              if (testUpdateChecker.checkForUpdates.callCount !== afterStartupCallCount + 1) {
                return false;
              }

              // Cleanup
              scheduler.dispose();

              return true;
            } finally {
              testClock.restore();
            }
          } finally {
            testSandbox.restore();
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.QUICK, verbose: false }
    );
  });

  /**
   * Additional test: Manual frequency disables scheduled checks
   */
  test('Property: Manual frequency disables scheduled checks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 7 }), // Days to wait
        async (daysToWait) => {
          // Create fresh sandbox for this test run
          const testSandbox = sinon.createSandbox();

          try {
            // Create fresh fake timers for this test
            const testClock = sinon.useFakeTimers({
              now: Date.now(),
              shouldAdvanceTime: false,
              shouldClearNativeTimers: true
            });

            try {
              // Mock configuration with manual frequency
              const mockConfig = testSandbox.stub(vscode.workspace, 'getConfiguration');
              mockConfig.withArgs('promptregistry.updateCheck').returns({
                get: testSandbox.stub().callsFake((key: string, defaultValue?: any) => {
                  if (key === 'enabled') {
                    return true;
                  }
                  if (key === 'frequency') {
                    return 'manual';
                  }
                  return defaultValue;
                })
              } as any);

              // Create test UpdateChecker
              const testUpdateChecker = testSandbox.createStubInstance(UpdateChecker);
              testUpdateChecker.checkForUpdates.resolves([]);

              // Create scheduler
              const scheduler = new UpdateScheduler(mockContext, testUpdateChecker);
              await scheduler.initialize();

              // Skip startup check
              await testClock.tickAsync(5000);
              const afterStartupCallCount = testUpdateChecker.checkForUpdates.callCount;

              // Advance time by multiple days
              const msToWait = daysToWait * 24 * 60 * 60 * 1000;
              await testClock.tickAsync(msToWait);

              // Should NOT have been called again (manual mode)
              if (testUpdateChecker.checkForUpdates.callCount !== afterStartupCallCount) {
                return false;
              }

              // Cleanup
              scheduler.dispose();

              return true;
            } finally {
              testClock.restore();
            }
          } finally {
            testSandbox.restore();
          }
        }
      ),
      { numRuns: PropertyTestConfig.RUNS.QUICK, verbose: false }
    );
  });
});
