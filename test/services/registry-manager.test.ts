/**
 * RegistryManager Behavior Tests
 *
 * Tests verify actual outcomes rather than implementation details.
 * Focus on requirements from bundle-state-management-fixes spec.
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RepositoryAdapterFactory,
} from '../../src/adapters/repository-adapter';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  Bundle,
  InstalledBundle,
  RegistrySource,
} from '../../src/types/registry';
import {
  BundleBuilder,
  TEST_SOURCE_IDS,
} from '../helpers/bundle-test-helpers';

suite('RegistryManager - Settings Export/Import Behavior', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    manager = RegistryManager.getInstance(mockContext);

    // Create and inject mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([]);
    mockStorage.getProfiles.resolves([]);
    mockStorage.getInstalledBundles.resolves([]);
    (manager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should export settings as JSON string with required fields', async () => {
    const exportedString = await manager.exportSettings('json');
    const exported = JSON.parse(exportedString);

    assert.ok(exported.version, 'Should have version');
    assert.ok(exported.exportedAt, 'Should have timestamp');
    assert.ok(Array.isArray(exported.sources), 'Should have sources array');
    assert.ok(Array.isArray(exported.profiles), 'Should have profiles array');
  });

  test('should import settings from JSON string', async () => {
    const testData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      sources: [{
        id: 'test-source',
        name: 'Test',
        type: 'local' as const,
        url: 'file:///mock/path',
        enabled: true,
        priority: 0
      }],
      profiles: [],
      configuration: {}
    };

    mockStorage.addSource.resolves();
    mockStorage.getSources.resolves([testData.sources[0]]);

    await manager.importSettings(JSON.stringify(testData), 'json', 'merge');

    // Verify source was added
    const sources = await manager.listSources();
    assert.ok(sources.length > 0, 'Should have imported sources');
  });
});

suite('RegistryManager - Version Selection Behavior', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let manager: RegistryManager;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    (mockContext.globalState.get as sinon.SinonStub).withArgs('sources').returns([]);
    (mockContext.globalState.get as sinon.SinonStub).withArgs('profiles').returns([]);
    (mockContext.globalState.get as sinon.SinonStub).withArgs('installations').returns([]);

    manager = RegistryManager.getInstance(mockContext);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should retrieve available versions for a bundle', async () => {
    // This tests Requirement 2.1: Display dropdown with all available versions
    const bundleId = 'owner-repo-v2.0.0';

    const versions = await manager.getAvailableVersions(bundleId);

    // Should return array of version strings
    assert.ok(Array.isArray(versions), 'Should return array of versions');
  });
});

suite('RegistryManager - Event Emission Behavior', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    (mockContext.globalState.get as sinon.SinonStub).withArgs('sources').returns([]);
    (mockContext.globalState.get as sinon.SinonStub).withArgs('profiles').returns([]);
    (mockContext.globalState.get as sinon.SinonStub).withArgs('installations').returns([]);

    manager = RegistryManager.getInstance(mockContext);

    // Create and inject mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([]);
    mockStorage.getProfiles.resolves([]);
    mockStorage.getInstalledBundles.resolves([]);
    (manager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should fire onBundleInstalled event when bundle is installed', async () => {
    // Requirement 6.1: Fire onBundleInstalled event
    let eventFired = false;
    let firedBundleId: string | undefined;

    const listener = manager.onBundleInstalled((bundle) => {
      eventFired = true;
      firedBundleId = bundle.bundleId;
    });

    // Set up mocks for actual installation
    const testBundle = {
      id: 'test-bundle',
      name: 'Test Bundle',
      version: '1.0.0',
      description: 'Test',
      author: 'Test',
      tags: [],
      sourceId: 'test-source',
      downloadUrl: 'http://example.com/bundle.zip',
      manifestUrl: 'http://example.com/manifest.json',
      lastUpdated: new Date().toISOString(),
      downloads: 0,
      rating: 0,
      environments: []
    };

    const testSource = {
      id: 'test-source',
      name: 'Test Source',
      type: 'local' as const,
      url: 'file:///test',
      enabled: true,
      priority: 0
    };

    mockStorage.getInstalledBundle.resolves(undefined);
    mockStorage.getSources.resolves([testSource]);

    // Mock adapter and installer
    const mockAdapter = {
      downloadBundle: sandbox.stub().resolves(Buffer.from('test'))
    };
    sandbox.stub(RepositoryAdapterFactory, 'create').returns(mockAdapter as any);

    const mockInstaller = (manager as any).installer;
    sandbox.stub(mockInstaller, 'installFromBuffer').resolves({
      bundleId: 'test-bundle',
      version: '1.0.0',
      sourceId: 'test-source',
      sourceType: 'local',
      installedAt: new Date().toISOString(),
      scope: 'user'
    });

    mockStorage.recordInstallation.resolves();

    // Stub getBundleDetails to return test bundle
    sandbox.stub(manager as any, 'getBundleDetails').resolves(testBundle);

    // Perform actual installation which should fire the event
    await manager.installBundle('test-bundle', { scope: 'user' });

    assert.ok(eventFired, 'Event should fire when bundle is installed');
    assert.strictEqual(firedBundleId, 'test-bundle', 'Event should contain correct bundle ID');

    listener.dispose();
  });

  test('should fire onBundleUninstalled event when bundle is uninstalled', async () => {
    // Requirement 6.2: Fire onBundleUninstalled event
    let eventFired = false;
    let firedBundleId: string | undefined;

    const listener = manager.onBundleUninstalled((bundleId) => {
      eventFired = true;
      firedBundleId = bundleId;
    });

    // Set up mocks for actual uninstallation
    const installedBundle = {
      bundleId: 'test-bundle',
      version: '1.0.0',
      sourceId: 'test-source',
      sourceType: 'local' as const,
      installedAt: new Date().toISOString(),
      scope: 'user' as const,
      installPath: '/mock/path',
      manifest: { id: 'test-bundle', name: 'Test', version: '1.0.0' } as any
    };

    mockStorage.getInstalledBundle.resolves(installedBundle);
    mockStorage.removeInstallation.resolves();

    const mockInstaller = (manager as any).installer;
    sandbox.stub(mockInstaller, 'uninstall').resolves();

    // Perform actual uninstallation which should fire the event
    await manager.uninstallBundle('test-bundle', 'user');

    assert.ok(eventFired, 'Event should fire when bundle is uninstalled');
    assert.strictEqual(firedBundleId, 'test-bundle', 'Event should contain correct bundle ID');

    listener.dispose();
  });

  test('should fire onBundleUpdated event when bundle is updated', async () => {
    // Requirement 6.3: Fire onBundleUpdated event
    let eventFired = false;
    let firedUpdate: any;

    const listener = manager.onBundleUpdated((update) => {
      eventFired = true;
      firedUpdate = update;
    });

    // Set up mocks for actual update
    const currentInstallation = {
      bundleId: 'test-bundle',
      version: '1.0.0',
      sourceId: 'test-source',
      sourceType: 'local' as const,
      installedAt: new Date().toISOString(),
      scope: 'user' as const,
      installPath: '/mock/path',
      manifest: { id: 'test-bundle', name: 'Test', version: '1.0.0' } as any
    };

    const updatedBundle = {
      id: 'test-bundle',
      name: 'Test Bundle',
      version: '2.0.0',
      description: 'Test',
      author: 'Test',
      tags: [],
      sourceId: 'test-source',
      downloadUrl: 'http://example.com/bundle.zip',
      manifestUrl: 'http://example.com/manifest.json',
      lastUpdated: new Date().toISOString(),
      downloads: 0,
      rating: 0,
      environments: []
    };

    const testSource = {
      id: 'test-source',
      name: 'Test Source',
      type: 'local' as const,
      url: 'file:///test',
      enabled: true,
      priority: 0
    };

    mockStorage.getInstalledBundles.resolves([currentInstallation]);
    mockStorage.getSources.resolves([testSource]);
    mockStorage.removeInstallation.resolves();
    mockStorage.recordInstallation.resolves();

    // Mock adapter
    const mockAdapter = {
      downloadBundle: sandbox.stub().resolves(Buffer.from('test'))
    };
    sandbox.stub(RepositoryAdapterFactory, 'create').returns(mockAdapter as any);

    // Mock installer
    const mockInstaller = (manager as any).installer;
    sandbox.stub(mockInstaller, 'update').resolves({
      bundleId: 'test-bundle',
      version: '2.0.0',
      sourceId: 'test-source',
      sourceType: 'local',
      installedAt: new Date().toISOString(),
      scope: 'user'
    });

    // Stub getBundleDetails
    sandbox.stub(manager as any, 'getBundleDetails').resolves(updatedBundle);

    // Perform actual update which should fire the event
    await manager.updateBundle('test-bundle');

    assert.ok(eventFired, 'Event should fire when bundle is updated');
    assert.strictEqual(firedUpdate.bundleId, 'test-bundle', 'Event should contain correct bundle ID');
    assert.strictEqual(firedUpdate.version, '2.0.0', 'Event should contain new version');

    listener.dispose();
  });

  test('should pass source metadata to installer during update', async () => {
    const currentInstallation = {
      bundleId: 'skills-owner-repo-demo',
      version: 'hash:abc',
      sourceId: 'skills-source',
      sourceType: 'skills' as const,
      installedAt: new Date().toISOString(),
      scope: 'user' as const,
      installPath: '/mock/path',
      manifest: { id: 'skills-owner-repo-demo', name: 'Demo', version: 'hash:abc' } as any
    };

    const updatedBundle = {
      id: 'skills-owner-repo-demo',
      name: 'Demo Skill',
      version: 'hash:def',
      description: 'Updated',
      author: 'owner',
      tags: [],
      sourceId: 'skills-source',
      downloadUrl: 'http://example.com/bundle.zip',
      manifestUrl: 'http://example.com/manifest.json',
      lastUpdated: new Date().toISOString(),
      downloads: 0,
      rating: 0,
      environments: []
    };

    const skillsSource: RegistrySource = {
      id: 'skills-source',
      name: 'Remote Skills Source',
      type: 'skills',
      url: 'https://github.com/owner/repo',
      enabled: true,
      priority: 1
    };

    mockStorage.getInstalledBundles.resolves([currentInstallation]);
    mockStorage.getSources.resolves([skillsSource]);
    mockStorage.recordInstallation.resolves();
    mockStorage.removeInstallation.resolves();

    const mockAdapter = {
      downloadBundle: sandbox.stub().resolves(Buffer.from('test'))
    };
    sandbox.stub(RepositoryAdapterFactory, 'create').returns(mockAdapter as any);

    const mockInstaller = (manager as any).installer;
    const updateStub = sandbox.stub(mockInstaller, 'update').resolves({
      bundleId: 'skills-owner-repo-demo',
      version: 'hash:def',
      sourceId: 'skills-source',
      sourceType: 'skills',
      installedAt: new Date().toISOString(),
      scope: 'user'
    });

    sandbox.stub(manager as any, 'getBundleDetails').resolves(updatedBundle);

    await manager.updateBundle('skills-owner-repo-demo');

    assert.ok(updateStub.calledOnce, 'Installer should be invoked once');
    const callArgs = updateStub.firstCall.args;
    assert.strictEqual(callArgs[3], 'skills', 'source type should be forwarded');
  });

  test('should refresh local skill installations on sync', async () => {
    const localSkillInstall: InstalledBundle = {
      bundleId: 'local-skills-repo-plan-angular-migration',
      version: 'hash:old',
      installedAt: new Date(Date.now() - 60_000).toISOString(),
      scope: 'user',
      installPath: '/mock/path',
      manifest: { id: 'local-skills-repo-plan-angular-migration', name: 'Plan Angular Migration', version: 'hash:old' } as any,
      sourceId: 'local-source',
      sourceType: 'local-skills'
    };

    mockStorage.getSources.resolves([{
      id: 'local-source',
      name: 'Local Skill Shelf',
      type: 'local-skills',
      url: 'file:///skills-shelf',
      enabled: true,
      priority: 1
    }]);

    const mockAdapter = {
      fetchBundles: sandbox.stub().resolves([
        {
          id: 'local-skills-repo-plan-angular-migration',
          name: 'Plan Angular Migration',
          version: 'hash:new',
          description: 'Plan Angular Migration',
          author: 'Local',
          sourceId: 'local-source',
          environments: [],
          tags: [],
          lastUpdated: new Date().toISOString(),
          size: '1KB',
          dependencies: [],
          license: 'MIT',
          manifestUrl: 'file:///manifest',
          downloadUrl: 'file:///skill'
        } as Bundle
      ])
    };

    sandbox.stub(RepositoryAdapterFactory, 'create').returns(mockAdapter as any);
    mockStorage.getInstalledBundles.resolves([localSkillInstall]);
    const updatedInstallations: InstalledBundle[] = [];
    mockStorage.recordInstallation.callsFake((installation: InstalledBundle) => {
      updatedInstallations.push(installation);
      return Promise.resolve();
    });

    let updatedEventPayload: InstalledBundle | undefined;
    const listener = manager.onBundleUpdated((bundle) => {
      updatedEventPayload = bundle;
    });

    await manager.syncSource('local-source');

    assert.strictEqual(mockAdapter.fetchBundles.callCount, 1, 'Local skills adapter should fetch bundles');
    assert.strictEqual(updatedInstallations.length, 1, 'Installation record should be updated to latest hash');
    const refreshed = updatedInstallations[0];
    assert.strictEqual(refreshed.version, 'hash:new', 'Version should match latest content hash');
    assert.ok(updatedEventPayload, 'Should emit onBundleUpdated for refreshed skill');
    assert.strictEqual(updatedEventPayload?.bundleId, refreshed.bundleId);

    listener.dispose();
  });
});

suite('RegistryManager - Installation Record Structure', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    manager = RegistryManager.getInstance(mockContext);

    // Create and inject mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getInstalledBundles.resolves([]);
    (manager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should list installed bundles', async () => {
    // Requirement 4.5: Store both full bundle ID and source type
    const installed = await manager.listInstalledBundles();

    assert.ok(Array.isArray(installed), 'Should return array of installed bundles');
  });

  test('should return empty array when no bundles installed', async () => {
    const installed = await manager.listInstalledBundles();

    assert.strictEqual(installed.length, 0, 'Should return empty array');
  });
});

suite('RegistryManager - Source Management', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    manager = RegistryManager.getInstance(mockContext);

    // Create and inject mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([]);
    (manager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should list sources', async () => {
    const sources = await manager.listSources();

    assert.ok(Array.isArray(sources), 'Should return array of sources');
  });

  test('should add a new source and make it available in source list', async () => {
    const newSource: RegistrySource = {
      id: 'new-source',
      name: 'New Source',
      type: 'local',
      url: 'file:///mock/path',
      enabled: true,
      priority: 0
    };

    // Mock the storage to return the new source after adding
    mockStorage.addSource.resolves();
    mockStorage.getSources.resolves([newSource]);

    // Mock the adapter factory to return a mock adapter with successful validation
    const mockAdapter = {
      validate: sandbox.stub().resolves({ valid: true, errors: [] }),
      fetchBundles: sandbox.stub().resolves([])
    };
    const factoryStub = sandbox.stub(RepositoryAdapterFactory, 'create').returns(mockAdapter as any);

    await manager.addSource(newSource);

    // Verify the source is now in the list
    const sources = await manager.listSources();
    assert.ok(sources.some((s) => s.id === 'new-source'), 'Added source should be in source list');
    assert.strictEqual(sources[0].name, 'New Source', 'Source should have correct name');

    // Verify adapter was created and validated
    assert.ok(factoryStub.called, 'Adapter factory should be called');
    assert.ok(mockAdapter.validate.called, 'Adapter validation should be called');
  });
});

suite('RegistryManager - Version Change Installation', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    manager = RegistryManager.getInstance(mockContext);
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    (manager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should allow installing different version when bundle already installed', async () => {
    const bundleId = 'test-bundle';

    // Mock existing installation with v1.0.0
    mockStorage.getInstalledBundle.resolves({
      bundleId: bundleId,
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'user',
      sourceId: 'test-source',
      sourceType: 'github',
      installPath: '/mock/path',
      manifest: { id: bundleId, name: 'Test', version: '1.0.0' } as any
    });

    // Mock bundle resolution to return v1.0.1
    const mockBundle = {
      id: bundleId,
      name: 'Test Bundle',
      version: '1.0.1',
      description: 'Test',
      author: 'Test',
      tags: []
    };

    // Stub internal methods
    sandbox.stub(manager as any, 'resolveInstallationBundle').resolves(mockBundle);
    sandbox.stub(manager as any, 'getSourceForBundle').resolves({ id: 'test-source', type: 'github' });
    sandbox.stub(manager as any, 'downloadAndInstall').resolves({
      bundleId: bundleId,
      version: '1.0.1',
      installedAt: new Date().toISOString(),
      scope: 'user',
      sourceId: 'test-source',
      sourceType: 'github'
    });
    mockStorage.recordInstallation.resolves();

    // Should not throw error - version change should be allowed
    await manager.installBundle(bundleId, { scope: 'user', version: '1.0.1' });

    // Verify installation was recorded with correct version
    assert.ok(mockStorage.recordInstallation.called, 'Installation should be recorded');
    const recordedInstallation = mockStorage.recordInstallation.firstCall.args[0];
    assert.strictEqual(recordedInstallation.version, '1.0.1', 'Should install requested version 1.0.1');
    assert.strictEqual(recordedInstallation.bundleId, bundleId, 'Should record correct bundle ID');
  });

  test('should throw error when installing same version without force', async () => {
    const bundleId = 'test-bundle';

    // Mock existing installation with v1.0.0
    mockStorage.getInstalledBundle.resolves({
      bundleId: bundleId,
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      scope: 'user',
      sourceId: 'test-source',
      sourceType: 'github',
      installPath: '/mock/path',
      manifest: { id: bundleId, name: 'Test', version: '1.0.0' } as any
    });

    // Mock bundle resolution to return same version
    const mockBundle = {
      id: bundleId,
      name: 'Test Bundle',
      version: '1.0.0',
      description: 'Test',
      author: 'Test',
      tags: []
    };

    sandbox.stub(manager as any, 'resolveInstallationBundle').resolves(mockBundle);

    // Should throw error for same version
    await assert.rejects(
      manager.installBundle(bundleId, { scope: 'user', version: '1.0.0' }),
      /already installed/,
      'Installing same version should throw error'
    );
  });

  test('should allow downgrade from v1.0.17 to v1.0.15', async () => {
    const bundleId = 'amadeus-airlines-solutions-workflow-instructions';

    // Mock existing installation with v1.0.17
    mockStorage.getInstalledBundle.resolves({
      bundleId: `${bundleId}-1.0.17`,
      version: '1.0.17',
      installedAt: new Date().toISOString(),
      scope: 'user',
      sourceId: 'test-source',
      sourceType: 'github',
      installPath: '/mock/path',
      manifest: { id: bundleId, name: 'Amadeus', version: '1.0.17' } as any
    });

    // Mock bundle resolution to return v1.0.15 (downgrade)
    const mockBundle = {
      id: `${bundleId}-1.0.15`,
      name: 'Amadeus Airlines Solutions',
      version: '1.0.15',
      description: 'Test',
      author: 'Test',
      tags: []
    };

    sandbox.stub(manager as any, 'resolveInstallationBundle').resolves(mockBundle);
    sandbox.stub(manager as any, 'getSourceForBundle').resolves({ id: 'test-source', type: 'github' });
    sandbox.stub(manager as any, 'downloadAndInstall').resolves({
      bundleId: `${bundleId}-1.0.15`,
      version: '1.0.15',
      installedAt: new Date().toISOString(),
      scope: 'user',
      sourceId: 'test-source',
      sourceType: 'github'
    });
    mockStorage.recordInstallation.resolves();

    // Should allow downgrade
    await manager.installBundle(bundleId, { scope: 'user', version: '1.0.15' });

    // Verify downgrade was recorded with correct version
    assert.ok(mockStorage.recordInstallation.called, 'Downgrade should be recorded');
    const recordedInstallation = mockStorage.recordInstallation.firstCall.args[0];
    assert.strictEqual(recordedInstallation.version, '1.0.15', 'Should install downgraded version 1.0.15');
    assert.ok(recordedInstallation.bundleId.includes('1.0.15'), 'Bundle ID should reflect downgraded version');
  });
});

suite('RegistryManager - Bundle Resolution', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let registryManager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    registryManager = RegistryManager.getInstance(mockContext);

    // Create and inject mock storage using the existing pattern
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    (registryManager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should resolve bundle by versioned ID via identity matching', async () => {
    // Arrange - The scenario where update check returns versioned ID but sources have consolidated ID
    const versionedBundleId = 'amadeus-airlines-solutions-workflow-instructions-1.0.17';
    const identityBundleId = 'amadeus-airlines-solutions-workflow-instructions';

    const sourceBundle = BundleBuilder.fromSource(identityBundleId, 'GITHUB')
      .withVersion('1.0.18')
      .build();
    sourceBundle.sourceId = TEST_SOURCE_IDS.GITHUB;

    mockStorage.getCachedBundleMetadata.resolves(undefined);
    mockStorage.getSources.resolves([{
      id: TEST_SOURCE_IDS.GITHUB,
      type: 'github',
      name: 'Test Source',
      url: 'https://github.com/test/repo',
      enabled: true,
      priority: 1
    }]);

    sandbox.stub(registryManager, 'searchBundles').resolves([sourceBundle]);

    // Act - This happens when user clicks "View Details" after update check
    const result = await registryManager.getBundleDetails(versionedBundleId);

    // Assert - Should find the bundle via identity matching
    assert.strictEqual(result.version, '1.0.18');
    assert.ok(result.id.includes('amadeus-airlines-solutions-workflow-instructions'));
  });

  test('should resolve bundle by identity when source has versioned ID', async () => {
    // Arrange - Test the reverse case: identity -> versioned bundle
    const identityBundleId = 'amadeus-airlines-solutions-workflow-instructions';

    const versionedBundle = BundleBuilder.fromSource(identityBundleId, 'GITHUB')
      .withVersion('1.0.18')
      .build();
    versionedBundle.sourceId = TEST_SOURCE_IDS.GITHUB;

    mockStorage.getCachedBundleMetadata.resolves(undefined);
    mockStorage.getSources.resolves([{
      id: TEST_SOURCE_IDS.GITHUB,
      type: 'github',
      name: 'Test Source',
      url: 'https://github.com/test/repo',
      enabled: true,
      priority: 1
    }]);

    sandbox.stub(registryManager, 'searchBundles').resolves([versionedBundle]);

    // Act
    const result = await registryManager.getBundleDetails(identityBundleId);

    // Assert - Should find the versioned bundle via identity matching
    assert.strictEqual(result.version, '1.0.18');
    assert.ok(result.id.includes('amadeus-airlines-solutions-workflow-instructions'));
  });

  test('should handle exact ID matches without identity matching', async () => {
    // Arrange - Test that exact matches still work
    const bundleId = 'exact-match-bundle-1.0.0';

    const exactBundle = BundleBuilder.fromSource('exact-match-bundle', 'GITHUB')
      .withVersion('1.0.0')
      .build();
    exactBundle.sourceId = TEST_SOURCE_IDS.GITHUB;

    mockStorage.getCachedBundleMetadata.resolves(undefined);
    mockStorage.getSources.resolves([{
      id: TEST_SOURCE_IDS.GITHUB,
      type: 'github',
      name: 'Test Source',
      url: 'https://github.com/test/repo',
      enabled: true,
      priority: 1
    }]);

    sandbox.stub(registryManager, 'searchBundles').resolves([exactBundle]);

    // Act
    const result = await registryManager.getBundleDetails(bundleId);

    // Assert - Should find exact match without needing identity matching
    assert.strictEqual(result.version, '1.0.0');
    assert.ok(result.id.includes('exact-match-bundle'));
  });
});

suite('RegistryManager - Cache-Only Search Behavior', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let registryManager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    registryManager = RegistryManager.getInstance(mockContext);

    mockStorage = sandbox.createStubInstance(RegistryStorage);
    (registryManager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('should return bundles from cache when cacheOnly is true', async () => {
    // Arrange: Set up cached bundles
    const cachedBundle = BundleBuilder.github('cached-owner', 'cached-repo')
      .withVersion('1.0.0')
      .build();
    cachedBundle.sourceId = TEST_SOURCE_IDS.GITHUB;

    const mockSource: RegistrySource = {
      id: TEST_SOURCE_IDS.GITHUB,
      type: 'github',
      name: 'Test Source',
      url: 'https://github.com/test/repo',
      enabled: true,
      priority: 1
    };

    mockStorage.getSources.resolves([mockSource]);
    mockStorage.getCachedSourceBundles.resolves([cachedBundle]);

    // Act
    const result = await registryManager.searchBundles({ cacheOnly: true });

    // Assert: Should return the cached bundle
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, cachedBundle.id);
    assert.strictEqual(result[0].version, '1.0.0');
  });

  test('should return empty array when cache is empty and cacheOnly is true', async () => {
    // Arrange: Empty cache
    const mockSource: RegistrySource = {
      id: TEST_SOURCE_IDS.GITHUB,
      type: 'github',
      name: 'Test Source',
      url: 'https://github.com/test/repo',
      enabled: true,
      priority: 1
    };

    mockStorage.getSources.resolves([mockSource]);
    mockStorage.getCachedSourceBundles.resolves([]);

    // Act
    const result = await registryManager.searchBundles({ cacheOnly: true });

    // Assert: Should return empty array (not throw, not hang)
    assert.strictEqual(result.length, 0);
  });
});

suite('RegistryManager - Readme Revision Reuse', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;

  const sourceId = 'readme-revision-test-source';
  const mockSource: RegistrySource = {
    id: sourceId,
    type: 'github',
    name: 'Readme Revision Source',
    url: 'https://github.com/test/repo',
    enabled: true,
    priority: 1
  };

  const waitForReadmeComplete = () => new Promise<{ succeeded: string[]; failed: string[] }>((resolve) => {
    const disposable = manager.onReadmeDownloadComplete((e) => {
      if (e.sourceId === sourceId) {
        disposable.dispose();
        resolve(e);
      }
    });
  });

  const buildFreshBundle = (readmeRevision: string): Bundle => {
    const bundle = BundleBuilder.github('test', 'repo').withVersion('1.0.0').build();
    bundle.sourceId = sourceId;
    bundle.readmeUrl = 'https://example.com/readme.md';
    bundle.readmeRevision = readmeRevision;
    bundle.readme = undefined;
    return bundle;
  };

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    manager = RegistryManager.getInstance(mockContext);
    // Ensure syncSource builds the adapter via the stubbed factory rather than a cached instance
    (manager as any).adapters.delete(sourceId);

    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([mockSource]);
    mockStorage.getInstalledBundles.resolves([]);
    (manager as any).storage = mockStorage;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('reuses cached readme when the revision is unchanged', async () => {
    const fresh = buildFreshBundle('rev-1');
    const cached: Bundle = { ...buildFreshBundle('rev-1'), readme: 'CACHED CONTENT' };
    mockStorage.getCachedSourceBundles.resolves([cached]);

    const downloadReadme = sandbox.stub().resolves('FRESH CONTENT');
    sandbox.stub(RepositoryAdapterFactory, 'create').returns({
      type: 'github',
      fetchBundles: sandbox.stub().resolves([fresh]),
      downloadReadme
    } as any);

    const complete = waitForReadmeComplete();
    await manager.syncSource(sourceId);
    const result = await complete;

    assert.strictEqual(downloadReadme.callCount, 0, 'should not re-download an unchanged readme');
    assert.strictEqual(fresh.readme, 'CACHED CONTENT', 'should reuse the cached readme content');
    assert.deepStrictEqual(result.succeeded, [], 'no readme should be reported as freshly downloaded');
  });

  test('re-downloads readme when the revision changed', async () => {
    const fresh = buildFreshBundle('rev-2');
    const cached: Bundle = { ...buildFreshBundle('rev-1'), readme: 'STALE CONTENT' };
    mockStorage.getCachedSourceBundles.resolves([cached]);

    const downloadReadme = sandbox.stub().resolves('FRESH CONTENT');
    sandbox.stub(RepositoryAdapterFactory, 'create').returns({
      type: 'github',
      fetchBundles: sandbox.stub().resolves([fresh]),
      downloadReadme
    } as any);

    const complete = waitForReadmeComplete();
    await manager.syncSource(sourceId);
    const result = await complete;

    assert.strictEqual(downloadReadme.callCount, 1, 'should re-download when the revision changed');
    assert.strictEqual(fresh.readme, 'FRESH CONTENT', 'should replace the stale readme with fresh content');
    assert.deepStrictEqual(result.succeeded, [fresh.id], 'the refreshed readme should be reported as downloaded');
  });
});

suite('RegistryManager - Adapter Cache Clearing', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let registryManager: RegistryManager;

  setup(() => {
    sandbox = sinon.createSandbox();

    mockContext = {
      globalState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      workspaceState: {
        get: sandbox.stub(),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;

    registryManager = RegistryManager.getInstance(mockContext);
  });

  teardown(() => {
    sandbox.restore();
  });

  test('clearAdapterCache should not throw for any source ID', () => {
    // This tests the public API contract - method should be safe to call
    assert.doesNotThrow(() => {
      registryManager.clearAdapterCache('non-existent-source');
      registryManager.clearAdapterCache('source-1');
      registryManager.clearAdapterCache('');
    });
  });
});
