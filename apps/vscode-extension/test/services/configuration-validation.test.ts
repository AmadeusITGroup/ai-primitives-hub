/**
 * Tests for configuration validation in UpdateScheduler and extension.ts
 * Validates: Requirements 6.3
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  UpdateChecker,
} from '../../src/services/update-checker';
import {
  UpdateScheduler,
} from '../../src/services/update-scheduler';
import {
  Logger,
} from '../../src/utils/logger';

suite('Configuration Validation', () => {
  let sandbox: sinon.SinonSandbox;
  let mockUpdateChecker: sinon.SinonStubbedInstance<UpdateChecker>;
  let mockContext: sinon.SinonStubbedInstance<vscode.ExtensionContext>;
  let loggerWarnStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockUpdateChecker = sandbox.createStubInstance(UpdateChecker);
    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      },
      subscriptions: []
    } as any;

    // Stub Logger.warn to capture warnings
    loggerWarnStub = sandbox.stub(Logger.prototype, 'warn');
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('UpdateScheduler Configuration Validation', () => {
    test('should accept valid frequency values', async () => {
      const validFrequencies = ['daily', 'weekly', 'manual'];

      for (const frequency of validFrequencies) {
        // Each scheduler instance is disposed after use to avoid timer leaks.
        // Mock configuration
        const configStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        configStub.withArgs('promptregistry.updateCheck').returns({
          get: sandbox.stub()
            .withArgs('enabled', true).returns(true)
            .withArgs('frequency', 'daily').returns(frequency)
        } as any);

        const scheduler = new UpdateScheduler(mockContext, mockUpdateChecker);
        await scheduler.initialize();

        // Should not log any warnings for valid values
        assert.strictEqual(
          loggerWarnStub.getCalls().filter((call) =>
            call.args[0].includes('Invalid update check frequency')
          ).length,
          0,
          `Should not warn for valid frequency "${frequency}"`
        );

        // Cleanup scheduler to prevent timer leaks
        scheduler.dispose();
        configStub.restore();
        loggerWarnStub.resetHistory();
      }
    });

    test('should fallback to default for invalid frequency', async () => {
      const invalidFrequency = 'hourly';

      // Mock configuration with invalid frequency
      const configStub = sandbox.stub(vscode.workspace, 'getConfiguration');
      configStub.withArgs('promptregistry.updateCheck').returns({
        get: sandbox.stub()
          .withArgs('enabled', true).returns(true)
          .withArgs('frequency', 'daily').returns(invalidFrequency)
      } as any);

      const scheduler = new UpdateScheduler(mockContext, mockUpdateChecker);
      await scheduler.initialize();

      // Should log warning for invalid value
      const warningCalls = loggerWarnStub.getCalls().filter((call) =>
        call.args[0].includes('Invalid update check frequency')
      );

      assert.strictEqual(warningCalls.length, 1, 'Should log warning for invalid frequency');
      assert.ok(
        warningCalls[0].args[0].includes(invalidFrequency),
        'Warning should mention the invalid value'
      );
      assert.ok(
        warningCalls[0].args[0].includes('daily'),
        'Warning should mention the default value'
      );

      // Cleanup scheduler to prevent timer leaks
      scheduler.dispose();
      configStub.restore();
    });

    test('should accept valid notification preferences', async () => {
      const validPreferences = ['all', 'critical', 'none'];

      for (const preference of validPreferences) {
        // Mock configuration
        const configStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        configStub.withArgs('promptregistry.updateCheck').returns({
          get: sandbox.stub()
            .withArgs('enabled', true).returns(true)
            .withArgs('frequency', 'daily').returns('daily')
            .withArgs('notificationPreference', 'all').returns(preference)
        } as any);

        // Mock update checker to return empty results
        mockUpdateChecker.checkForUpdates.resolves([]);

        const scheduler = new UpdateScheduler(mockContext, mockUpdateChecker);
        await scheduler.initialize();

        // Trigger a check to test notification preference validation
        await scheduler.checkNow();

        // Should not log any warnings for valid values
        assert.strictEqual(
          loggerWarnStub.getCalls().filter((call) =>
            call.args[0].includes('Invalid notification preference')
          ).length,
          0,
          `Should not warn for valid preference "${preference}"`
        );

        // Cleanup scheduler to prevent timer leaks
        scheduler.dispose();
        configStub.restore();
        loggerWarnStub.resetHistory();
      }
    });

    test('should fallback to default for invalid notification preference', async () => {
      const invalidPreference = 'some';

      // Mock configuration with invalid preference
      const configStub = sandbox.stub(vscode.workspace, 'getConfiguration');
      configStub.withArgs('promptregistry.updateCheck').returns({
        get: sandbox.stub()
          .withArgs('enabled', true).returns(true)
          .withArgs('frequency', 'daily').returns('daily')
          .withArgs('notificationPreference', 'all').returns(invalidPreference)
      } as any);

      // Mock update checker to return updates (to trigger notification)
      mockUpdateChecker.checkForUpdates.resolves([
        {
          bundleId: 'test-bundle',
          currentVersion: '1.0.0',
          latestVersion: '2.0.0',
          releaseDate: new Date().toISOString(),
          downloadUrl: 'https://example.com/bundle.zip',
          autoUpdateEnabled: false
        }
      ]);

      const scheduler = new UpdateScheduler(mockContext, mockUpdateChecker);
      await scheduler.initialize();

      // Trigger a check to test notification preference validation
      await scheduler.checkNow();

      // Should log warning for invalid value
      const warningCalls = loggerWarnStub.getCalls().filter((call) =>
        call.args[0].includes('Invalid notification preference')
      );

      assert.ok(warningCalls.length > 0, 'Should log warning for invalid preference');
      assert.ok(
        warningCalls[0].args[0].includes(invalidPreference),
        'Warning should mention the invalid value'
      );
      assert.ok(
        warningCalls[0].args[0].includes('all'),
        'Warning should mention the default value'
      );

      // Cleanup scheduler to prevent timer leaks
      scheduler.dispose();
      configStub.restore();
    });
  });

  suite('Type Safety', () => {
    test('should handle non-string frequency values', async () => {
      // Mock configuration with non-string frequency
      const configStub = sandbox.stub(vscode.workspace, 'getConfiguration');
      configStub.withArgs('promptregistry.updateCheck').returns({
        get: sandbox.stub()
          .withArgs('enabled', true).returns(true)
          .withArgs('frequency', 'daily').returns(123) // Invalid type
      } as any);

      const scheduler = new UpdateScheduler(mockContext, mockUpdateChecker);
      await scheduler.initialize();

      // Should log warning and use default
      const warningCalls = loggerWarnStub.getCalls().filter((call) =>
        call.args[0].includes('Invalid update check frequency')
      );

      assert.ok(warningCalls.length > 0, 'Should log warning for non-string value');

      // Cleanup scheduler to prevent timer leaks
      scheduler.dispose();
      configStub.restore();
    });

    test('should handle null/undefined configuration values', async () => {
      // Mock configuration with null values
      const configStub = sandbox.stub(vscode.workspace, 'getConfiguration');
      configStub.withArgs('promptregistry.updateCheck').returns({
        get: sandbox.stub()
          .withArgs('enabled', true).returns(true)
          .withArgs('frequency', 'daily').returns(null)
      } as any);

      const scheduler = new UpdateScheduler(mockContext, mockUpdateChecker);
      await scheduler.initialize();

      // Should log warning and use default
      const warningCalls = loggerWarnStub.getCalls().filter((call) =>
        call.args[0].includes('Invalid update check frequency')
      );

      assert.ok(warningCalls.length > 0, 'Should log warning for null value');

      // Cleanup scheduler to prevent timer leaks
      scheduler.dispose();
      configStub.restore();
    });
  });
});
