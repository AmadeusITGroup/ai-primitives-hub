/**
 * ScopeConflictResolver Unit Tests
 *
 * Tests for the service that migrates bundles between scopes
 * with rollback capability.
 *
 * Requirements: 6.4-6.6
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  ScopeConflictResolver,
} from '../../src/services/scope-conflict-resolver';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  InstallationScope,
} from '../../src/types/registry';
import {
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';

suite('ScopeConflictResolver', () => {
  let sandbox: sinon.SinonSandbox;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let resolver: ScopeConflictResolver;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    resolver = new ScopeConflictResolver(mockStorage);
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('migrateBundle()', () => {
    let mockUninstallCallback: sinon.SinonStub;
    let mockInstallCallback: sinon.SinonStub;

    setup(() => {
      mockUninstallCallback = sandbox.stub();
      mockInstallCallback = sandbox.stub();
    });

    test('should successfully migrate bundle from user to repository scope', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const fromScope: InstallationScope = 'user';
      const toScope: InstallationScope = 'repository';
      const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', { scope: fromScope });

      mockStorage.getInstalledBundle.withArgs(bundleId, fromScope).resolves(installedBundle);
      mockUninstallCallback.resolves();
      mockInstallCallback.resolves();

      // Act
      const result = await resolver.migrateBundle(
        bundleId,
        fromScope,
        toScope,
        mockUninstallCallback,
        mockInstallCallback
      );

      // Assert
      assert.ok(result.success, 'Migration should succeed');
      assert.strictEqual(result.bundleId, bundleId);
      assert.strictEqual(result.fromScope, fromScope);
      assert.strictEqual(result.toScope, toScope);
      assert.ok(mockUninstallCallback.calledOnce, 'Uninstall should be called once');
      assert.ok(mockInstallCallback.calledOnce, 'Install should be called once');
      assert.ok(mockUninstallCallback.calledBefore(mockInstallCallback), 'Uninstall should be called before install');
    });

    test('should successfully migrate bundle from repository to user scope', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const fromScope: InstallationScope = 'repository';
      const toScope: InstallationScope = 'user';
      const installedBundle = createMockInstalledBundle(bundleId, '2.0.0', { scope: fromScope });

      mockStorage.getInstalledBundle.withArgs(bundleId, fromScope).resolves(installedBundle);
      mockUninstallCallback.resolves();
      mockInstallCallback.resolves();

      // Act
      const result = await resolver.migrateBundle(
        bundleId,
        fromScope,
        toScope,
        mockUninstallCallback,
        mockInstallCallback
      );

      // Assert
      assert.ok(result.success, 'Migration should succeed');
      assert.strictEqual(result.fromScope, fromScope);
      assert.strictEqual(result.toScope, toScope);
    });

    test('should fail migration when bundle is not installed at source scope', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      mockStorage.getInstalledBundle.resolves(undefined);

      // Act
      const result = await resolver.migrateBundle(
        bundleId,
        'user',
        'repository',
        mockUninstallCallback,
        mockInstallCallback
      );

      // Assert
      assert.strictEqual(result.success, false, 'Migration should fail');
      assert.ok(result.error, 'Should have error message');
      assert.ok(result.error.includes('not installed'), 'Error should mention bundle not installed');
      assert.ok(!mockUninstallCallback.called, 'Uninstall should not be called');
      assert.ok(!mockInstallCallback.called, 'Install should not be called');
    });

    test('should fail migration when uninstall fails', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', { scope: 'user' });

      mockStorage.getInstalledBundle.withArgs(bundleId, 'user').resolves(installedBundle);
      mockUninstallCallback.rejects(new Error('Uninstall failed'));

      // Act
      const result = await resolver.migrateBundle(
        bundleId,
        'user',
        'repository',
        mockUninstallCallback,
        mockInstallCallback
      );

      // Assert
      assert.strictEqual(result.success, false, 'Migration should fail');
      assert.ok(result.error, 'Should have error message');
      assert.ok(result.error.includes('Uninstall failed'), 'Error should contain original error');
      assert.ok(!mockInstallCallback.called, 'Install should not be called after uninstall failure');
    });

    test('should fail migration when install fails', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', { scope: 'user' });

      mockStorage.getInstalledBundle.withArgs(bundleId, 'user').resolves(installedBundle);
      mockUninstallCallback.resolves();
      mockInstallCallback.rejects(new Error('Install failed'));

      // Act
      const result = await resolver.migrateBundle(
        bundleId,
        'user',
        'repository',
        mockUninstallCallback,
        mockInstallCallback
      );

      // Assert
      assert.strictEqual(result.success, false, 'Migration should fail');
      assert.ok(result.error, 'Should have error message');
      assert.ok(result.error.includes('Install failed'), 'Error should contain original error');
    });

    test('should pass installed bundle info to callbacks', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', {
        scope: 'user',
        sourceId: 'github-source'
      });

      mockStorage.getInstalledBundle.withArgs(bundleId, 'user').resolves(installedBundle);
      mockUninstallCallback.resolves();
      mockInstallCallback.resolves();

      // Act
      await resolver.migrateBundle(
        bundleId,
        'user',
        'repository',
        mockUninstallCallback,
        mockInstallCallback
      );

      // Assert
      assert.ok(mockUninstallCallback.calledWith(installedBundle), 'Uninstall should receive installed bundle');
      assert.ok(mockInstallCallback.calledWith(installedBundle, 'repository'), 'Install should receive bundle and target scope');
    });

    suite('rollback behavior', () => {
      test('should attempt rollback when install fails after successful uninstall', async () => {
        // Arrange
        const bundleId = 'test-bundle';
        const fromScope: InstallationScope = 'user';
        const toScope: InstallationScope = 'repository';
        const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', { scope: fromScope });

        mockStorage.getInstalledBundle.withArgs(bundleId, fromScope).resolves(installedBundle);
        mockUninstallCallback.resolves();
        // First call (install at target) fails, second call (rollback) succeeds
        mockInstallCallback.onFirstCall().rejects(new Error('Install failed'));
        mockInstallCallback.onSecondCall().resolves();

        // Act
        const result = await resolver.migrateBundle(
          bundleId,
          fromScope,
          toScope,
          mockUninstallCallback,
          mockInstallCallback
        );

        // Assert
        assert.strictEqual(result.success, false, 'Migration should fail');
        assert.strictEqual(result.rollbackAttempted, true, 'Rollback should be attempted');
        assert.strictEqual(result.rollbackSucceeded, true, 'Rollback should succeed');
        assert.ok(result.error!.includes('Rollback successful'), 'Error should indicate rollback success');
        assert.ok(result.error!.includes('restored at user'), 'Error should mention original scope');
        assert.strictEqual(mockInstallCallback.callCount, 2, 'Install should be called twice (target + rollback)');
      });

      test('should report rollback failure when both install and rollback fail', async () => {
        // Arrange
        const bundleId = 'test-bundle';
        const fromScope: InstallationScope = 'user';
        const toScope: InstallationScope = 'repository';
        const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', { scope: fromScope });

        mockStorage.getInstalledBundle.withArgs(bundleId, fromScope).resolves(installedBundle);
        mockUninstallCallback.resolves();
        // Both install attempts fail
        mockInstallCallback.onFirstCall().rejects(new Error('Install failed'));
        mockInstallCallback.onSecondCall().rejects(new Error('Rollback install failed'));

        // Act
        const result = await resolver.migrateBundle(
          bundleId,
          fromScope,
          toScope,
          mockUninstallCallback,
          mockInstallCallback
        );

        // Assert
        assert.strictEqual(result.success, false, 'Migration should fail');
        assert.strictEqual(result.rollbackAttempted, true, 'Rollback should be attempted');
        assert.strictEqual(result.rollbackSucceeded, false, 'Rollback should fail');
        assert.ok(result.error!.includes('Rollback also failed'), 'Error should indicate rollback failure');
        assert.ok(result.error!.includes('inconsistent state'), 'Error should warn about inconsistent state');
        assert.strictEqual(mockInstallCallback.callCount, 2, 'Install should be called twice');
      });

      test('should call rollback with original scope', async () => {
        // Arrange
        const bundleId = 'test-bundle';
        const fromScope: InstallationScope = 'repository';
        const toScope: InstallationScope = 'user';
        const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', { scope: fromScope });

        mockStorage.getInstalledBundle.withArgs(bundleId, fromScope).resolves(installedBundle);
        mockUninstallCallback.resolves();
        mockInstallCallback.onFirstCall().rejects(new Error('Install failed'));
        mockInstallCallback.onSecondCall().resolves();

        // Act
        await resolver.migrateBundle(
          bundleId,
          fromScope,
          toScope,
          mockUninstallCallback,
          mockInstallCallback
        );

        // Assert - verify rollback was called with original scope
        const secondCall = mockInstallCallback.getCall(1);
        assert.ok(secondCall, 'Second install call should exist');
        assert.strictEqual(secondCall.args[1], fromScope, 'Rollback should use original scope');
      });

      test('should preserve original bundle state on successful rollback', async () => {
        // Arrange
        const bundleId = 'test-bundle';
        const fromScope: InstallationScope = 'user';
        const toScope: InstallationScope = 'repository';
        const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', {
          scope: fromScope,
          sourceId: 'github-source'
        });

        mockStorage.getInstalledBundle.withArgs(bundleId, fromScope).resolves(installedBundle);
        mockUninstallCallback.resolves();
        mockInstallCallback.onFirstCall().rejects(new Error('Install failed'));
        mockInstallCallback.onSecondCall().resolves();

        // Act
        await resolver.migrateBundle(
          bundleId,
          fromScope,
          toScope,
          mockUninstallCallback,
          mockInstallCallback
        );

        // Assert - verify rollback was called with the same bundle info
        const rollbackCall = mockInstallCallback.getCall(1);
        assert.deepStrictEqual(rollbackCall.args[0], installedBundle, 'Rollback should use original bundle info');
      });

      test('should not attempt rollback when uninstall fails', async () => {
        // Arrange
        const bundleId = 'test-bundle';
        const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', { scope: 'user' });

        mockStorage.getInstalledBundle.withArgs(bundleId, 'user').resolves(installedBundle);
        mockUninstallCallback.rejects(new Error('Uninstall failed'));

        // Act
        const result = await resolver.migrateBundle(
          bundleId,
          'user',
          'repository',
          mockUninstallCallback,
          mockInstallCallback
        );

        // Assert
        assert.strictEqual(result.success, false, 'Migration should fail');
        assert.strictEqual(result.rollbackAttempted, undefined, 'Rollback should not be attempted');
        assert.strictEqual(result.rollbackSucceeded, undefined, 'Rollback succeeded should not be set');
        assert.ok(!mockInstallCallback.called, 'Install should not be called');
      });

      test('should not set rollback fields on successful migration', async () => {
        // Arrange
        const bundleId = 'test-bundle';
        const installedBundle = createMockInstalledBundle(bundleId, '1.0.0', { scope: 'user' });

        mockStorage.getInstalledBundle.withArgs(bundleId, 'user').resolves(installedBundle);
        mockUninstallCallback.resolves();
        mockInstallCallback.resolves();

        // Act
        const result = await resolver.migrateBundle(
          bundleId,
          'user',
          'repository',
          mockUninstallCallback,
          mockInstallCallback
        );

        // Assert
        assert.strictEqual(result.success, true, 'Migration should succeed');
        assert.strictEqual(result.rollbackAttempted, undefined, 'Rollback attempted should not be set');
        assert.strictEqual(result.rollbackSucceeded, undefined, 'Rollback succeeded should not be set');
      });
    });
  });
});
