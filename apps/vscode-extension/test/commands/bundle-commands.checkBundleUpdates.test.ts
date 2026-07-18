/**
 * Tests for BundleCommands.checkBundleUpdates bug fix
 *
 * This test suite covers the fix for the issue where "Check for Bundle Updates"
 * was directly installing updates instead of showing what updates are available.
 *
 * Bug: Right-clicking "Check for Bundle Updates" directly installed the latest version
 * Fix: Added checkSingleBundleUpdate() method that shows dialog with update options
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleCommands,
} from '../../src/commands/bundle-commands';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  BundleBuilder,
  createMockUpdateCheckResult as createMockUpdate,
  resetBundleCommandsMocks,
  setupNoUpdatesAvailable,
  setupProgressMock,
  setupUpdateAvailable,
} from '../helpers/bundle-test-helpers';

suite('BundleCommands - Check Bundle Updates Fix', () => {
  // ===== Test Setup =====
  let sandbox: sinon.SinonSandbox;
  let mockRegistryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let bundleCommands: BundleCommands;
  let mockShowQuickPick: sinon.SinonStub;
  let mockWithProgress: sinon.SinonStub;
  let mockShowInformationMessage: sinon.SinonStub;

  // ===== Test Utilities =====
  // Using shared utilities from bundleTestHelpers

  const resetAllMocks = (): void => {
    resetBundleCommandsMocks(
      mockRegistryManager,
      mockShowQuickPick,
      mockShowInformationMessage,
      mockWithProgress
    );
  };

  // ===== Test Lifecycle =====
  setup(() => {
    sandbox = sinon.createSandbox();
    mockRegistryManager = sandbox.createStubInstance(RegistryManager);
    bundleCommands = new BundleCommands(mockRegistryManager);

    // Mock VS Code APIs
    mockShowQuickPick = sandbox.stub(vscode.window, 'showQuickPick');
    mockShowInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage');
    mockWithProgress = setupProgressMock(sandbox);

    // Setup default mock for listInstalledBundles to prevent viewBundle errors
    mockRegistryManager.listInstalledBundles.resolves([]);
  });

  teardown(() => {
    sandbox.restore();
  });

  // ===== Test Suites =====
  suite('checkAllUpdates() - Existing Behavior', () => {
    test('should check for updates and show selection dialog when updates available', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      setupUpdateAvailable(mockRegistryManager, bundleId);
      mockShowQuickPick.resolves([{
        label: 'Test Bundle',
        description: '1.0.0 → 2.0.0',
        detail: 'Update available',
        update: createMockUpdate(bundleId, '1.0.0', '2.0.0'),
        name: 'Test Bundle'
      }]);

      // Act
      await bundleCommands.checkAllUpdates();

      // Assert - Should check for updates
      assert.strictEqual(mockRegistryManager.checkUpdates.callCount, 1, 'Should call checkUpdates');

      // Assert - Should show quick pick with updates
      assert.strictEqual(mockShowQuickPick.callCount, 1, 'Should show quick pick');
      const quickPickCall = mockShowQuickPick.getCall(0);
      assert.strictEqual(quickPickCall.args[1].placeHolder, '1 update(s) available');
      assert.strictEqual(quickPickCall.args[1].canPickMany, true);

      // Assert - Should call updateBundle for selected items
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1, 'Should call updateBundle');
      assert.strictEqual(mockRegistryManager.updateBundle.getCall(0).args[0], bundleId);
    });

    test('should show "up to date" message when no updates available', async () => {
      // Arrange
      setupNoUpdatesAvailable(mockRegistryManager);

      // Act
      await bundleCommands.checkAllUpdates();

      // Assert
      assert.strictEqual(mockRegistryManager.checkUpdates.callCount, 1, 'Should call checkUpdates');
      assert.strictEqual(mockShowInformationMessage.callCount, 1, 'Should show info message');
      assert.strictEqual(mockShowInformationMessage.getCall(0).args[0], 'All bundles are up to date!');
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 0, 'Should not call updateBundle');
    });
  });

  suite('Bug Reproduction - Original Issue', () => {
    test('REPRODUCES BUG: updateBundle() directly installs without showing options', async () => {
      // This test reproduces the original bug where checking for updates on a single bundle
      // directly calls updateBundle() instead of just checking and showing options

      // Arrange
      const bundleId = 'test-bundle';
      setupUpdateAvailable(mockRegistryManager, bundleId);

      // Mock the updateBundle method to track if it's called
      const updateBundleSpy = sandbox.spy(bundleCommands, 'updateBundle');

      // Act - This simulates the OLD buggy behavior
      await bundleCommands.updateBundle(bundleId);

      // Assert - This demonstrates the bug
      assert.strictEqual(updateBundleSpy.callCount, 1, 'BUG: updateBundle was called directly');
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1, 'BUG: Bundle was updated without user confirmation');

      // The bug is that we never showed the user what updates are available
      assert.strictEqual(mockShowQuickPick.callCount, 0, 'BUG: No selection dialog was shown');
    });

    test('DEMONSTRATES: old vs new command behavior', async () => {
      // This test demonstrates the difference between the old buggy behavior
      // and the new fixed behavior

      const bundleId = 'test-bundle';

      // Setup for old behavior test
      setupUpdateAvailable(mockRegistryManager, bundleId);

      // OLD BEHAVIOR (buggy): updateBundle() called directly
      await bundleCommands.updateBundle(bundleId);

      // Verify old behavior: direct update, no dialog asking user
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1,
        'OLD: updateBundle() directly updates without asking user');
      assert.strictEqual(mockShowInformationMessage.callCount, 1,
        'OLD: Only shows success message, no update dialog');

      // Reset for new behavior test
      resetAllMocks();
      setupUpdateAvailable(mockRegistryManager, bundleId);
      mockShowInformationMessage.resolves('Update Now');

      // NEW BEHAVIOR (fixed): checkSingleBundleUpdate() shows dialog first
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Verify new behavior: shows dialog first, then updates only if user confirms
      assert.strictEqual(mockRegistryManager.checkUpdates.callCount, 1,
        'NEW: Checks for updates first');
      assert.strictEqual(mockShowInformationMessage.callCount, 2,
        'NEW: Shows update dialog + success message');
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1,
        'NEW: Updates only after user confirmation');
    });
  });

  suite('Fixed Behavior - checkSingleBundleUpdate()', () => {
    test('FIXED: shows update dialog with options before updating', async () => {
      // This test verifies the fix for the bug

      // Arrange
      const bundleId = 'test-bundle';
      setupUpdateAvailable(mockRegistryManager, bundleId);
      mockShowInformationMessage.resolves('Update Now');

      // Act - Use the new method that shows a dialog
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Assert - Should check for updates
      assert.strictEqual(mockRegistryManager.checkUpdates.callCount, 1, 'Should call checkUpdates');

      // Assert - Should show information dialog with update details (first call)
      assert.strictEqual(mockShowInformationMessage.callCount, 2, 'Should show update dialog + success message');
      const dialogCall = mockShowInformationMessage.getCall(0);
      assert.strictEqual(dialogCall.args[0], 'Update available for Test Bundle');
      assert.deepStrictEqual(dialogCall.args[1], {
        detail: 'Current: 1.0.0\nLatest: 2.0.0',
        modal: true
      });
      assert.deepStrictEqual(dialogCall.args.slice(2), ['Update Now', 'View Details']);

      // Second call should be the success message from updateBundle
      const successCall = mockShowInformationMessage.getCall(1);
      assert.strictEqual(successCall.args[0], '✓ Test Bundle updated successfully!');

      // Assert - Should only call updateBundle if user chooses "Update Now"
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1, 'Should call updateBundle after user confirmation');
    });

    test('FIXED: shows "up to date" message when no updates available', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      setupNoUpdatesAvailable(mockRegistryManager);

      // Create bundle with correct name using BundleBuilder
      const bundle = BundleBuilder.fromSource(bundleId, 'GITHUB')
        .withVersion('1.0.0')
        .build();
      bundle.name = 'Test Bundle';
      mockRegistryManager.getBundleDetails.withArgs(bundleId).resolves(bundle);

      // Act
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Assert
      assert.strictEqual(mockRegistryManager.checkUpdates.callCount, 1, 'Should call checkUpdates');
      assert.strictEqual(mockShowInformationMessage.callCount, 1, 'Should show info message');
      assert.strictEqual(mockShowInformationMessage.getCall(0).args[0], 'Test Bundle is up to date!');
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 0, 'Should not call updateBundle');
    });

    test('FIXED: does not update when user cancels', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      setupUpdateAvailable(mockRegistryManager, bundleId);
      mockShowInformationMessage.resolves(undefined); // Modal dialog returns undefined when cancelled

      // Act
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Assert
      assert.strictEqual(mockShowInformationMessage.callCount, 1, 'Should show update dialog');
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 0, 'Should not call updateBundle when cancelled');
    });

    test('FIXED: handles "View Details" option', async () => {
      // Arrange
      const bundleId = 'test-bundle';
      setupUpdateAvailable(mockRegistryManager, bundleId);
      mockShowInformationMessage.resolves('View Details');

      // Mock VS Code command execution (View Details uses executeCommand)
      const executeCommandSpy = sandbox.stub(vscode.commands, 'executeCommand').resolves();

      // Act
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Assert
      assert.strictEqual(mockShowInformationMessage.callCount, 1, 'Should show update dialog');
      assert.strictEqual(executeCommandSpy.callCount, 1, 'Should execute viewBundle command');
      assert.strictEqual(executeCommandSpy.getCall(0).args[0], 'promptRegistry.viewBundle', 'Should execute correct command');
      assert.strictEqual(executeCommandSpy.getCall(0).args[1], bundleId, 'Should pass correct bundle ID');
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 0, 'Should not call updateBundle');
    });

    test('FIXED: handles "View Details" with bundle not found gracefully', async () => {
      // Arrange
      const bundleId = 'non-existent-bundle';
      setupUpdateAvailable(mockRegistryManager, bundleId);
      mockShowInformationMessage.resolves('View Details');

      // Mock getBundleDetails to throw error (bundle not found)
      mockRegistryManager.getBundleDetails.withArgs(bundleId).rejects(new Error('Bundle not found'));

      // Mock VS Code command execution and error message
      const executeCommandSpy = sandbox.stub(vscode.commands, 'executeCommand').resolves();

      // Act
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Assert
      assert.strictEqual(mockShowInformationMessage.callCount, 1, 'Should show update dialog');
      assert.strictEqual(executeCommandSpy.callCount, 1, 'Should attempt to execute viewBundle command');
      // Note: The error handling happens inside the viewBundle command, not in the update command
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 0, 'Should not call updateBundle');
    });
  });

  suite('Real-world Scenario - Amadeus Bundle', () => {
    test('FIXED: handles versioned bundle ID correctly', async () => {
      // This test verifies the fix for the specific reported issue:
      // "amadeus-airlines-solutions-workflow-instructions-1.0.17 is up to date!"
      // when there are actually updates available

      // Arrange - Simulate the exact scenario
      const bundleId = 'amadeus-airlines-solutions-workflow-instructions-1.0.17';
      const bundleName = 'Amadeus Airlines Solutions Workflow Instructions';
      const currentVersion = '1.0.17';
      const latestVersion = '1.0.18';

      setupUpdateAvailable(mockRegistryManager, bundleId, bundleName, currentVersion, latestVersion);
      mockShowInformationMessage.resolves('Update Now');

      // Act - Use the FIXED method
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Assert - Verify the fix
      assert.strictEqual(mockRegistryManager.checkUpdates.callCount, 1,
        'Should check for updates');

      assert.strictEqual(mockShowInformationMessage.callCount, 2,
        'Should show update dialog + success message');

      // Verify the update dialog was shown with correct information
      const updateDialogCall = mockShowInformationMessage.getCall(0);
      assert.strictEqual(updateDialogCall.args[0],
        `Update available for ${bundleName}`,
        'Should show correct bundle name in dialog');

      assert.deepStrictEqual(updateDialogCall.args[1], {
        detail: `Current: ${currentVersion}\nLatest: ${latestVersion}`,
        modal: true
      }, 'Should show version comparison in dialog');

      assert.deepStrictEqual(updateDialogCall.args.slice(2),
        ['Update Now', 'View Details'],
        'Should provide user with update options');

      // Verify update was called only after user confirmation
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1,
        'Should update bundle after user confirms');
      assert.strictEqual(mockRegistryManager.updateBundle.getCall(0).args[0], bundleId,
        'Should update the correct bundle');
    });

    test('FIXED: shows correct "up to date" message for versioned bundle', async () => {
      // This test verifies that the "up to date" message is shown correctly
      // when there genuinely are no updates available for a versioned bundle

      // Arrange
      const bundleId = 'amadeus-airlines-solutions-workflow-instructions-1.0.17';
      const bundleName = 'Amadeus Airlines Solutions Workflow Instructions';

      setupNoUpdatesAvailable(mockRegistryManager);

      // Create bundle with correct name using BundleBuilder
      const bundle = BundleBuilder.fromSource(bundleId, 'GITHUB')
        .withVersion('1.0.17')
        .build();
      bundle.name = bundleName;
      mockRegistryManager.getBundleDetails.withArgs(bundleId).resolves(bundle);

      // Act
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Assert
      assert.strictEqual(mockRegistryManager.checkUpdates.callCount, 1,
        'Should check for updates');

      assert.strictEqual(mockShowInformationMessage.callCount, 1,
        'Should show only the "up to date" message');

      assert.strictEqual(mockShowInformationMessage.getCall(0).args[0],
        `${bundleName} is up to date!`,
        'Should show correct "up to date" message with bundle name');

      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 0,
        'Should not attempt to update when no updates available');
    });
  });

  suite('Command Registration Integration', () => {
    test('FIXED: promptRegistry.checkBundleUpdates command uses new behavior', async () => {
      // This test verifies the fix for the command registration bug

      // Arrange
      const bundleId = 'test-bundle';
      setupUpdateAvailable(mockRegistryManager, bundleId);
      mockShowInformationMessage.resolves('Update Now');

      // Act - Simulate the FIXED command behavior
      // Extension now calls: this.bundleCommands!.checkSingleBundleUpdate(bundleId);
      await bundleCommands.checkSingleBundleUpdate(bundleId);

      // Assert - Should show dialog first, then update only if user confirms
      assert.strictEqual(mockShowInformationMessage.callCount, 2, 'FIXED: Shows update dialog + success message');
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1, 'FIXED: Updates only after user confirmation');

      // The user now sees what updates are available and can choose whether to update
    });

    test('COMPARISON: old command behavior vs new command behavior', async () => {
      // This test shows the original buggy behavior for comparison

      // Arrange
      const bundleId = 'test-bundle';
      setupUpdateAvailable(mockRegistryManager, bundleId);

      // Act - Simulate the OLD buggy command behavior
      await bundleCommands.updateBundle(bundleId);

      // Assert - This demonstrates the original bug
      assert.strictEqual(mockRegistryManager.updateBundle.callCount, 1, 'BUG: Bundle was updated without showing check dialog');
      assert.strictEqual(mockShowInformationMessage.callCount, 1, 'BUG: Only shows success message, no update dialog');

      // The success message is shown, but no dialog asking if user wants to update
      const messageCall = mockShowInformationMessage.getCall(0);
      assert.strictEqual(messageCall.args[0], '✓ Test Bundle updated successfully!');

      // The user expected to see what updates are available, but instead
      // the bundle was immediately updated without confirmation
    });
  });
});
