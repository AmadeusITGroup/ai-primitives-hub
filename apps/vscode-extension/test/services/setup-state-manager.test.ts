/**
 * Unit tests for SetupStateManager
 * Tests specific examples and edge cases
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  SetupState,
  SetupStateManager,
} from '../../src/services/setup-state-manager';

suite('SetupStateManager - Unit Tests', () => {
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

  suite('getInstance()', () => {
    test('should return singleton instance', () => {
      const instance1 = SetupStateManager.getInstance(mockContext, mockHubManager);
      const instance2 = SetupStateManager.getInstance(mockContext, mockHubManager);

      assert.strictEqual(instance1, instance2, 'Should return same instance');
    });

    test('should create new instance after reset', () => {
      const instance1 = SetupStateManager.getInstance(mockContext, mockHubManager);
      SetupStateManager.resetInstance();
      const instance2 = SetupStateManager.getInstance(mockContext, mockHubManager);

      assert.notStrictEqual(instance1, instance2, 'Should return new instance after reset');
    });

    test('should throw error when context is missing on first call', () => {
      SetupStateManager.resetInstance();
      assert.throws(
        () => SetupStateManager.getInstance(undefined, mockHubManager),
        /SetupStateManager requires context and hubManager on first call/
      );
    });

    test('should throw error when hubManager is missing on first call', () => {
      SetupStateManager.resetInstance();
      assert.throws(
        () => SetupStateManager.getInstance(mockContext, undefined),
        /SetupStateManager requires context and hubManager on first call/
      );
    });

    test('should return existing instance without parameters after first call', () => {
      const instance1 = SetupStateManager.getInstance(mockContext, mockHubManager);
      const instance2 = SetupStateManager.getInstance(); // No parameters

      assert.strictEqual(instance1, instance2, 'Should return same instance without parameters');
    });
  });

  suite('getState()', () => {
    test('should return NOT_STARTED by default', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      const state = await manager.getState();

      assert.strictEqual(state, SetupState.NOT_STARTED);
    });

    test('should return stored state', async () => {
      globalStateData.set('promptregistry.setupState', SetupState.COMPLETE);
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      const state = await manager.getState();

      assert.strictEqual(state, SetupState.COMPLETE);
    });

    test('should return NOT_STARTED for invalid state value', async () => {
      globalStateData.set('promptregistry.setupState', 'invalid_state');
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      const state = await manager.getState();

      assert.strictEqual(state, SetupState.NOT_STARTED);
    });
  });

  suite('isComplete()', () => {
    test('should return true when state is COMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markComplete();

      const isComplete = await manager.isComplete();
      assert.strictEqual(isComplete, true);
    });

    test('should return false when state is not COMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markStarted();

      const isComplete = await manager.isComplete();
      assert.strictEqual(isComplete, false);
    });
  });

  suite('isIncomplete()', () => {
    test('should return true when state is INCOMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markIncomplete();

      const isIncomplete = await manager.isIncomplete();
      assert.strictEqual(isIncomplete, true);
    });

    test('should return false when state is not INCOMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markComplete();

      const isIncomplete = await manager.isIncomplete();
      assert.strictEqual(isIncomplete, false);
    });
  });

  suite('markStarted()', () => {
    test('should transition to IN_PROGRESS', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markStarted();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.IN_PROGRESS);
    });

    test('should persist state', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markStarted();

      const storedState = globalStateData.get('promptregistry.setupState');
      assert.strictEqual(storedState, SetupState.IN_PROGRESS);
    });
  });

  suite('markComplete()', () => {
    test('should transition to COMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markComplete();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.COMPLETE);
    });
  });

  suite('markIncomplete()', () => {
    test('should transition to INCOMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markIncomplete();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE);
    });
  });

  suite('reset()', () => {
    test('should transition to NOT_STARTED', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markComplete();
      await manager.reset();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED);
    });

    test('should reset resume prompt shown flag (in-memory)', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markIncomplete();
      await manager.markResumePromptShown();

      // Verify flag is set (prompt should not show)
      let shouldShow = await manager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false, 'Should be false after marking shown');

      // Reset
      await manager.reset();

      // Flag should be reset (prompt should show again after marking incomplete)
      await manager.markIncomplete();
      shouldShow = await manager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, true, 'Should be true after reset');
    });
  });

  suite('detectIncompleteSetup()', () => {
    test('should return true when state is INCOMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markIncomplete();

      const isIncomplete = await manager.detectIncompleteSetup();
      assert.strictEqual(isIncomplete, true);
    });

    test('should return false when state is COMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markComplete();

      const isIncomplete = await manager.detectIncompleteSetup();
      assert.strictEqual(isIncomplete, false);
    });

    test('should detect incomplete from old flags (firstRun=false, no hub)', async () => {
      globalStateData.set('promptregistry.firstRun', false);
      globalStateData.set('promptregistry.hubInitialized', false);
      mockHubManager.listHubs.resolves([]);
      mockHubManager.getActiveHub.resolves(null);

      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      const isIncomplete = await manager.detectIncompleteSetup();

      assert.strictEqual(isIncomplete, true);
      // Should migrate to new state system
      const state = await manager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE);
    });

    test('should not detect incomplete when hub exists (backward compat)', async () => {
      globalStateData.set('promptregistry.firstRun', false);
      globalStateData.set('promptregistry.hubInitialized', false);
      mockHubManager.listHubs.resolves([{ id: 'hub1', name: 'Hub 1' }] as any);

      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      const isIncomplete = await manager.detectIncompleteSetup();

      assert.strictEqual(isIncomplete, false);
    });
  });

  suite('shouldShowResumePrompt()', () => {
    test('should return true when incomplete and prompt not shown', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markIncomplete();

      const shouldShow = await manager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, true);
    });

    test('should return false when incomplete but prompt already shown', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markIncomplete();
      await manager.markResumePromptShown();

      const shouldShow = await manager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false);
    });

    test('should return false when setup is complete', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markComplete();

      const shouldShow = await manager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false);
    });
  });

  suite('markResumePromptShown()', () => {
    test('should set resume prompt shown flag in-memory only', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markResumePromptShown();

      // Should NOT be persisted to globalState
      const promptShown = globalStateData.get('promptregistry.resumePromptShown');
      assert.strictEqual(promptShown, undefined, 'Should not persist to globalState');

      // But should affect shouldShowResumePrompt
      await manager.markIncomplete();
      const shouldShow = await manager.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false, 'Should remember within same instance');
    });

    test('should reset flag when instance is reset (session-scoped)', async () => {
      const manager1 = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager1.markIncomplete();
      await manager1.markResumePromptShown();

      // Verify flag is set
      let shouldShow = await manager1.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, false, 'Should be false after marking shown');

      // Reset instance (simulate new session)
      SetupStateManager.resetInstance();
      const manager2 = SetupStateManager.getInstance(mockContext, mockHubManager);

      // Flag should be reset
      shouldShow = await manager2.shouldShowResumePrompt();
      assert.strictEqual(shouldShow, true, 'Should be true in new instance (flag reset)');
    });
  });

  suite('state persistence', () => {
    test('should persist state across manager instances', async () => {
      const manager1 = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager1.markIncomplete();

      SetupStateManager.resetInstance();
      const manager2 = SetupStateManager.getInstance(mockContext, mockHubManager);
      const state = await manager2.getState();

      assert.strictEqual(state, SetupState.INCOMPLETE);
    });
  });

  suite('reset() from different states', () => {
    test('should reset from INCOMPLETE state', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markIncomplete();

      await manager.reset();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED);
    });

    test('should reset from IN_PROGRESS state', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markStarted();

      await manager.reset();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED);
    });

    test('should reset from COMPLETE state', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
      await manager.markComplete();

      await manager.reset();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED);
    });
  });

  suite('state flow scenarios', () => {
    test('should handle fresh install flow: NOT_STARTED → IN_PROGRESS → COMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);

      // Initial state
      let state = await manager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED);

      // Start setup
      await manager.markStarted();
      state = await manager.getState();
      assert.strictEqual(state, SetupState.IN_PROGRESS);

      // Complete setup
      await manager.markComplete();
      state = await manager.getState();
      assert.strictEqual(state, SetupState.COMPLETE);
    });

    test('should handle cancellation flow: NOT_STARTED → IN_PROGRESS → INCOMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);

      await manager.markStarted();
      await manager.markIncomplete();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.INCOMPLETE);
      assert.strictEqual(await manager.isIncomplete(), true);
    });

    test('should handle resume flow: INCOMPLETE → IN_PROGRESS → COMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);

      // Start incomplete
      await manager.markIncomplete();

      // Resume
      await manager.markStarted();
      let state = await manager.getState();
      assert.strictEqual(state, SetupState.IN_PROGRESS);

      // Complete
      await manager.markComplete();
      state = await manager.getState();
      assert.strictEqual(state, SetupState.COMPLETE);
    });

    test('should handle skip and reset flow: INCOMPLETE → NOT_STARTED → COMPLETE', async () => {
      const manager = SetupStateManager.getInstance(mockContext, mockHubManager);

      // Start incomplete and skip
      await manager.markIncomplete();
      await manager.markResumePromptShown();

      // Reset
      await manager.reset();
      let state = await manager.getState();
      assert.strictEqual(state, SetupState.NOT_STARTED);

      // Complete after reset
      await manager.markStarted();
      await manager.markComplete();
      state = await manager.getState();
      assert.strictEqual(state, SetupState.COMPLETE);
    });
  });

  suite('test environment detection', () => {
    test('should allow marking complete in test environment (VSCODE_TEST)', async () => {
      const originalEnv = process.env.VSCODE_TEST;
      try {
        process.env.VSCODE_TEST = '1';

        const manager = SetupStateManager.getInstance(mockContext, mockHubManager);
        await manager.markComplete();

        const state = await manager.getState();
        assert.strictEqual(state, SetupState.COMPLETE);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.VSCODE_TEST;
        } else {
          process.env.VSCODE_TEST = originalEnv;
        }
      }
    });

    test('should allow marking complete in ExtensionMode.Test', async () => {
      const testContext = {
        ...mockContext,
        extensionMode: 3 // ExtensionMode.Test
      } as vscode.ExtensionContext;

      SetupStateManager.resetInstance();
      const manager = SetupStateManager.getInstance(testContext, mockHubManager);
      await manager.markComplete();

      const state = await manager.getState();
      assert.strictEqual(state, SetupState.COMPLETE);
    });
  });
});
