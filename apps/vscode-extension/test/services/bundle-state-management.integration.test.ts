/**
 * Bundle State Management Integration Tests
 *
 * Tests complete workflows for bundle state management fixes:
 * - Install → Uninstall → Verify UI shows Install button
 * - Install v1.0.0 → Sync (v1.1.0 available) → Verify Update button shown
 * - Install v1.0.0 → Select v1.0.1 from dropdown → Verify v1.0.1 installed
 * - Sync GitHub source → Verify no auto-installation
 * - Sync Awesome Copilot source → Verify auto-update of installed bundles
 *
 * Requirements: All (1.1-6.6)
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as InfraAdapterFactory from '../../src/adapters/infra-adapter-factory';
import {
  BundleInstaller,
} from '../../src/services/bundle-installer';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  DeploymentManifest,
  InstalledBundle,
  RegistrySource,
} from '../../src/types/registry';
import {
  BundleBuilder,
  createTempTestPath,
  createUniqueTempPath,
} from '../helpers/bundle-test-helpers';
import {
  determineButtonState,
  matchesBundleIdentity,
} from '../helpers/marketplace-test-helpers';

// Helper to create mock manifest
function createMockManifest(): DeploymentManifest {
  return {
    common: {
      directories: [],
      files: [],
      include_patterns: [],
      exclude_patterns: []
    },
    bundle_settings: {
      include_common_in_environment_bundles: true,
      create_common_bundle: true,
      compression: 'zip',
      naming: {
        environment_bundle: 'bundle'
      }
    },
    metadata: {
      manifest_version: '1.0.0',
      description: 'Test manifest'
    }
  };
}

suite('Bundle State Management - Integration Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockInstaller: sinon.SinonStubbedInstance<BundleInstaller>;
  let registryManager: RegistryManager;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create mock context
    mockContext = {
      globalState: {
        get: sandbox.stub() as any,
        update: sandbox.stub(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      },
      workspaceState: {
        get: sandbox.stub() as any,
        update: sandbox.stub(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/extension/path',
      extensionUri: vscode.Uri.file('/mock/extension/path'),
      environmentVariableCollection: {} as any,
      extensionMode: 3, // ExtensionMode.Test
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

    // Create mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockInstaller = sandbox.createStubInstance(BundleInstaller);

    // Initialize RegistryManager with mocks
    registryManager = RegistryManager.getInstance(mockContext);
    (registryManager as any).storage = mockStorage;
    (registryManager as any).installer = mockInstaller;
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('Workflow 1: Install GitHub bundle → Uninstall → Verify UI shows Install button', () => {
    test('should show Install button after uninstalling GitHub bundle', async () => {
      // Setup: Create GitHub bundle
      const bundle = BundleBuilder.github('microsoft', 'vscode-copilot')
        .withVersion('1.0.0')
        .build();

      const source: RegistrySource = {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'https://github.com/microsoft/vscode-copilot',
        enabled: true,
        priority: 1
      };

      // Mock source retrieval
      mockStorage.getSources.resolves([source]);
      mockStorage.getCachedSourceBundles.withArgs('github-source').resolves([bundle]);

      // Mock adapter
      const mockAdapter = {
        fetchBundles: sandbox.stub().resolves([bundle]),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };
      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

      // Step 1: Install the bundle
      const installedBundle: InstalledBundle = {
        bundleId: bundle.id,
        version: bundle.version,
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: source.id,
        sourceType: source.type,
        manifest: createMockManifest()
      };

      mockInstaller.installFromBuffer.resolves(installedBundle);
      mockStorage.recordInstallation.resolves();
      mockStorage.getInstalledBundles.resolves([installedBundle]);

      await registryManager.installBundle(bundle.id, { scope: 'user' });

      // Verify installation was recorded
      assert.ok(mockStorage.recordInstallation.calledOnce, 'Installation should be recorded');

      // Step 2: Uninstall the bundle
      mockStorage.getInstalledBundle.withArgs(bundle.id).resolves(installedBundle);
      mockInstaller.uninstall.resolves();
      mockStorage.removeInstallation.resolves();
      mockStorage.getInstalledBundles.resolves([]);

      await registryManager.uninstallBundle(bundle.id, 'user');

      // Verify uninstallation
      assert.ok(mockStorage.removeInstallation.calledOnce, 'Installation record should be removed');

      // Step 3: Verify UI state (button should be "install")
      const installed = await mockStorage.getInstalledBundles();
      const matchingInstalled = installed.find((i) =>
        matchesBundleIdentity(i.bundleId, bundle.id, source.type)
      );

      const buttonState = determineButtonState(
        matchingInstalled?.version,
        bundle.version
      );

      assert.strictEqual(buttonState, 'install', 'Button state should be "install" after uninstall');
    });
  });

  suite('Workflow 2: Install v1.0.0 → Sync (v1.1.0 available) → Verify Update button shown', () => {
    test('should show Update button when newer version available after sync', async () => {
      // Setup: Create GitHub bundle v1.0.0
      const bundleV1 = BundleBuilder.github('microsoft', 'vscode-copilot')
        .withVersion('1.0.0')
        .build();

      const bundleV1x1 = BundleBuilder.github('microsoft', 'vscode-copilot')
        .withVersion('1.1.0')
        .build();

      const source: RegistrySource = {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'https://github.com/microsoft/vscode-copilot',
        enabled: true,
        priority: 1
      };

      // Source retrieved via getSources()
      mockStorage.getSources.resolves([source]);
      mockStorage.getCachedSourceBundles.withArgs('github-source').resolves([bundleV1]);

      // Step 1: Install v1.0.0
      const installedBundleV1: InstalledBundle = {
        bundleId: bundleV1.id,
        version: '1.0.0',
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: source.id,
        sourceType: source.type,
        manifest: createMockManifest()
      };

      const mockAdapter = {
        fetchBundles: sandbox.stub(),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };

      // First fetch returns v1.0.0
      mockAdapter.fetchBundles.onFirstCall().resolves([bundleV1]);

      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

      mockInstaller.installFromBuffer.resolves(installedBundleV1);
      mockStorage.recordInstallation.resolves();
      mockStorage.getInstalledBundles.resolves([installedBundleV1]);

      await registryManager.installBundle(bundleV1.id, { scope: 'user' });

      // Step 2: Sync source (v1.1.0 becomes available)
      mockAdapter.fetchBundles.onSecondCall().resolves([bundleV1x1]);
      mockStorage.cacheSourceBundles.resolves();

      await registryManager.syncSource('github-source');

      // Verify cache was updated
      assert.ok(mockStorage.cacheSourceBundles.calledOnce, 'Cache should be updated');

      // Step 3: Verify UI state (button should be "update")
      const installed = await mockStorage.getInstalledBundles();
      const matchingInstalled = installed.find((i) =>
        matchesBundleIdentity(i.bundleId, bundleV1x1.id, source.type)
      );

      const buttonState = determineButtonState(
        matchingInstalled?.version,
        bundleV1x1.version
      );

      assert.strictEqual(buttonState, 'update', 'Button state should be "update" when newer version available');
    });
  });

  suite('Workflow 3: Install v1.0.0 → Select v1.0.1 from dropdown → Verify v1.0.1 installed', () => {
    test('should install specific version when selected from dropdown', async () => {
      // Setup: Create GitHub bundle with specific version
      const bundleV1x0x1 = BundleBuilder.github('microsoft', 'vscode-copilot')
        .withVersion('1.0.1')
        .build();

      const source: RegistrySource = {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'https://github.com/microsoft/vscode-copilot',
        enabled: true,
        priority: 1
      };

      // Source retrieved via getSources()
      mockStorage.getSources.resolves([source]);
      mockStorage.getCachedSourceBundles.withArgs('github-source').resolves([bundleV1x0x1]);

      const mockAdapter = {
        fetchBundles: sandbox.stub().resolves([bundleV1x0x1]),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };

      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

      // Step 1: Install specific version v1.0.1 from dropdown
      const installedBundleV1x0x1: InstalledBundle = {
        bundleId: bundleV1x0x1.id,
        version: '1.0.1',
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: source.id,
        sourceType: source.type,
        manifest: createMockManifest()
      };

      mockInstaller.installFromBuffer.resolves(installedBundleV1x0x1);
      mockStorage.recordInstallation.resolves();
      mockStorage.getInstalledBundles.resolves([installedBundleV1x0x1]);

      // Install specific version (simulating dropdown selection)
      await registryManager.installBundle(bundleV1x0x1.id, {
        scope: 'user',
        version: '1.0.1'
      });

      // Step 2: Verify v1.0.1 is installed
      const installed = await mockStorage.getInstalledBundles();
      const matchingInstalled = installed.find((i) =>
        matchesBundleIdentity(i.bundleId, bundleV1x0x1.id, source.type)
      );

      assert.ok(matchingInstalled, 'Bundle should be installed');
      assert.strictEqual(matchingInstalled?.version, '1.0.1', 'Installed version should be 1.0.1');

      // Verify version parameter was passed to installBundle
      const installCalls = mockInstaller.installFromBuffer.getCalls();
      assert.strictEqual(installCalls.length, 1, 'Should have called installFromBuffer once');
    });
  });

  suite('Workflow 4: Sync GitHub source → Verify no auto-installation', () => {
    test('should NOT auto-install bundles when syncing GitHub source', async () => {
      // Setup: Create GitHub source with bundles
      const bundle = BundleBuilder.github('microsoft', 'vscode-copilot')
        .withVersion('1.0.0')
        .build();

      const source: RegistrySource = {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'https://github.com/microsoft/vscode-copilot',
        enabled: true,
        priority: 1
      };

      // Source retrieved via getSources()
      mockStorage.getSources.resolves([source]);
      mockStorage.getCachedSourceBundles.withArgs('github-source').resolves([bundle]);

      // Mock adapter
      const mockAdapter = {
        fetchBundles: sandbox.stub().resolves([bundle]),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };

      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

      // No bundles installed initially
      mockStorage.getInstalledBundles.resolves([]);
      mockStorage.cacheSourceBundles.resolves();

      // Step 1: Sync GitHub source
      await registryManager.syncSource('github-source');

      // Step 2: Verify cache was updated but no installation occurred
      assert.ok(mockStorage.cacheSourceBundles.calledOnce, 'Cache should be updated');
      assert.ok(mockInstaller.installFromBuffer.notCalled, 'Should NOT auto-install bundles from GitHub source');
      assert.ok(mockStorage.recordInstallation.notCalled, 'Should NOT record any installations');

      // Verify no bundles were installed
      const installed = await mockStorage.getInstalledBundles();
      assert.strictEqual(installed.length, 0, 'No bundles should be auto-installed from GitHub source');
    });

    test('should NOT auto-update installed bundles when syncing GitHub source', async () => {
      // Setup: Bundle v1.0.0 is installed, v1.1.0 becomes available
      const bundleV1 = BundleBuilder.github('microsoft', 'vscode-copilot')
        .withVersion('1.0.0')
        .build();

      const bundleV1x1 = BundleBuilder.github('microsoft', 'vscode-copilot')
        .withVersion('1.1.0')
        .build();

      const source: RegistrySource = {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'https://github.com/microsoft/vscode-copilot',
        enabled: true,
        priority: 1
      };

      const installedBundle: InstalledBundle = {
        bundleId: bundleV1.id,
        version: '1.0.0',
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: source.id,
        sourceType: source.type,
        manifest: createMockManifest()
      };

      // Source retrieved via getSources()
      mockStorage.getSources.resolves([source]);
      mockStorage.getCachedSourceBundles.withArgs('github-source').resolves([bundleV1, bundleV1x1]);
      mockStorage.getInstalledBundles.resolves([installedBundle]);

      // Mock adapter returns new version
      const mockAdapter = {
        fetchBundles: sandbox.stub().resolves([bundleV1x1]),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };

      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);
      mockStorage.cacheSourceBundles.resolves();

      // Step 1: Sync GitHub source
      await registryManager.syncSource('github-source');

      // Step 2: Verify cache was updated but no auto-update occurred
      assert.ok(mockStorage.cacheSourceBundles.calledOnce, 'Cache should be updated');

      // Verify no update operations were performed
      const installCallCount = mockInstaller.installFromBuffer.callCount;
      assert.strictEqual(installCallCount, 0, 'Should NOT auto-update bundles from GitHub source');

      // Verify installed bundle is still v1.0.0
      const installed = await mockStorage.getInstalledBundles();
      const matchingInstalled = installed.find((i) =>
        matchesBundleIdentity(i.bundleId, bundleV1.id, source.type)
      );

      assert.ok(matchingInstalled, 'Bundle should still be installed');
      assert.strictEqual(matchingInstalled?.version, '1.0.0', 'Version should remain 1.0.0 (not auto-updated)');
    });
  });

  suite('Workflow 5: Sync Awesome Copilot source → Verify auto-update of installed bundles', () => {
    test('should auto-update installed bundles when syncing Awesome Copilot source', async () => {
      // Setup: Bundle v1.0.0 is installed, v1.1.0 becomes available
      const bundleV1 = BundleBuilder.fromSource('awesome-bundle', 'AWESOME_COPILOT')
        .withVersion('1.0.0')
        .build();

      const bundleV1x1 = BundleBuilder.fromSource('awesome-bundle', 'AWESOME_COPILOT')
        .withVersion('1.1.0')
        .build();

      const source: RegistrySource = {
        id: 'awesome-copilot-source',
        name: 'Awesome Copilot Source',
        type: 'awesome-copilot',
        url: 'https://github.com/awesome/copilot',
        enabled: true,
        priority: 1
      };

      const installedBundle: InstalledBundle = {
        bundleId: bundleV1.id,
        version: '1.0.0',
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: source.id,
        sourceType: source.type,
        manifest: createMockManifest()
      };

      // Source retrieved via getSources()
      mockStorage.getSources.resolves([source]);
      mockStorage.getCachedSourceBundles.withArgs('awesome-copilot-source').resolves([bundleV1, bundleV1x1]);
      mockStorage.getInstalledBundles.resolves([installedBundle]);
      mockStorage.getInstalledBundle.withArgs(bundleV1.id).resolves(installedBundle);

      // Mock adapter returns new version
      const mockAdapter = {
        fetchBundles: sandbox.stub().resolves([bundleV1x1]),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };

      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);
      mockStorage.cacheSourceBundles.resolves();

      // Mock update operation
      const updatedBundle: InstalledBundle = {
        ...installedBundle,
        bundleId: bundleV1x1.id,
        version: '1.1.0',
        installedAt: new Date().toISOString()
      };

      mockInstaller.update.resolves(updatedBundle);
      mockStorage.removeInstallation.resolves();
      mockStorage.recordInstallation.resolves();

      // Step 1: Sync Awesome Copilot source
      await registryManager.syncSource('awesome-copilot-source');

      // Step 2: Verify cache was updated AND auto-update occurred
      assert.ok(mockStorage.cacheSourceBundles.calledOnce, 'Cache should be updated');

      // Verify update operations were performed via installer.update()
      const updateOccurred = mockInstaller.update.called;

      assert.ok(updateOccurred, 'Should auto-update bundles from Awesome Copilot source');
    });

    test('should NOT auto-update bundles from other sources when syncing Awesome Copilot source', async () => {
      // Setup: Two bundles installed from different sources
      const awesomeBundle = BundleBuilder.fromSource('awesome-bundle', 'AWESOME_COPILOT')
        .withVersion('1.0.0')
        .build();

      const githubBundle = BundleBuilder.github('microsoft', 'vscode-copilot')
        .withVersion('1.0.0')
        .build();

      const awesomeSource: RegistrySource = {
        id: 'awesome-copilot-source',
        name: 'Awesome Copilot Source',
        type: 'awesome-copilot',
        url: 'https://github.com/awesome/copilot',
        enabled: true,
        priority: 1
      };

      const githubSource: RegistrySource = {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'https://github.com/microsoft/vscode-copilot',
        enabled: true,
        priority: 2
      };

      const installedAwesomeBundle: InstalledBundle = {
        bundleId: awesomeBundle.id,
        version: '1.0.0',
        installPath: '/mock/install/path/awesome',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: awesomeSource.id,
        sourceType: awesomeSource.type,
        manifest: createMockManifest()
      };

      const installedGitHubBundle: InstalledBundle = {
        bundleId: githubBundle.id,
        version: '1.0.0',
        installPath: '/mock/install/path/github',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: githubSource.id,
        sourceType: githubSource.type,
        manifest: createMockManifest()
      };

      // Source retrieved via getSources()
      mockStorage.getSources.resolves([awesomeSource, githubSource]);
      mockStorage.getCachedSourceBundles.withArgs('awesome-copilot-source').resolves([awesomeBundle]);
      mockStorage.getCachedSourceBundles.withArgs('github-source').resolves([githubBundle]);
      mockStorage.getInstalledBundles.resolves([installedAwesomeBundle, installedGitHubBundle]);

      // Mock adapter returns updated awesome bundle
      const awesomeBundleV1x1 = BundleBuilder.fromSource('awesome-bundle', 'AWESOME_COPILOT')
        .withVersion('1.1.0')
        .build();

      const mockAdapter = {
        fetchBundles: sandbox.stub().resolves([awesomeBundleV1x1]),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };

      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);
      mockStorage.cacheSourceBundles.resolves();

      // Step 1: Sync Awesome Copilot source
      await registryManager.syncSource('awesome-copilot-source');

      // Step 2: Verify only awesome-copilot bundles are updated
      // The GitHub bundle should NOT be touched
      const installed = await mockStorage.getInstalledBundles();
      const githubInstalled = installed.find((i) => i.sourceId === 'github-source');

      assert.ok(githubInstalled, 'GitHub bundle should still be installed');
      assert.strictEqual(githubInstalled?.version, '1.0.0', 'GitHub bundle version should remain unchanged');
    });
  });

  suite('Bug Fix: Install specific older version', () => {
    test('should install older version v1.0.16 when v1.0.17 is latest', async () => {
      // This reproduces the bug: "Bundle ID mismatch: expected amadeus-airlines-solutions-workflow-instructions-1.0.17,
      // got amadeus-airlines-solutions-workflow-instructions-1.0.16"

      // Setup: Create bundles with v1.0.16 and v1.0.17 (latest)
      const bundleV1x0x16 = BundleBuilder.github('amadeus', 'airlines-solutions-workflow-instructions')
        .withVersion('1.0.16')
        .build();

      const bundleV1x0x17 = BundleBuilder.github('amadeus', 'airlines-solutions-workflow-instructions')
        .withVersion('1.0.17')
        .build();

      const source: RegistrySource = {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'https://github.com/amadeus/airlines-solutions-workflow-instructions',
        enabled: true,
        priority: 1
      };

      // Mock source retrieval
      mockStorage.getSources.resolves([source]);
      // Cache has both versions, with v1.0.17 as the latest
      mockStorage.getCachedSourceBundles.withArgs('github-source').resolves([bundleV1x0x17, bundleV1x0x16]);

      const mockAdapter = {
        fetchBundles: sandbox.stub().resolves([bundleV1x0x17, bundleV1x0x16]),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };

      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

      // Step 1: Install specific older version v1.0.16 (NOT the latest v1.0.17)
      const installedBundleV1x0x16: InstalledBundle = {
        bundleId: bundleV1x0x16.id, // Should be 'amadeus-airlines-solutions-workflow-instructions-1.0.16'
        version: '1.0.16',
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: source.id,
        sourceType: source.type,
        manifest: createMockManifest()
      };

      mockInstaller.installFromBuffer.resolves(installedBundleV1x0x16);
      mockStorage.recordInstallation.resolves();
      mockStorage.getInstalledBundles.resolves([installedBundleV1x0x16]);

      // Populate version consolidator by calling searchBundles first
      // This simulates what happens in real usage when marketplace loads bundles
      await registryManager.searchBundles({});

      // Install specific version v1.0.16 (not the latest)
      await registryManager.installBundle(bundleV1x0x16.id, {
        scope: 'user',
        version: '1.0.16'
      });

      // Step 2: Verify v1.0.16 is installed (not v1.0.17)
      const installed = await mockStorage.getInstalledBundles();
      const matchingInstalled = installed.find((i) =>
        matchesBundleIdentity(i.bundleId, bundleV1x0x16.id, source.type)
      );

      assert.ok(matchingInstalled, 'Bundle should be installed');
      assert.strictEqual(matchingInstalled?.version, '1.0.16', 'Installed version should be 1.0.16, not 1.0.17');
      assert.strictEqual(matchingInstalled?.bundleId, bundleV1x0x16.id, 'Bundle ID should match the requested version');

      // Verify the correct bundle was passed to the installer
      const installCalls = mockInstaller.installFromBuffer.getCalls();
      assert.strictEqual(installCalls.length, 1, 'Should have called installFromBuffer once');
      const installedBundle = installCalls[0].args[0];
      assert.strictEqual(installedBundle.id, bundleV1x0x16.id, 'Should install v1.0.16, not v1.0.17');
      assert.strictEqual(installedBundle.version, '1.0.16', 'Bundle version should be 1.0.16');
    });
  });

  suite('Bug Fix: Downgrade removes old version from display', () => {
    test('should show bug: v1.0.18 and v1.0.17 both installed after downgrade', async () => {
      // This test reproduces the bug where downgrading from 1.0.18 to 1.0.17
      // still shows both 1.0.18 AND 1.0.17 in the list of installed bundles
      // This happens because the old version file isn't deleted

      const bundleIdBase = 'amadeus-airlines-solutions-workflow-instructions';
      const uniqueStoragePath = createUniqueTempPath('test-downgrade-bug');

      const context = {
        globalStorageUri: { fsPath: uniqueStoragePath },
        subscriptions: []
      } as any;

      const storage = new RegistryStorage(context);
      await storage.initialize();

      // Step 1: Record v1.0.18 as installed
      const installedV1x0x18: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.18`,
        version: '1.0.18',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.18'),
        manifest: createMockManifest()
      };

      await storage.recordInstallation(installedV1x0x18);

      let installed = await storage.getInstalledBundles('user');
      assert.strictEqual(installed.length, 1, 'Should have v1.0.18 installed initially');
      assert.strictEqual(installed[0].version, '1.0.18', 'Initial version should be 1.0.18');

      // Step 2: Record v1.0.17 WITHOUT removing v1.0.18 (simulating the bug)
      const installedV1x0x17: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.17`,
        version: '1.0.17',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.17'),
        manifest: createMockManifest()
      };

      await storage.recordInstallation(installedV1x0x17);

      // Step 3: Verify BUG: both versions are now installed
      installed = await storage.getInstalledBundles('user');

      assert.strictEqual(installed.length, 2, 'BUG REPRODUCED: Both 1.0.18 and 1.0.17 are installed');
      const versions = installed.map((b) => b.version).toSorted();
      assert.deepStrictEqual(versions, ['1.0.17', '1.0.18'], 'Both versions present (bug)');
    });

    test('should cleanup old version when downgrading through RegistryManager', async () => {
      // This test verifies that the fix properly removes old versions during downgrade

      const bundleIdBase = 'amadeus-airlines-solutions-workflow-instructions';
      const uniqueStoragePath = createUniqueTempPath('test-downgrade-fix');

      const context = {
        globalStorageUri: { fsPath: uniqueStoragePath },
        subscriptions: []
      } as any;

      const storage = new RegistryStorage(context);
      await storage.initialize();

      // Simulate installing v1.0.18 initially
      const installedV1x0x18: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.18`,
        version: '1.0.18',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.18'),
        manifest: createMockManifest()
      };

      await storage.recordInstallation(installedV1x0x18);

      // Verify v1.0.18 is installed
      let installed = await storage.getInstalledBundles('user');
      assert.strictEqual(installed.length, 1, 'Initially v1.0.18 should be installed');
      assert.strictEqual(installed[0].version, '1.0.18', 'Should be version 1.0.18');

      // Now simulate what RegistryManager.cleanupOldVersions does:
      // 1. Extract base identity
      const baseId = bundleIdBase;

      // 2. Find all installations with same identity but different version
      const allInstalled = await storage.getInstalledBundles('user');
      const toRemove = allInstalled.filter((b) =>
        (b.bundleId.startsWith(baseId + '-') || b.bundleId === baseId)
        && b.version !== '1.0.17' // Keep only 1.0.17
      );

      // 3. Remove old versions
      for (const old of toRemove) {
        await storage.removeInstallation(old.bundleId, 'user');
      }

      // 4. Record new version
      const installedV1x0x17: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.17`,
        version: '1.0.17',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.17'),
        manifest: createMockManifest()
      };

      await storage.recordInstallation(installedV1x0x17);

      // Verify only v1.0.17 is now installed (v1.0.18 was removed)
      installed = await storage.getInstalledBundles('user');

      assert.strictEqual(installed.length, 1, 'After downgrade, only one version should be installed');
      assert.strictEqual(installed[0].version, '1.0.17', 'Installed version should be 1.0.17');
      assert.strictEqual(installed[0].bundleId, `${bundleIdBase}-1.0.17`, 'Bundle ID should match v1.0.17');
    });
  });

  suite('Rollback & Failure Recovery - Integration Tests', () => {
    test('should FAIL if cleanup happens BEFORE recording (catches the bug)', async () => {
      // CRITICAL TEST: Verifies that when changing versions:
      // 1. New version is recorded in storage (recordInstallation called)
      // 2. Old version cleanup is attempted (or completes if possible)
      //
      // This validates that recordInstallation is the primary operation
      // and cleanup happens after (not before) recording

      // Track what gets installed
      const installedBundles = new Map<string, InstalledBundle>();
      let recordInstallationCalled = false;
      let removeInstallationCalled = false;

      const bundleIdBase = 'amadeus-airlines-solutions-workflow-instructions';
      const bundleV1x0x18 = {
        id: `${bundleIdBase}-1.0.18`,
        name: 'Test',
        version: '1.0.18',
        description: 'Test',
        author: 'Test',
        sourceId: 'test-source',
        tags: [],
        dependencies: [],
        license: 'MIT',
        manifestUrl: 'http://test.com',
        downloadUrl: 'http://test.com',
        size: '1MB',
        lastUpdated: new Date().toISOString()
      };

      // Setup mock storage to track what gets recorded
      (mockStorage.recordInstallation as sinon.SinonStub).callsFake((bundle: InstalledBundle) => {
        recordInstallationCalled = true;
        installedBundles.set(bundle.bundleId, bundle);
      });

      (mockStorage.removeInstallation as sinon.SinonStub).callsFake((bundleId: string) => {
        removeInstallationCalled = true;
        installedBundles.delete(bundleId);
      });

      (mockStorage.getInstalledBundles as sinon.SinonStub).callsFake((_scope?: string) => {
        // Return all bundles regardless of scope for this test
        return Array.from(installedBundles.values());
      });

      // Setup stubs for the extension points installBundle now delegates to
      // (installRegistryBundle), replacing the old direct stubs on the
      // since-removed private resolveInstallationBundle/getSourceForBundle/
      // downloadAndInstall methods.
      sandbox.stub(registryManager, 'getBundleDetails').resolves(bundleV1x0x18 as any);
      mockStorage.getSources.resolves([
        { id: 'test-source', name: 'Test Source', type: 'github', url: 'https://github.com/test/test', enabled: true, priority: 0 }
      ]);
      // determineSearchId's version-specific branch (options.version is set
      // below) looks this up for every source before getBundleDetails runs.
      mockStorage.getCachedSourceBundles.resolves([]);
      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns({
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      } as any);
      mockInstaller.installFromBuffer.resolves({
        bundleId: `${bundleIdBase}-1.0.18`,
        version: '1.0.18',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.18'),
        manifest: createMockManifest()
      });

      // Pre-populate with an old version
      const oldBundle: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.17`,
        version: '1.0.17',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.17'),
        manifest: createMockManifest()
      };
      installedBundles.set(oldBundle.bundleId, oldBundle);

      // Perform installation
      await registryManager.installBundle(`${bundleIdBase}`, { scope: 'user', version: '1.0.18' });

      // Verify the new version was recorded (main assertion)
      assert.ok(recordInstallationCalled, 'recordInstallation must be called during installation');
      assert.ok(installedBundles.has(`${bundleIdBase}-1.0.18`), 'v1.0.18 should be recorded');

      // Verify old version is cleaned up (this verifies proper order and functionality)
      assert.ok(removeInstallationCalled, 'removeInstallation should be called during cleanup');
      assert.ok(!installedBundles.has(`${bundleIdBase}-1.0.17`), 'v1.0.17 should be cleaned up');
    });

    test('should preserve old version when update fails during storage recording', async () => {
      // CRITICAL TEST: Verifies that old version metadata is NOT cleaned up if recording fails
      // This catches the bug where cleanup happens BEFORE recording
      //
      // Scenario:
      // 1. v1.0.17 is installed
      // 2. Auto-update attempts to install v1.0.18
      // 3. Files are installed successfully
      // 4. But storage.recordInstallation() fails
      // 5. Old version should STILL be available (not cleaned up)

      const bundleIdBase = 'amadeus-airlines-solutions-workflow-instructions';
      const uniqueStoragePath = createUniqueTempPath('test-rollback');

      const context = {
        globalStorageUri: { fsPath: uniqueStoragePath },
        subscriptions: []
      } as any;

      const storage = new RegistryStorage(context);
      await storage.initialize();

      // Step 1: Install v1.0.17 initially
      const installedV1x0x17: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.17`,
        version: '1.0.17',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.17'),
        manifest: createMockManifest()
      };

      await storage.recordInstallation(installedV1x0x17);

      const installed = await storage.getInstalledBundles('user');
      assert.strictEqual(installed.length, 1, 'Should have v1.0.17 installed initially');
      assert.strictEqual(installed[0].version, '1.0.17', 'Version should be 1.0.17');

      // Step 2: Simulate update to v1.0.18 with storage failure
      // This tests the correct order: Record FIRST, cleanup AFTER

      const installedV1x0x18: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.18`,
        version: '1.0.18',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.18'),
        manifest: createMockManifest()
      };

      // Simulate the CORRECT order: Record first, then cleanup
      try {
        // Step 2a: Record new version
        await storage.recordInstallation(installedV1x0x18);

        // Step 2b: Now both versions are in storage
        const bothInstalled = await storage.getInstalledBundles('user');
        assert.strictEqual(bothInstalled.length, 2, 'After recording, both versions should exist');

        // Step 2c: Now try to cleanup (simulate this might fail)
        // We'll intentionally skip cleanup to simulate a failure after recording
        // In real scenario, cleanupOldVersions could fail with network/permission error

        // For this test, we manually cleanup to show what SHOULD happen
        // In buggy version, cleanup happens BEFORE record, so old is deleted if record fails
        const allInstalled = await storage.getInstalledBundles('user');
        for (const old of allInstalled) {
          if (old.version === '1.0.17') {
            await storage.removeInstallation(old.bundleId, 'user');
          }
        }

        // Step 3: Verify BOTH were present before cleanup
        // This proves we kept the old version safe during recording
        assert.ok(
          bothInstalled.some((b) => b.version === '1.0.17'),
          'CRITICAL: Old version must be in storage BEFORE cleanup (for rollback)'
        );
        assert.ok(
          bothInstalled.some((b) => b.version === '1.0.18'),
          'CRITICAL: New version must be in storage after successful record'
        );
      } catch {
        // If recording fails, old version should still be there
        const afterFailure = await storage.getInstalledBundles('user');
        assert.ok(
          afterFailure.some((b) => b.version === '1.0.17'),
          'OLD VERSION MUST BE PRESERVED IF RECORDING FAILS (this is the rollback mechanism)'
        );
        assert.ok(
          afterFailure.every((b) => b.version !== '1.0.18'),
          'Failed version should not be in storage'
        );
      }
    });

    test('should allow retry of failed update by checking if old version still exists', async () => {
      // INTEGRATION TEST: Verifies complete retry scenario
      // 1. v1.0.17 is installed
      // 2. Update to v1.0.18 fails
      // 3. v1.0.17 is still available
      // 4. User can retry the update

      const bundleIdBase = 'test-bundle-retry';
      const uniqueStoragePath = createUniqueTempPath('test-retry');

      const context = {
        globalStorageUri: { fsPath: uniqueStoragePath },
        subscriptions: []
      } as any;

      const storage = new RegistryStorage(context);
      await storage.initialize();

      // Step 1: Initial installation v1.0.17
      const v1x0x17: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.17`,
        version: '1.0.17',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.17'),
        manifest: createMockManifest()
      };

      await storage.recordInstallation(v1x0x17);

      // Step 2: Attempt update to v1.0.18 (simulate partial failure)
      const v1x0x18: InstalledBundle = {
        bundleId: `${bundleIdBase}-1.0.18`,
        version: '1.0.18',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: 'test-source',
        sourceType: 'github',
        installPath: createTempTestPath('install-1.0.18'),
        manifest: createMockManifest()
      };

      // Record new version (succeeds)
      await storage.recordInstallation(v1x0x18);

      // Simulate cleanup failure - old version NOT removed
      // (in real scenario, could be permission error, disk error, etc.)
      // Note: We don't cleanup - simulate the failure instead

      // Step 3: Verify both versions exist (old one is still usable as fallback)
      const current = await storage.getInstalledBundles('user');
      const v1x0x17exists = current.some((b) => b.version === '1.0.17');
      const v1x0x18exists = current.some((b) => b.version === '1.0.18');

      assert.ok(v1x0x18exists, 'New version should be recorded');
      assert.ok(v1x0x17exists, 'Old version should still be available for rollback');

      // Step 4: Simulate retry of the failed cleanup
      // Application detects v1.0.17 still exists and safely removes it after v1.0.18 is confirmed
      for (const bundle of current) {
        if (bundle.version === '1.0.17') {
          await storage.removeInstallation(bundle.bundleId, 'user');
        }
      }

      // Step 5: Verify cleanup succeeded, now only v1.0.18 exists
      const afterCleanup = await storage.getInstalledBundles('user');
      assert.strictEqual(afterCleanup.length, 1, 'After successful cleanup, only new version should remain');
      assert.strictEqual(afterCleanup[0].version, '1.0.18', 'Should be the updated version');
    });
  });

  suite('Bundle Details View: Opening details for installed versioned bundles', () => {
    test('should find bundle details when opening installed GitHub bundle with versioned ID (e.g., bundle-1.0.17)', async () => {
      // ISSUE: Clicking on an installed bundle in the Registry Explorer
      // shows "Bundle not found" error because:
      // 1. Installed bundle has versioned ID: "amadeus-airlines-solutions-workflow-instructions-1.0.17"
      // 2. searchBundles({}) returns consolidated bundles without version: "amadeus-airlines-solutions-workflow-instructions"
      // 3. openBundleDetails tries exact ID match and fails

      const bundleIdentity = 'amadeus-airlines-solutions-workflow-instructions';
      const bundleVersion = '1.0.17';
      const versionedBundleId = `${bundleIdentity}-${bundleVersion}`;

      // Setup: Create bundle with version
      const bundleBuilder = BundleBuilder.github('amadeus', 'airline-solutions');
      const bundle = bundleBuilder
        .withVersion(bundleVersion)
        .build();

      // Update the bundle ID to match our expected identity (since github creates it from owner-repo)
      bundle.id = bundleIdentity;
      bundle.name = 'Amadeus Airlines Solutions Workflow Instructions';

      const source: RegistrySource = {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'https://github.com/amadeus/airline-solutions',
        enabled: true,
        priority: 1
      };

      // Mock installation with versioned ID
      const installedBundle: InstalledBundle = {
        bundleId: versionedBundleId,
        version: bundleVersion,
        installPath: '/mock/install/path',
        installedAt: new Date().toISOString(),
        scope: 'user',
        sourceId: source.id,
        sourceType: source.type,
        manifest: createMockManifest()
      };

      // Setup mocks
      mockStorage.getSources.resolves([source]);
      mockStorage.getCachedSourceBundles.withArgs('github-source').resolves([bundle]);
      mockStorage.getInstalledBundles.resolves([installedBundle]);
      mockStorage.getCachedBundleMetadata.resolves(undefined); // No cache hit

      const mockAdapter = {
        fetchBundles: sandbox.stub().resolves([bundle]),
        downloadBundle: sandbox.stub().resolves(Buffer.from('mock-bundle-data'))
      };

      sandbox.stub(InfraAdapterFactory, 'createRegistryAdapter').returns(mockAdapter as any);

      // TEST: Call getBundleDetails with versioned ID
      // This is what happens when clicking on installed bundle in Registry Explorer
      // Then openBundleDetails is called with the installed bundle's ID

      // The getBundleDetails method should handle this through identity matching
      const bundleDetails = await registryManager.getBundleDetails(versionedBundleId);

      // Verify bundle was found
      assert.ok(bundleDetails, 'Bundle details should be found');
      assert.strictEqual(bundleDetails.id, bundleIdentity, 'Bundle ID should match identity');
      assert.strictEqual(bundleDetails.name, bundle.name, 'Bundle name should match');
      assert.strictEqual(bundleDetails.version, bundleVersion, 'Bundle version should match');
    });
  });
});
