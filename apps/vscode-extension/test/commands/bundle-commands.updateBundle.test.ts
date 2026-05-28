/**
 * Integration test for BundleCommands.updateBundle()
 * Reproduces bug where updating a bundle with versioned ID fails after consolidation
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

suite('BundleCommands - updateBundle() Integration', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let registryManager: RegistryManager;
  let bundleCommands: BundleCommands;
  let showInformationMessageStub: sinon.SinonStub;
  let showErrorMessageStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create mock context with in-memory storage
    const globalStateData: Map<string, any> = new Map();

    mockContext = {
      globalState: {
        get: (key: string, defaultValue?: any) => {
          const value = globalStateData.get(key);
          return value === undefined ? defaultValue : value;
        },
        update: (key: string, value: any) => {
          globalStateData.set(key, value);
        },
        keys: () => Array.from(globalStateData.keys()),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/extension/path',
      extensionUri: vscode.Uri.file('/mock/extension/path'),
      environmentVariableCollection: {} as any,
      extensionMode: 3,
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global/storage'),
      logUri: vscode.Uri.file('/mock/log'),
      secrets: {} as any,
      languageModelAccessInformation: {} as any,
      asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
      storagePath: '/mock/storage',
      globalStoragePath: '/mock/global/storage',
      logPath: '/mock/log',
      extension: {} as any
    };

    // Initialize real RegistryManager
    registryManager = RegistryManager.getInstance(mockContext);

    // Create BundleCommands with real RegistryManager
    bundleCommands = new BundleCommands(registryManager);

    // Mock VS Code UI
    showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
    showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage');
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('Bug: Versioned Bundle ID After Consolidation', () => {
    test('should update bundle when installed with versioned ID but consolidated list only has identity', async () => {
      // SETUP: Simulate the real scenario
      const installedBundleId = 'amadeus-airlines-solutions-workflow-instructions-1.0.18';

      // Stub getBundleDetails to fail with versioned ID (simulating consolidation)
      const getBundleDetailsStub = sandbox.stub(registryManager, 'getBundleDetails');
      getBundleDetailsStub
        .withArgs(installedBundleId)
        .rejects(new Error(`Bundle '${installedBundleId}' not found`));

      // Stub updateBundle to succeed (RegistryManager handles identity extraction internally)
      const updateBundleStub = sandbox.stub(registryManager, 'updateBundle');
      updateBundleStub.withArgs(installedBundleId).resolves();

      // Mock success notification
      showInformationMessageStub.resolves(undefined);

      // EXECUTE: Try to update the bundle using the versioned ID
      await bundleCommands.updateBundle(installedBundleId);

      // VERIFY: Should succeed without throwing error
      if (showErrorMessageStub.called) {
        const errorCall = showErrorMessageStub.getCall(0);
        assert.fail(`Unexpected error message: ${errorCall.args[0]}`);
      }

      assert.strictEqual(
        showInformationMessageStub.called,
        true,
        'Should show success message'
      );

      // Verify updateBundle was called
      assert.strictEqual(
        updateBundleStub.calledWith(installedBundleId),
        true,
        'Should call updateBundle with the versioned ID'
      );
    });

    test('should handle updateBundle failure and show error', async () => {
      // SETUP: Bundle that fails to update
      const bundleId = 'failing-bundle-1.0.0';

      // Stub updateBundle to fail
      const updateBundleStub = sandbox.stub(registryManager, 'updateBundle');
      updateBundleStub.withArgs(bundleId).rejects(new Error('Update failed'));

      // EXECUTE: Try to update bundle
      await bundleCommands.updateBundle(bundleId);

      // VERIFY: Should show error message
      assert.strictEqual(
        showErrorMessageStub.called,
        true,
        'Should show error message'
      );

      const errorCall = showErrorMessageStub.getCall(0);
      assert.ok(
        errorCall.args[0].includes('Update failed'),
        'Error message should indicate update failure'
      );
    });
  });
});
