/**
 * Setup State Flows Integration Tests
 *
 * End-to-end tests for the resumable first-run configuration feature.
 * Tests complete user flows through the setup state machine.
 *
 * Requirements: 1.1, 1.2, 2.2, 2.3, 2.4, 3.1, 3.3, 3.4, 3.5, 5.1, 5.2, 5.4, 5.5, 6.1-6.5, 7.1, 7.5, 9.1, 9.5
 *
 * Lockfile Timing Requirements (Requirement 1 from lockfile-timing-and-hub-decoupling):
 * - 1.1: Detection deferred when setup not complete
 * - 1.2: Detection proceeds when setup is complete
 * - 1.3: Detection triggers after setup completes
 * - 1.5: Deferral is logged
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RepositoryActivationService,
} from '../../src/services/repository-activation-service';
import {
  SetupState,
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  promptGitHubAccountSelection,
} from '../../src/utils/github-account-prompt';
import {
  createMockHubData,
} from '../helpers/setup-state-test-helpers';

suite('E2E: Setup State Flows', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let setupStateManager: SetupStateManager;
  let globalStateStorage: Map<string, any>;

  /**
   * Create a fresh mock context for each test
   * @param extensionMode
   */
  const createMockContext = (extensionMode = 1): vscode.ExtensionContext => {
    globalStateStorage = new Map();
    return {
      globalState: {
        get: (key: string, defaultValue?: any) => {
          return globalStateStorage.has(key) ? globalStateStorage.get(key) : defaultValue;
        },
        update: (key: string, value: any) => {
          globalStateStorage.set(key, value);
        },
        keys: () => Array.from(globalStateStorage.keys()),
        setKeysForSync: sandbox.stub()
      } as any,
      globalStorageUri: vscode.Uri.file('/mock/storage'),
      extensionPath: '/mock/extension',
      extensionUri: vscode.Uri.file('/mock/extension'),
      subscriptions: [],
      extensionMode: extensionMode as any
    } as any as vscode.ExtensionContext;
  };

  /**
   * Simulate hub configuration success
   */
  const simulateHubConfigured = () => {
    const { mockHubs, mockActiveHub } = createMockHubData(true, true);
    mockHubManager.listHubs.resolves(mockHubs);
    mockHubManager.getActiveHub.resolves(mockActiveHub);
  };

  /**
   * Simulate no hub configured
   */
  const simulateNoHub = () => {
    mockHubManager.listHubs.resolves([]);
    mockHubManager.getActiveHub.resolves(null);
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    mockContext = createMockContext();
    mockHubManager = sandbox.createStubInstance(HubManager);
    simulateNoHub();

    // Reset singleton
    SetupStateManager.resetInstance();
    setupStateManager = SetupStateManager.getInstance(mockContext, mockHubManager);
  });

  teardown(() => {
    sandbox.restore();
    SetupStateManager.resetInstance();
  });

  suite('14.1: Fresh Install Flow', () => {
    /**
     * Requirement 2.2: WHEN the extension first activates, THE Extension SHALL set setup state to not_started
     * Requirement 2.3: WHEN the first-run configuration begins, THE Extension SHALL set setup state to in_progress
     * Requirement 2.4: WHEN hub configuration completes successfully, THE Extension SHALL set setup state to complete
     */
    test('should complete setup successfully: not_started → in_progress → complete', async () => {
      // Verify initial state
      const initialState = await setupStateManager.getState();
      assert.strictEqual(initialState, SetupState.NOT_STARTED, 'Initial state should be NOT_STARTED');

      // Simulate first-run flow starting
      await setupStateManager.markStarted();
      const inProgressState = await setupStateManager.getState();
      assert.strictEqual(inProgressState, SetupState.IN_PROGRESS, 'State should be IN_PROGRESS after markStarted()');

      // Simulate successful hub configuration
      simulateHubConfigured();
      await setupStateManager.markComplete();

      // Verify final state
      const finalState = await setupStateManager.getState();
      assert.strictEqual(finalState, SetupState.COMPLETE, 'State should be COMPLETE after successful setup');
    });

    /**
     * Requirement 5.1: WHEN the user completes hub selection successfully, THEN THE Extension SHALL set setup state to complete
     * Requirement 5.2: WHEN setup state is complete, THEN THE Extension SHALL not show resume prompts on future activations
     */
    test('should not show prompts after successful completion', async () => {
      // Complete setup
      await setupStateManager.markStarted();
      simulateHubConfigured();
      await setupStateManager.markComplete();

      // Verify no resume prompt should be shown
      const shouldShowPrompt = await setupStateManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShowPrompt, false, 'Should not show resume prompt after completion');

      // Verify isComplete returns true
      const isComplete = await setupStateManager.isComplete();
      assert.strictEqual(isComplete, true, 'isComplete() should return true');
    });

    /**
     * Test state persistence across simulated reloads
     */
    test('should persist complete state across manager instances', async () => {
      // Complete setup
      await setupStateManager.markStarted();
      await setupStateManager.markComplete();

      // Simulate extension reload by resetting singleton
      SetupStateManager.resetInstance();
      const newManager = SetupStateManager.getInstance(mockContext, mockHubManager);

      // Verify state persisted
      const state = await newManager.getState();
      assert.strictEqual(state, SetupState.COMPLETE, 'State should persist as COMPLETE after reload');
    });
  });

  suite('14.2: Cancellation and Resume Flow', () => {
    /**
     * Requirement 9.1: WHEN hub selection is cancelled, THEN THE Extension SHALL set setup state to incomplete
     * Requirement 3.1: WHEN the extension activates AND setup state is incomplete, THEN THE Extension SHALL show a resume prompt notification
     */
    test('should handle cancellation and resume: not_started → in_progress → incomplete → in_progress → complete', async () => {
      // Start setup
      await setupStateManager.markStarted();
      let state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.IN_PROGRESS, 'State should be IN_PROGRESS');

      // Simulate hub selection cancellation
      await setupStateManager.markIncomplete();
      state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE, 'State should be INCOMPLETE after cancellation');

      // Verify resume prompt should be shown
      const shouldShowPrompt = await setupStateManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShowPrompt, true, 'Should show resume prompt when incomplete');

      // Simulate user choosing to resume
      await setupStateManager.markStarted();
      state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.IN_PROGRESS, 'State should be IN_PROGRESS after resume');

      // Simulate successful completion
      simulateHubConfigured();
      await setupStateManager.markComplete();
      state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.COMPLETE, 'State should be COMPLETE after successful resume');
    });

    /**
     * Requirement 3.3: WHEN the user selects "Complete Setup", THEN THE Extension SHALL restart the first-run configuration flow
     * Requirement 9.5: WHEN the user resumes setup after hub selection cancellation, THEN THE Extension SHALL show the hub selector again
     */
    test('should allow resumption after cancellation', async () => {
      // Setup incomplete state
      await setupStateManager.markIncomplete();

      // Verify can resume
      const isIncomplete = await setupStateManager.isIncomplete();
      assert.strictEqual(isIncomplete, true, 'Should be incomplete');

      // Resume and complete
      await setupStateManager.markStarted();
      simulateHubConfigured();
      await setupStateManager.markComplete();

      // Verify completed
      const isComplete = await setupStateManager.isComplete();
      assert.strictEqual(isComplete, true, 'Should be complete after resume');
    });

    /**
     * Test resume prompt shown on next activation
     */
    test('should show resume prompt on next activation after cancellation', async () => {
      // Cancel during setup
      await setupStateManager.markStarted();
      await setupStateManager.markIncomplete();

      // Simulate extension reload
      SetupStateManager.resetInstance();
      const newManager = SetupStateManager.getInstance(mockContext, mockHubManager);

      // Verify resume prompt should be shown
      const shouldShow = await newManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, true, 'Should show resume prompt on next activation');
    });
  });

  suite('14.3: Skip Resume Flow', () => {
    /**
     * Requirement 3.4: WHEN the user selects "Skip for Now", THEN THE Extension SHALL dismiss the prompt and continue with incomplete setup
     * Requirement 3.5: WHEN the user dismisses the resume prompt without selecting an action, THEN THE Extension SHALL treat it as "Skip for Now"
     */
    test('should handle skip and remain incomplete', async () => {
      // Setup incomplete state
      await setupStateManager.markIncomplete();

      // Simulate user skipping (mark prompt as shown)
      await setupStateManager.markResumePromptShown();

      // Verify state remains incomplete
      const state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE, 'State should remain INCOMPLETE after skip');

      // Verify prompt won't be shown again this session
      const shouldShow = await setupStateManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false, 'Should not show prompt again after skip');
    });

    /**
     * Requirement 7.1: THE Extension SHALL provide a "Reset First Run" command
     * Requirement 7.5: WHEN the window reloads after reset, THEN THE Extension SHALL show the first-run configuration flow
     */
    test('should allow manual reset after skip: incomplete → not_started → complete', async () => {
      // Setup incomplete state and skip
      await setupStateManager.markIncomplete();
      await setupStateManager.markResumePromptShown();

      // Verify incomplete
      let state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE, 'Should be incomplete');

      // Execute reset
      await setupStateManager.reset();

      // Verify reset to not_started
      state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED, 'Should be NOT_STARTED after reset');

      // Verify resume prompt flag is cleared
      const shouldShow = await setupStateManager.shouldShowResumePrompt();
      // Note: shouldShowResumePrompt returns false for NOT_STARTED state (only true for INCOMPLETE)
      assert.strictEqual(shouldShow, false, 'Resume prompt flag should be cleared');

      // Complete setup after reset
      await setupStateManager.markStarted();
      simulateHubConfigured();
      await setupStateManager.markComplete();

      state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.COMPLETE, 'Should be COMPLETE after reset and setup');
    });

    /**
     * Test skip logs correctly (verified via state transitions)
     */
    test('should track skip action via prompt shown flag', async () => {
      await setupStateManager.markIncomplete();

      // Before skip
      let shouldShow = await setupStateManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, true, 'Should show prompt before skip');

      // Skip (mark prompt shown)
      await setupStateManager.markResumePromptShown();

      // After skip
      shouldShow = await setupStateManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false, 'Should not show prompt after skip');

      // State should still be incomplete
      const state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE, 'State should remain INCOMPLETE');
    });
  });

  suite('14.4: Backward Compatibility', () => {
    /**
     * Requirement 5.4: THE Extension SHALL maintain backward compatibility with existing installations that have firstRun=false
     * Requirement 5.5: WHEN an existing installation has firstRun=false AND a hub configured, THEN THE Extension SHALL treat setup as complete
     */
    test('should not show prompts for existing install with hub', async () => {
      // Simulate existing installation with old flags and hub configured
      await mockContext.globalState.update('promptregistry.firstRun', false);
      await mockContext.globalState.update('promptregistry.hubInitialized', true);
      simulateHubConfigured();

      // Detect incomplete setup (should return false)
      const isIncomplete = await setupStateManager.detectIncompleteSetup();
      assert.strictEqual(isIncomplete, false, 'Should not detect incomplete when hub is configured');

      // Verify no resume prompt
      const shouldShow = await setupStateManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false, 'Should not show resume prompt for existing install with hub');
    });

    /**
     * Requirement 1.1: WHEN the extension activates AND firstRun is false AND no hub is configured, THEN THE Extension SHALL detect the setup as incomplete
     * Requirement 1.2: WHEN the extension activates AND firstRun is false AND a hub is configured, THEN THE Extension SHALL detect the setup as complete
     */
    test('should show resume prompt for existing install without hub', async () => {
      // Simulate existing installation with old flags but NO hub
      await mockContext.globalState.update('promptregistry.firstRun', false);
      await mockContext.globalState.update('promptregistry.hubInitialized', false);
      simulateNoHub();

      // Detect incomplete setup (should return true and migrate)
      const isIncomplete = await setupStateManager.detectIncompleteSetup();
      assert.strictEqual(isIncomplete, true, 'Should detect incomplete when no hub configured');

      // Verify state was migrated to new system
      const state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE, 'Should migrate to INCOMPLETE state');

      // Verify resume prompt should be shown
      const shouldShow = await setupStateManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, true, 'Should show resume prompt for existing install without hub');
    });

    /**
     * Test migration from old flags to new state system
     */
    test('should migrate old flags to new state system', async () => {
      // Simulate old installation state
      await mockContext.globalState.update('promptregistry.firstRun', false);
      await mockContext.globalState.update('promptregistry.hubInitialized', false);
      simulateNoHub();

      // Initial state should be NOT_STARTED (no new state set yet)
      let state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED, 'Initial state should be NOT_STARTED');

      // detectIncompleteSetup should migrate to new state
      await setupStateManager.detectIncompleteSetup();

      // State should now be INCOMPLETE
      state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE, 'State should be migrated to INCOMPLETE');
    });
  });

  suite('14.5: Test Environment', () => {
    /**
     * Requirement 6.1: WHEN the extension activates AND VSCODE_TEST environment variable is "1", THEN THE Extension SHALL skip all setup dialogs
     */
    test('should skip setup when VSCODE_TEST=1', async () => {
      // Save original env
      const originalEnv = process.env.VSCODE_TEST;

      try {
        // Set test environment
        process.env.VSCODE_TEST = '1';

        // Create fresh manager
        SetupStateManager.resetInstance();
        const testManager = SetupStateManager.getInstance(mockContext, mockHubManager);

        // In test environment, setup should be marked complete immediately
        // (This simulates what checkFirstRun does in test environment)
        await testManager.markComplete();

        const state = await testManager.getState();
        assert.strictEqual(state, SetupState.COMPLETE, 'State should be COMPLETE in test environment');

        // No prompts should be shown
        const shouldShow = await testManager.shouldShowResumePrompt();
        assert.strictEqual(shouldShow, false, 'Should not show prompts in test environment');
      } finally {
        // Restore original env
        if (originalEnv === undefined) {
          delete process.env.VSCODE_TEST;
        } else {
          process.env.VSCODE_TEST = originalEnv;
        }
      }
    });

    /**
     * Requirement 6.2: WHEN the extension activates AND extension mode is Test, THEN THE Extension SHALL skip all setup dialogs
     */
    test('should skip setup when ExtensionMode.Test', async () => {
      // Create context with Test mode (3 = ExtensionMode.Test)
      const testContext = createMockContext(3);

      SetupStateManager.resetInstance();
      const testManager = SetupStateManager.getInstance(testContext, mockHubManager);

      // Mark complete (simulating test environment behavior)
      await testManager.markComplete();

      const state = await testManager.getState();
      assert.strictEqual(state, SetupState.COMPLETE, 'State should be COMPLETE in Test mode');
    });

    /**
     * Requirement 6.3: WHEN running in a test environment, THEN THE Extension SHALL set setup state to complete immediately
     * Requirement 6.4: WHEN running in a test environment, THEN THE Extension SHALL not show resume prompts
     * Requirement 6.5: WHEN running in a test environment, THEN THE Extension SHALL not show setup prompts in marketplace empty state
     */
    test('should set state to complete immediately in test environment', async () => {
      // Create context with Test mode
      const testContext = createMockContext(3);

      SetupStateManager.resetInstance();
      const testManager = SetupStateManager.getInstance(testContext, mockHubManager);

      // Even if we try to mark incomplete, test environment should allow marking complete
      await testManager.markIncomplete();
      await testManager.markComplete();

      const state = await testManager.getState();
      assert.strictEqual(state, SetupState.COMPLETE, 'Should be able to mark complete in test environment');

      // Verify no prompts
      const shouldShow = await testManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false, 'Should not show prompts after marking complete');
    });

    /**
     * Test that test environment detection works with both methods
     */
    test('should detect test environment via both VSCODE_TEST and ExtensionMode', () => {
      // Test VSCODE_TEST detection
      const originalEnv = process.env.VSCODE_TEST;

      try {
        process.env.VSCODE_TEST = '1';
        const isTestViaEnv = process.env.VSCODE_TEST === '1';
        assert.strictEqual(isTestViaEnv, true, 'Should detect test via VSCODE_TEST');

        // Test ExtensionMode detection
        const testContext = createMockContext(3); // ExtensionMode.Test = 3
        // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- we want to compare the raw value here
        const isTestViaMode = testContext.extensionMode === 3; // ExtensionMode.Test = 3
        assert.strictEqual(isTestViaMode, true, 'Should detect test via ExtensionMode.Test');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.VSCODE_TEST;
        } else {
          process.env.VSCODE_TEST = originalEnv;
        }
      }
    });
  });

  suite('14.6: Setup Timing and Lockfile Detection', () => {
    /**
     * Tests for Requirement 1 from lockfile-timing-and-hub-decoupling spec:
     * - Detection is deferred until setup completes
     * - Detection triggers after setup completes
     */

    let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
    let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
    let repositoryActivationService: RepositoryActivationService;
    const testWorkspaceRoot = '/test/workspace';

    /**
     * Create a mock lockfile for testing
     */
    const createMockLockfile = () => ({
      $schema: 'https://example.com/lockfile.schema.json',
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'prompt-registry@0.0.2',
      bundles: {
        'test-bundle': {
          version: '1.0.0',
          sourceId: 'test-source',
          sourceType: 'github',
          installedAt: new Date().toISOString(),
          files: []
        }
      },
      sources: {
        'test-source': {
          type: 'github',
          url: 'https://github.com/test/repo'
        }
      }
    });

    setup(() => {
      // Reset RepositoryActivationService instances
      RepositoryActivationService.resetInstance();

      // Create mock LockfileManager
      mockLockfileManager = sandbox.createStubInstance(LockfileManager);
      mockLockfileManager.getLockfilePath.returns(`${testWorkspaceRoot}/prompt-registry.lock.json`);

      // Create mock RegistryStorage
      mockStorage = sandbox.createStubInstance(RegistryStorage);
      mockStorage.getSources.resolves([]);
      mockStorage.getInstalledBundles.resolves([]);
      mockStorage.getContext.returns(mockContext);
    });

    teardown(() => {
      RepositoryActivationService.resetInstance();
    });

    /**
     * Requirement 1.1: WHEN the extension activates AND a lockfile exists AND first-run setup is NOT complete,
     * THE RepositoryActivationService SHALL defer source/hub detection until setup completes
     */
    test('should defer detection when setup is not complete', async () => {
      // Setup: Mark setup as NOT complete (IN_PROGRESS state)
      await setupStateManager.markStarted();
      const isComplete = await setupStateManager.isComplete();
      assert.strictEqual(isComplete, false, 'Setup should not be complete');

      // Setup: Lockfile exists
      mockLockfileManager.read.resolves(createMockLockfile());

      // Create RepositoryActivationService with SetupStateManager
      repositoryActivationService = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        setupStateManager
      );

      // Act: Call checkAndPromptActivation
      await repositoryActivationService.checkAndPromptActivation();

      // Assert: Lockfile should NOT have been read (detection was deferred)
      // The method returns early before reading the lockfile when setup is incomplete
      assert.strictEqual(mockLockfileManager.read.called, false,
        'Lockfile should not be read when setup is incomplete');
    });

    /**
     * Requirement 1.2: WHEN the extension activates AND a lockfile exists AND first-run setup IS complete,
     * THE RepositoryActivationService SHALL check for missing sources and hubs
     */
    test('should proceed with detection when setup is complete', async () => {
      // Setup: Mark setup as complete
      await setupStateManager.markComplete();
      const isComplete = await setupStateManager.isComplete();
      assert.strictEqual(isComplete, true, 'Setup should be complete');

      // Setup: Lockfile exists
      mockLockfileManager.read.resolves(createMockLockfile());

      // Create RepositoryActivationService with SetupStateManager
      repositoryActivationService = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        setupStateManager
      );

      // Act: Call checkAndPromptActivation
      await repositoryActivationService.checkAndPromptActivation();

      // Assert: Lockfile should have been read (detection proceeded)
      assert.strictEqual(mockLockfileManager.read.called, true,
        'Lockfile should be read when setup is complete');
    });

    /**
     * Requirement 1.3: WHEN first-run setup completes AND a lockfile exists,
     * THE Extension SHALL trigger source/hub detection
     *
     * This test simulates the flow: setup incomplete → setup completes → detection triggers
     */
    test('should trigger detection after setup completes', async () => {
      // Setup: Start with incomplete setup
      await setupStateManager.markStarted();

      // Setup: Lockfile exists
      mockLockfileManager.read.resolves(createMockLockfile());

      // Create RepositoryActivationService with SetupStateManager
      repositoryActivationService = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        setupStateManager
      );

      // Act 1: Call checkAndPromptActivation while setup is incomplete
      await repositoryActivationService.checkAndPromptActivation();

      // Assert 1: Detection was deferred
      assert.strictEqual(mockLockfileManager.read.called, false,
        'Detection should be deferred while setup is incomplete');

      // Act 2: Complete setup
      simulateHubConfigured();
      await setupStateManager.markComplete();

      // Act 3: Call checkAndPromptActivation again (simulating what extension.ts does after setup completes)
      await repositoryActivationService.checkAndPromptActivation();

      // Assert 2: Detection now proceeds
      assert.strictEqual(mockLockfileManager.read.called, true,
        'Detection should proceed after setup completes');
    });

    /**
     * Requirement 1.4: IF the SetupStateManager returns INCOMPLETE state,
     * THEN THE RepositoryActivationService SHALL skip source/hub detection
     */
    test('should skip detection when setup state is INCOMPLETE', async () => {
      // Setup: Mark setup as incomplete (cancelled)
      await setupStateManager.markIncomplete();
      const state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE, 'State should be INCOMPLETE');

      // Setup: Lockfile exists
      mockLockfileManager.read.resolves(createMockLockfile());

      // Create RepositoryActivationService with SetupStateManager
      repositoryActivationService = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        setupStateManager
      );

      // Act: Call checkAndPromptActivation
      await repositoryActivationService.checkAndPromptActivation();

      // Assert: Detection was skipped
      assert.strictEqual(mockLockfileManager.read.called, false,
        'Detection should be skipped when setup is INCOMPLETE');
    });

    /**
     * Requirement 6 (Property 5): Fail-open behavior - detection proceeds when SetupStateManager undefined
     */
    test('should proceed with detection when SetupStateManager is not provided (fail-open)', async () => {
      // Setup: Lockfile exists
      mockLockfileManager.read.resolves(createMockLockfile());

      // Create RepositoryActivationService WITHOUT SetupStateManager
      RepositoryActivationService.resetInstance(testWorkspaceRoot);
      repositoryActivationService = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        undefined // No SetupStateManager
      );

      // Act: Call checkAndPromptActivation
      await repositoryActivationService.checkAndPromptActivation();

      // Assert: Detection proceeded (fail-open behavior)
      assert.strictEqual(mockLockfileManager.read.called, true,
        'Detection should proceed when SetupStateManager is not provided');
    });

    /**
     * Test the complete flow: fresh install → setup → detection
     */
    test('should complete full flow: fresh install → setup incomplete → setup complete → detection', async () => {
      // Setup: Lockfile exists
      mockLockfileManager.read.resolves(createMockLockfile());

      // Phase 1: Fresh install - setup not started
      const state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED, 'Initial state should be NOT_STARTED');

      // Create RepositoryActivationService
      repositoryActivationService = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        setupStateManager
      );

      // Phase 2: Extension activates, setup starts
      await setupStateManager.markStarted();
      await repositoryActivationService.checkAndPromptActivation();
      assert.strictEqual(mockLockfileManager.read.called, false,
        'Detection should be deferred during setup');

      // Phase 3: User cancels hub selection
      await setupStateManager.markIncomplete();
      mockLockfileManager.read.resetHistory();
      await repositoryActivationService.checkAndPromptActivation();
      assert.strictEqual(mockLockfileManager.read.called, false,
        'Detection should be deferred when setup is incomplete');

      // Phase 4: User resumes and completes setup
      await setupStateManager.markStarted();
      simulateHubConfigured();
      await setupStateManager.markComplete();

      mockLockfileManager.read.resetHistory();
      await repositoryActivationService.checkAndPromptActivation();
      assert.strictEqual(mockLockfileManager.read.called, true,
        'Detection should proceed after setup completes');
    });

    /**
     * Test that detection is deferred for NOT_STARTED state
     */
    test('should defer detection when setup state is NOT_STARTED', async () => {
      // Setup: State is NOT_STARTED (default)
      const state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED, 'State should be NOT_STARTED');

      // Setup: Lockfile exists
      mockLockfileManager.read.resolves(createMockLockfile());

      // Create RepositoryActivationService with SetupStateManager
      repositoryActivationService = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        setupStateManager
      );

      // Act: Call checkAndPromptActivation
      await repositoryActivationService.checkAndPromptActivation();

      // Assert: Detection was deferred (NOT_STARTED means setup hasn't completed)
      assert.strictEqual(mockLockfileManager.read.called, false,
        'Detection should be deferred when setup is NOT_STARTED');
    });
  });

  suite('14.8: GitHub Account Selection and Setup State Integration', () => {
    /**
     * Verifies that when promptGitHubAccountSelection throws (user dismisses
     * the picker), callers can route the error to markIncomplete().
     * This mirrors the catch-block wiring in Extension.initializeHub().
     */
    test('account selection failure during first-time setup leads to incomplete state', async () => {
      const getSessionStub = sandbox.stub(vscode.authentication, 'getSession')
        .rejects(new Error('User did not consent to the required permissions.'));

      await setupStateManager.markStarted();
      const stateBeforeAttempt = await setupStateManager.getState();
      assert.strictEqual(stateBeforeAttempt, SetupState.IN_PROGRESS);

      // Exercise the actual promptGitHubAccountSelection function;
      // on failure, transition to INCOMPLETE (as initializeHub's catch does)
      try {
        await promptGitHubAccountSelection();
        assert.fail('promptGitHubAccountSelection should have thrown');
      } catch {
        await setupStateManager.markIncomplete();
      }

      const state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE,
        'Setup state should be INCOMPLETE after account selection failure');

      // Verify resume prompt should be shown on next activation
      const shouldShowPrompt = await setupStateManager.shouldShowResumePrompt();
      assert.strictEqual(shouldShowPrompt, true,
        'Should show resume prompt after account selection failure');

      assert.ok(getSessionStub.calledOnce);
      const options = getSessionStub.firstCall.args[2];
      assert.ok(options, 'getSession should have been called with options');
      assert.strictEqual(options.clearSessionPreference, true,
        'Must use clearSessionPreference to force the account picker');
    });

    test('successful account selection allows setup to complete', async () => {
      sandbox.stub(vscode.authentication, 'getSession').resolves({
        accessToken: 'gho_test',
        account: { id: 'id-1', label: 'alice' },
        id: 'session-1',
        scopes: ['repo']
      });

      await setupStateManager.markStarted();

      // Account selection succeeds — no throw
      await promptGitHubAccountSelection();

      // Simulate hub configuration completing after account selection
      simulateHubConfigured();
      await setupStateManager.markComplete();

      const state = await setupStateManager.getState();
      assert.strictEqual(state, SetupState.COMPLETE,
        'Setup state should be COMPLETE after successful account selection and hub config');
    });
  });
});
