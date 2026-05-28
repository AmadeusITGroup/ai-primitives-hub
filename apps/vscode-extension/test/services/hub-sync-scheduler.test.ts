/**
 * HubSyncScheduler Unit Tests
 * Tests for periodic hub sync scheduling
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  HubSyncScheduler,
} from '../../src/services/hub-sync-scheduler';

suite('HubSyncScheduler', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;
  let mockContext: vscode.ExtensionContext;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let scheduler: HubSyncScheduler;
  let disposables: vscode.Disposable[];

  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  const originalEnv = process.env.HUB_SYNC_SCHEDULER_ALLOW_TIMERS_IN_TESTS;

  setup(() => {
    sandbox = sinon.createSandbox();
    clock = sinon.useFakeTimers();

    // Allow timers in tests so we can exercise the scheduling logic
    process.env.HUB_SYNC_SCHEDULER_ALLOW_TIMERS_IN_TESTS = 'true';

    disposables = [];
    mockContext = {
      subscriptions: disposables,
      globalState: {} as any,
      extensionPath: '/mock/path'
    } as any;

    mockHubManager = sandbox.createStubInstance(HubManager);
    mockHubManager.syncActiveHub.resolves();
  });

  teardown(() => {
    scheduler?.dispose();
    clock.restore();
    sandbox.restore();

    if (originalEnv === undefined) {
      delete process.env.HUB_SYNC_SCHEDULER_ALLOW_TIMERS_IN_TESTS;
    } else {
      process.env.HUB_SYNC_SCHEDULER_ALLOW_TIMERS_IN_TESTS = originalEnv;
    }
  });

  suite('initialize()', () => {
    test('should schedule periodic sync', async () => {
      scheduler = new HubSyncScheduler(mockContext, mockHubManager);
      scheduler.initialize();

      // Advance 24h — should trigger sync
      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 1);
    });

    test('should not schedule if already initialized', async () => {
      scheduler = new HubSyncScheduler(mockContext, mockHubManager);
      scheduler.initialize();
      scheduler.initialize(); // second call is a no-op

      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 1);
    });
  });

  suite('periodic sync', () => {
    test('should call hubManager.syncActiveHub() on each tick', async () => {
      scheduler = new HubSyncScheduler(mockContext, mockHubManager);
      scheduler.initialize();

      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 1);

      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 2);
    });

    test('should skip cycle if previous sync is still in progress', async () => {
      // Make syncActiveHub hang until we resolve it
      let resolveSync: () => void;
      mockHubManager.syncActiveHub.callsFake(() => new Promise<void>((resolve) => {
        resolveSync = resolve;
      }));

      scheduler = new HubSyncScheduler(mockContext, mockHubManager);
      scheduler.initialize();

      // Trigger first sync (will hang)
      clock.tick(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 1);

      // Trigger second cycle while first is in progress — should be skipped
      clock.tick(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 1);

      // Resolve the first sync
      resolveSync!();
      await clock.tickAsync(0);

      // Now the next cycle should work
      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 2);
    });

    test('should continue scheduling after sync error', async () => {
      mockHubManager.syncActiveHub
        .onFirstCall().rejects(new Error('Network error'))
        .onSecondCall().resolves();

      scheduler = new HubSyncScheduler(mockContext, mockHubManager);
      scheduler.initialize();

      // First tick — fails
      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 1);

      // Second tick — should still fire despite previous error
      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 2);
    });
  });

  suite('dispose()', () => {
    test('should clear scheduled timer', async () => {
      scheduler = new HubSyncScheduler(mockContext, mockHubManager);
      scheduler.initialize();

      scheduler.dispose();

      // Advance time — no sync should fire
      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 0);
    });

    test('should register on context.subscriptions for auto-disposal', () => {
      scheduler = new HubSyncScheduler(mockContext, mockHubManager);
      assert.strictEqual(disposables.length, 1);
    });
  });

  suite('test environment', () => {
    test('should skip timers in test environment', async () => {
      delete process.env.HUB_SYNC_SCHEDULER_ALLOW_TIMERS_IN_TESTS;

      scheduler = new HubSyncScheduler(mockContext, mockHubManager);
      scheduler.initialize();

      await clock.tickAsync(TWENTY_FOUR_HOURS_MS);
      assert.strictEqual(mockHubManager.syncActiveHub.callCount, 0);
    });
  });
});
