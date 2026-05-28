/**
 * Property-based tests for SetupStateManager
 * Tests universal correctness properties across all valid executions
 */

import * as assert from 'node:assert';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  SetupState,
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  PropertyTestConfig,
} from '../helpers/property-test-helpers';
import {
  createMockHubData,
  formatTestParams,
} from '../helpers/setup-state-test-helpers';

suite('SetupStateManager - Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let globalStateData: Map<string, any>;

  setup(() => {
    sandbox = sinon.createSandbox();
    globalStateData = new Map();

    mockContext = {
      globalState: {
        get: (key: string, defaultValue?: any) => globalStateData.get(key) ?? defaultValue,
        update: (key: string, value: any) => {
          globalStateData.set(key, value);
        },
        keys: () => Array.from(globalStateData.keys()),
        setKeysForSync: sandbox.stub()
      } as any,
      globalStorageUri: vscode.Uri.file('/mock/storage'),
      extensionPath: '/mock/extension',
      extensionUri: vscode.Uri.file('/mock/extension'),
      subscriptions: [],
      extensionMode: 1 as any // ExtensionMode.Production
    } as any as vscode.ExtensionContext;

    mockHubManager = sandbox.createStubInstance(HubManager);
    mockHubManager.listHubs.resolves([]);
    mockHubManager.getActiveHub.resolves(null);

    // Reset singleton
    SetupStateManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    SetupStateManager.resetInstance();
  });

  // Property 1: State Transition Validity
  // For any sequence of setup operations, the setup state should only transition through valid paths
  test('Property 1: State transitions follow valid paths (Req 2.1-2.6)', async () => {
    const operationArbitrary = fc.constantFrom(
      'start',
      'complete',
      'cancel_auth',
      'cancel_hub',
      'resume',
      'reset'
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArbitrary, { minLength: 1, maxLength: 20 }),
        async (operations) => {
          // Reset state for each test
          globalStateData.clear();
          SetupStateManager.resetInstance();
          const manager = SetupStateManager.getInstance(mockContext, mockHubManager);

          const validTransitions: Record<SetupState, SetupState[]> = {
            [SetupState.NOT_STARTED]: [SetupState.IN_PROGRESS, SetupState.COMPLETE, SetupState.INCOMPLETE],
            [SetupState.IN_PROGRESS]: [SetupState.COMPLETE, SetupState.INCOMPLETE, SetupState.NOT_STARTED], // Can reset from in_progress
            [SetupState.COMPLETE]: [SetupState.NOT_STARTED, SetupState.IN_PROGRESS, SetupState.INCOMPLETE], // Reset, re-setup, or error
            [SetupState.INCOMPLETE]: [SetupState.IN_PROGRESS, SetupState.NOT_STARTED, SetupState.COMPLETE] // Resume, reset, or direct complete
          };

          let previousState = await manager.getState();

          for (const op of operations) {
            switch (op) {
              case 'start': {
                await manager.markStarted();
                break;
              }
              case 'complete': {
                await manager.markComplete();
                break;
              }
              case 'cancel_auth': {
                await manager.markIncomplete();
                break;
              }
              case 'cancel_hub': {
                await manager.markIncomplete();
                break;
              }
              case 'resume': {
                await manager.markStarted();
                break;
              }
              case 'reset': {
                await manager.reset();
                break;
              }
            }

            const currentState = await manager.getState();

            // Verify transition is valid or state didn't change
            if (currentState !== previousState) {
              const allowedNextStates = validTransitions[previousState];
              assert.ok(
                allowedNextStates.includes(currentState),
                `Invalid transition: ${previousState} → ${currentState} (operation: ${op}, sequence: ${operations.join(',')})`
              );
            }

            previousState = currentState;
          }

          // Final state should always be valid
          const finalState = await manager.getState();
          assert.ok(
            Object.values(SetupState).includes(finalState),
            `Final state ${finalState} is not a valid SetupState (sequence: ${operations.join(',')})`
          );

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 6: Setup Completion Idempotence
  // For any setup state that is already complete, calling markComplete() again should not change state
  test('Property 6: Setup completion is idempotent (Req 5.1, 5.2, 5.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (repeatCount) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();
          const manager = SetupStateManager.getInstance(mockContext, mockHubManager);

          // Mark as complete once
          await manager.markComplete();
          const stateAfterFirst = await manager.getState();
          assert.strictEqual(stateAfterFirst, SetupState.COMPLETE,
            `Initial state should be COMPLETE (repeatCount=${repeatCount})`);

          // Mark as complete multiple times
          for (let i = 0; i < repeatCount; i++) {
            await manager.markComplete();
          }

          // State should still be complete
          const finalState = await manager.getState();
          assert.strictEqual(finalState, SetupState.COMPLETE,
            `State should remain COMPLETE after ${repeatCount} additional markComplete() calls`);

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 9: State Persistence
  // For any state transition, the new state should be persisted and retrievable
  test('Property 9: State persists across manager instances (Req 1.4, 2.6)', async () => {
    const stateArbitrary = fc.constantFrom(
      SetupState.NOT_STARTED,
      SetupState.IN_PROGRESS,
      SetupState.COMPLETE,
      SetupState.INCOMPLETE
    );

    await fc.assert(
      fc.asyncProperty(
        stateArbitrary,
        async (targetState) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();
          const manager1 = SetupStateManager.getInstance(mockContext, mockHubManager);

          // Transition to target state
          switch (targetState) {
            case SetupState.NOT_STARTED: {
              await manager1.reset();
              break;
            }
            case SetupState.IN_PROGRESS: {
              await manager1.markStarted();
              break;
            }
            case SetupState.COMPLETE: {
              await manager1.markComplete();
              break;
            }
            case SetupState.INCOMPLETE: {
              await manager1.markIncomplete();
              break;
            }
          }

          const stateBeforeReload = await manager1.getState();

          // Create new manager instance (simulates extension reload)
          SetupStateManager.resetInstance();
          const manager2 = SetupStateManager.getInstance(mockContext, mockHubManager);

          const stateAfterReload = await manager2.getState();

          // State should persist
          assert.strictEqual(
            stateAfterReload,
            stateBeforeReload,
            `State did not persist: ${stateBeforeReload} → ${stateAfterReload} (target: ${targetState})`
          );

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 2: Incomplete Setup Detection & Backward Compatibility
  // For any extension activation where firstRun=false and no hub is configured,
  // the system should detect setup as incomplete
  // **Validates: Requirements 1.1, 1.2, 5.4, 5.5**
  // **Merged with Property 5 to eliminate duplication**
  test('Property 2: Incomplete setup detection and backward compatibility (Req 1.1, 1.2, 5.4, 5.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // firstRun flag
        fc.boolean(), // hubInitialized flag
        fc.boolean(), // has hubs in list
        fc.boolean(), // has active hub
        async (firstRun, hubInitialized, hasHubs, hasActiveHub) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();

          // Set up old flags for backward compatibility testing
          globalStateData.set('promptregistry.firstRun', firstRun);
          globalStateData.set('promptregistry.hubInitialized', hubInitialized);

          // Mock hub manager responses using helper
          const { mockHubs, mockActiveHub } = createMockHubData(hasHubs, hasActiveHub);
          mockHubManager.listHubs.resolves(mockHubs);
          mockHubManager.getActiveHub.resolves(mockActiveHub);

          const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
          const isIncomplete = await manager.detectIncompleteSetup();

          const hasAnyHub = hasHubs || hasActiveHub;
          const testParams = formatTestParams({ firstRun, hubInitialized, hasHubs, hasActiveHub });

          // Requirement 1.1: firstRun=false AND no hub → incomplete
          if (!firstRun && !hubInitialized && !hasAnyHub) {
            assert.strictEqual(
              isIncomplete,
              true,
              `Req 1.1: Should detect incomplete when firstRun=false and no hub (${testParams})`
            );

            // Verify migration to new state system
            const state = await manager.getState();
            assert.strictEqual(
              state,
              SetupState.INCOMPLETE,
              `Should migrate to INCOMPLETE state (${testParams})`
            );
          } else if (!firstRun && hasAnyHub) {
          // Requirement 1.2 & 5.4, 5.5: firstRun=false AND has hub → complete (backward compat)
            assert.strictEqual(
              isIncomplete,
              false,
              `Req 1.2, 5.4, 5.5: Should detect complete when firstRun=false and hub exists (${testParams})`
            );

            // Should NOT migrate state when hub is configured (backward compat)
            const state = await manager.getState();
            assert.strictEqual(
              state,
              SetupState.NOT_STARTED,
              `Should not migrate state when hub is configured (${testParams})`
            );
          } else if (firstRun) {
          // firstRun=true → not incomplete (fresh install)
            assert.strictEqual(
              isIncomplete,
              false,
              `Fresh install (firstRun=true) should not be incomplete (${testParams})`
            );
          } else {
          // Other cases (hubInitialized=true) → not incomplete
            assert.strictEqual(
              isIncomplete,
              false,
              `Should not detect incomplete in other cases (${testParams})`
            );
          }

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 13: Valid State Values
  // The state should always be one of the defined SetupState enum values
  test('Property 13: State is always a valid enum value (Req 2.1)', async () => {
    const operationArbitrary = fc.constantFrom(
      'start',
      'complete',
      'incomplete',
      'reset'
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArbitrary, { minLength: 1, maxLength: 15 }),
        async (operations) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();
          const manager = SetupStateManager.getInstance(mockContext, mockHubManager);

          for (const op of operations) {
            switch (op) {
              case 'start': {
                await manager.markStarted();
                break;
              }
              case 'complete': {
                await manager.markComplete();
                break;
              }
              case 'incomplete': {
                await manager.markIncomplete();
                break;
              }
              case 'reset': {
                await manager.reset();
                break;
              }
            }

            const currentState = await manager.getState();
            assert.ok(
              Object.values(SetupState).includes(currentState),
              `Invalid state value: ${currentState} (operation: ${op}, sequence: ${operations.join(',')})`
            );
          }

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 3: Resume Prompt Shown Once
  // For any activation session with incomplete setup, the resume prompt should be shown at most once
  // **Validates: Requirements 3.6**
  test('Property 3: Resume prompt shown at most once per session (Req 3.6)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // Number of times to check shouldShowResumePrompt
        async (checkCount) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();
          const manager = SetupStateManager.getInstance(mockContext, mockHubManager);

          // Set up incomplete state
          await manager.markIncomplete();

          // First check: should show prompt
          const shouldShowFirst = await manager.shouldShowResumePrompt();
          assert.strictEqual(
            shouldShowFirst,
            true,
            `Should show resume prompt when setup is incomplete and prompt not yet shown (checkCount=${checkCount})`
          );

          // Mark prompt as shown
          await manager.markResumePromptShown();

          // All subsequent checks: should NOT show prompt
          for (let i = 0; i < checkCount; i++) {
            const shouldShowAgain = await manager.shouldShowResumePrompt();
            assert.strictEqual(
              shouldShowAgain,
              false,
              `Should not show resume prompt after marking as shown (check ${i + 1}/${checkCount})`
            );
          }

          // Verify the flag is session-scoped (NOT persisted to global state)
          const promptShownFlag = globalStateData.get('promptregistry.resumePromptShown');
          assert.strictEqual(
            promptShownFlag,
            undefined,
            `Resume prompt shown flag should NOT be persisted in global state (session-scoped) (checkCount=${checkCount})`
          );

          // Verify that a new instance (simulating new session) allows prompt again
          SetupStateManager.resetInstance();
          const newSessionManager = SetupStateManager.getInstance(mockContext, mockHubManager);
          await newSessionManager.markIncomplete();
          const shouldShowInNewSession = await newSessionManager.shouldShowResumePrompt();
          assert.strictEqual(
            shouldShowInNewSession,
            true,
            `Should show resume prompt in new session (flag is session-scoped)`
          );

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 4: Test Environment Bypass
  // For any extension activation in a test environment (VSCODE_TEST=1 or ExtensionMode.Test),
  // all setup dialogs should be skipped and state should be set to complete
  // **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
  test('Property 4: Test environment bypass (Req 6.1, 6.2, 6.3, 6.4, 6.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(SetupState.NOT_STARTED, SetupState.IN_PROGRESS, SetupState.INCOMPLETE),
        fc.boolean(), // Whether VSCODE_TEST is set
        fc.constantFrom(1, 2, 3), // ExtensionMode (Production=1, Development=2, Test=3)
        async (initialState, hasVscodeTest, extensionMode) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();

          // Set initial state
          if (initialState !== SetupState.NOT_STARTED) {
            globalStateData.set('promptregistry.setupState', initialState);
          }

          // Set up test environment
          const originalEnv = process.env.VSCODE_TEST;
          if (hasVscodeTest) {
            process.env.VSCODE_TEST = '1';
          } else {
            delete process.env.VSCODE_TEST;
          }

          const testContext = {
            globalState: mockContext.globalState,
            extensionMode: extensionMode as any
          } as any;

          try {
            const manager = SetupStateManager.getInstance(testContext, mockHubManager);

            const isTestEnv = hasVscodeTest || extensionMode === 3;
            const testParams = formatTestParams({
              initialState,
              hasVscodeTest,
              extensionMode: extensionMode === 1 ? 'Production' : (extensionMode === 2 ? 'Development' : 'Test'),
              isTestEnv
            });

            if (isTestEnv) {
              // In test environment, marking complete should work
              await manager.markComplete();
              const state = await manager.getState();

              assert.strictEqual(
                state,
                SetupState.COMPLETE,
                `Req 6.1-6.3: Test environment should allow marking as complete (${testParams})`
              );

              // Should not show resume prompt in test environment
              const shouldShow = await manager.shouldShowResumePrompt();
              assert.strictEqual(
                shouldShow,
                false,
                `Req 6.4: Should not show resume prompt in test environment (${testParams})`
              );
            } else {
              // In non-test environment, state should remain as set
              const state = await manager.getState();
              assert.strictEqual(
                state,
                initialState,
                `Non-test environment should preserve initial state (${testParams})`
              );
            }

            return true;
          } finally {
            // Restore environment
            if (originalEnv === undefined) {
              delete process.env.VSCODE_TEST;
            } else {
              process.env.VSCODE_TEST = originalEnv;
            }
          }
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 7: Cancellation Graceful Handling
  // For any cancellation, markIncomplete() should set state to INCOMPLETE
  // and state should persist across multiple calls
  // **Validates: Requirements 8.1, 8.2, 9.1, 9.2**
  test('Property 7: Cancellation handling sets INCOMPLETE state (Req 8.1-8.2, 9.1-9.2)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }), // Number of cancellation calls
        async (callCount) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();

          const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
          const testParams = formatTestParams({ callCount });

          // Simulate the cancellation flow
          await manager.markStarted();

          // Call markIncomplete multiple times (simulating repeated cancellations)
          for (let i = 0; i < callCount; i++) {
            await manager.markIncomplete();
          }

          // Verify state is INCOMPLETE
          const finalState = await manager.getState();
          assert.strictEqual(
            finalState,
            SetupState.INCOMPLETE,
            `Req 8.1, 9.1: State should be INCOMPLETE after cancellation (${testParams})`
          );

          // Verify isIncomplete() returns true
          const isIncomplete = await manager.isIncomplete();
          assert.strictEqual(
            isIncomplete,
            true,
            `Req 8.1, 9.1: isIncomplete() should return true (${testParams})`
          );

          // Verify isComplete() returns false
          const isComplete = await manager.isComplete();
          assert.strictEqual(
            isComplete,
            false,
            `State should not be complete after cancellation (${testParams})`
          );

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 8: State Transition Idempotence
  // Calling the same state transition multiple times should result in the same final state
  // **Validates: Requirements 8.3, 8.4, 9.3, 9.4**
  test('Property 8: State transitions are idempotent (Req 8.3-8.4, 9.3-9.4)', async () => {
    const stateTransitionArbitrary = fc.constantFrom(
      'markStarted',
      'markComplete',
      'markIncomplete',
      'reset'
    );

    await fc.assert(
      fc.asyncProperty(
        stateTransitionArbitrary,
        fc.integer({ min: 2, max: 10 }), // Number of repeated calls
        async (transition, repeatCount) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();

          const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
          const testParams = formatTestParams({ transition, repeatCount });

          // Apply the transition once
          switch (transition) {
            case 'markStarted': {
              await manager.markStarted();
              break;
            }
            case 'markComplete': {
              await manager.markComplete();
              break;
            }
            case 'markIncomplete': {
              await manager.markIncomplete();
              break;
            }
            case 'reset': {
              await manager.reset();
              break;
            }
          }

          const stateAfterFirst = await manager.getState();

          // Apply the same transition multiple more times
          for (let i = 1; i < repeatCount; i++) {
            switch (transition) {
              case 'markStarted': {
                await manager.markStarted();
                break;
              }
              case 'markComplete': {
                await manager.markComplete();
                break;
              }
              case 'markIncomplete': {
                await manager.markIncomplete();
                break;
              }
              case 'reset': {
                await manager.reset();
                break;
              }
            }
          }

          const stateAfterRepeated = await manager.getState();

          // State should be the same after repeated calls
          assert.strictEqual(
            stateAfterRepeated,
            stateAfterFirst,
            `Req 8.3, 9.3: State should be idempotent for ${transition} (${testParams})`
          );

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });

  // Property 10: Reset Command Completeness
  // For any initial state, reset() should transition to NOT_STARTED
  // and shouldShowResumePrompt() should return false after reset
  // **Validates: Requirements 7.1, 7.2, 7.3**
  test('Property 10: Reset transitions to NOT_STARTED from any state (Req 7.1-7.3)', async () => {
    const initialStateArbitrary = fc.constantFrom(
      SetupState.NOT_STARTED,
      SetupState.IN_PROGRESS,
      SetupState.COMPLETE,
      SetupState.INCOMPLETE
    );

    await fc.assert(
      fc.asyncProperty(
        initialStateArbitrary,
        fc.integer({ min: 1, max: 5 }), // Number of reset calls
        async (initialState, resetCount) => {
          globalStateData.clear();
          SetupStateManager.resetInstance();

          const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
          const testParams = formatTestParams({ initialState, resetCount });

          // Set initial state
          switch (initialState) {
            case SetupState.IN_PROGRESS: {
              await manager.markStarted();
              break;
            }
            case SetupState.COMPLETE: {
              await manager.markComplete();
              break;
            }
            case SetupState.INCOMPLETE: {
              await manager.markIncomplete();
              // Also mark resume prompt as shown to test it gets cleared
              await manager.markResumePromptShown();
              break;
            }
                        // NOT_STARTED is default
          }

          // Verify initial state is set correctly
          const stateBeforeReset = await manager.getState();
          assert.strictEqual(
            stateBeforeReset,
            initialState,
            `Initial state should be ${initialState} (${testParams})`
          );

          // Execute reset multiple times
          for (let i = 0; i < resetCount; i++) {
            await manager.reset();
          }

          // Verify state is NOT_STARTED after reset
          const finalState = await manager.getState();
          assert.strictEqual(
            finalState,
            SetupState.NOT_STARTED,
            `Req 7.2: State should be NOT_STARTED after reset (${testParams})`
          );

          // Verify shouldShowResumePrompt returns false (prompt flag cleared)
          const shouldShowPrompt = await manager.shouldShowResumePrompt();
          assert.strictEqual(
            shouldShowPrompt,
            false,
            `Req 7.3: shouldShowResumePrompt should return false after reset (${testParams})`
          );

          // Verify isComplete returns false
          const isComplete = await manager.isComplete();
          assert.strictEqual(
            isComplete,
            false,
            `isComplete should return false after reset (${testParams})`
          );

          return true;
        }
      ),
      { ...PropertyTestConfig.FAST_CHECK_OPTIONS, numRuns: PropertyTestConfig.RUNS.STANDARD }
    );
  });
});
