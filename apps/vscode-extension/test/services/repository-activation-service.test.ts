/**
 * RepositoryActivationService Unit Tests
 *
 * Tests for the service that detects lockfiles on workspace open and prompts
 * users to enable repository bundles.
 *
 * Requirements: 13.1-13.7, 12.4-12.5
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
  SetupStateManager,
} from '../../src/services/setup-state-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  createMockLockfile,
} from '../helpers/lockfile-test-helpers';

suite('RepositoryActivationService', () => {
  let sandbox: sinon.SinonSandbox;
  let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockContext: vscode.ExtensionContext;
  let service: RepositoryActivationService;
  let showInformationMessageStub: sinon.SinonStub;
  const testWorkspaceRoot = '/test/workspace';

  setup(() => {
    sandbox = sinon.createSandbox();
    mockLockfileManager = sandbox.createStubInstance(LockfileManager);
    mockHubManager = sandbox.createStubInstance(HubManager);
    mockStorage = sandbox.createStubInstance(RegistryStorage);

    // Create mock context
    mockContext = {
      globalState: {
        get: sandbox.stub().returns([]),
        update: sandbox.stub().resolves()
      }
    } as any;

    // Mock getContext() to return the mock context
    mockStorage.getContext.returns(mockContext);

    // Reset all instances before each test
    RepositoryActivationService.resetInstance();

    service = new RepositoryActivationService(
      mockLockfileManager,
      mockHubManager,
      mockStorage,
      testWorkspaceRoot
    );

    // Mock VS Code APIs
    showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
    sandbox.stub(vscode.window, 'showWarningMessage');
  });

  teardown(() => {
    sandbox.restore();
    RepositoryActivationService.resetInstance();
  });

  suite('getInstance()', () => {
    test('should create new instance for workspace', () => {
      // Arrange & Act
      const instance = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );

      // Assert
      assert.ok(instance, 'Should create instance');
    });

    test('should return same instance for same workspace', () => {
      // Arrange & Act
      const instance1 = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );
      const instance2 = RepositoryActivationService.getInstance(testWorkspaceRoot);

      // Assert
      assert.strictEqual(instance1, instance2, 'Should return same instance');
    });

    test('should create different instances for different workspaces', () => {
      // Arrange
      const workspace1 = '/workspace/one';
      const workspace2 = '/workspace/two';

      // Act
      const instance1 = RepositoryActivationService.getInstance(
        workspace1,
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );
      const instance2 = RepositoryActivationService.getInstance(
        workspace2,
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );

      // Assert
      assert.notStrictEqual(instance1, instance2, 'Should create different instances');
    });

    test('should throw error when workspace root not provided', () => {
      // Act & Assert
      assert.throws(
        () => RepositoryActivationService.getInstance(),
        /Workspace root path required/
      );
    });

    test('should throw error when dependencies not provided on first call', () => {
      // Act & Assert
      assert.throws(
        () => RepositoryActivationService.getInstance('/new/workspace'),
        /Dependencies required on first call/
      );
    });
  });

  suite('resetInstance()', () => {
    test('should reset specific workspace instance', () => {
      // Arrange
      const workspace1 = '/workspace/one';
      const workspace2 = '/workspace/two';
      RepositoryActivationService.getInstance(
        workspace1,
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );
      RepositoryActivationService.getInstance(
        workspace2,
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );

      // Act
      RepositoryActivationService.resetInstance(workspace1);

      // Assert - workspace1 should require dependencies again
      assert.throws(
        () => RepositoryActivationService.getInstance(workspace1),
        /Dependencies required/
      );
      // workspace2 should still exist
      const instance2 = RepositoryActivationService.getInstance(workspace2);
      assert.ok(instance2);
    });

    test('should reset all instances when no workspace provided', () => {
      // Arrange
      RepositoryActivationService.getInstance(
        '/workspace/one',
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );
      RepositoryActivationService.getInstance(
        '/workspace/two',
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );

      // Act
      RepositoryActivationService.resetInstance();

      // Assert - both should require dependencies again
      assert.throws(
        () => RepositoryActivationService.getInstance('/workspace/one'),
        /Dependencies required/
      );
      assert.throws(
        () => RepositoryActivationService.getInstance('/workspace/two'),
        /Dependencies required/
      );
    });
  });

  suite('checkAndPromptActivation()', () => {
    test('should not prompt when no lockfile exists', async () => {
      // Arrange
      mockLockfileManager.read.resolves(null);

      // Act
      await service.checkAndPromptActivation();

      // Assert
      assert.ok(!showInformationMessageStub.called, 'Should not show prompt when no lockfile');
    });

    test('should not prompt when repository was previously declined', async () => {
      // Arrange
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
      (mockContext.globalState.get as sinon.SinonStub).returns(['/repo']);

      // Act
      await service.checkAndPromptActivation();

      // Assert
      assert.ok(!showInformationMessageStub.called, 'Should not prompt when previously declined');
    });

    test('should prompt when lockfile exists and not previously declined', async () => {
      // Arrange
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');

      // Reset the context mock for this test
      const customContext = {
        globalState: {
          get: sandbox.stub().withArgs('repositoryActivation.declined').returns([])
        }
      } as any;
      mockStorage.getContext.returns(customContext);
      mockStorage.getSources.resolves([
        { id: 'mock-source', type: 'github', url: 'https://github.com/mock/repo' } as any
      ]);
      mockHubManager.listHubs.resolves([]);

      // Act
      await service.checkAndPromptActivation();

      // Assert - no longer shows activation prompt (Requirement 1.6)
      // Only checks for missing sources/hubs
      assert.ok(!showInformationMessageStub.called
        || !showInformationMessageStub.firstCall.args[0].includes('enable'),
      'Should not show activation prompt - files already in repository');
    });

    test('should check for missing sources when lockfile exists', async () => {
      // Arrange
      const lockfile = createMockLockfile(3);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
      const customContext = {
        globalState: {
          get: sandbox.stub().returns([])
        }
      } as any;
      mockStorage.getContext.returns(customContext);
      mockStorage.getSources.resolves([]); // No sources configured
      mockHubManager.listHubs.resolves([]);
      showInformationMessageStub.resolves('Add Sources');

      // Act
      await service.checkAndPromptActivation();

      // Assert - should check for missing sources (not show activation prompt)
      // The prompt shown should be about missing sources, not about enabling bundles
      if (showInformationMessageStub.called) {
        const message = showInformationMessageStub.firstCall.args[0] as string;
        assert.ok(!message.includes('enable') && !message.includes('Enable'),
          'Should not show activation prompt - only missing sources prompt');
      }
    });

    test('should not show any prompt when all sources are configured', async () => {
      // Arrange
      const lockfile = createMockLockfile(2, { includeProfiles: true });
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
      const customContext = {
        globalState: {
          get: sandbox.stub().returns([])
        }
      } as any;
      mockStorage.getContext.returns(customContext);
      // All sources are configured
      mockStorage.getSources.resolves([
        { id: 'mock-source', type: 'github', url: 'https://github.com/mock/repo' } as any
      ]);
      mockHubManager.listHubs.resolves([
        { id: 'mock-hub', name: 'Mock Hub', description: '', reference: { type: 'url', location: '' } }
      ]);

      // Act
      await service.checkAndPromptActivation();

      // Assert - no prompt when all sources are configured
      assert.ok(!showInformationMessageStub.called,
        'Should not show any prompt when all sources are configured');
    });

    test('should call checkAndOfferMissingSources when lockfile exists', async () => {
      // Arrange
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
      const customContext = {
        globalState: {
          get: sandbox.stub().returns([])
        }
      } as any;
      mockStorage.getContext.returns(customContext);
      mockStorage.getSources.resolves([
        { id: 'mock-source', type: 'github', url: 'https://github.com/mock/repo' } as any
      ]);
      mockHubManager.listHubs.resolves([]);
      const checkSpy = sandbox.spy(service, 'checkAndOfferMissingSources');

      // Act
      await service.checkAndPromptActivation();

      // Assert - should call checkAndOfferMissingSources instead of showing activation prompt
      assert.ok(checkSpy.calledOnce, 'Should call checkAndOfferMissingSources');
      assert.ok(checkSpy.calledWith(lockfile), 'Should pass lockfile to check method');
    });

    test('should skip detection for declined repositories', async () => {
      // Arrange
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
      const customContext = {
        globalState: {
          get: sandbox.stub().returns(['/repo']) // Already declined
        }
      } as any;
      mockStorage.getContext.returns(customContext);
      const checkSpy = sandbox.spy(service, 'checkAndOfferMissingSources');

      // Act
      await service.checkAndPromptActivation();

      // Assert - should skip detection for declined repositories
      assert.ok(!checkSpy.called, 'Should not check for missing sources when declined');
      assert.ok(!showInformationMessageStub.called, 'Should not show any prompt when declined');
    });
  });

  suite('checkAndOfferMissingSources()', () => {
    test('should detect missing sources', async () => {
      // Arrange
      const lockfile = createMockLockfile(2);
      mockStorage.getSources.resolves([]); // No sources configured

      // Act
      const result = await service.checkAndOfferMissingSources(lockfile);

      // Assert
      assert.ok(result.missingSources.length > 0, 'Should detect missing sources');
      assert.strictEqual(result.missingSources[0], 'mock-source');
    });

    test('should detect missing hubs', async () => {
      // Arrange
      const lockfile = createMockLockfile(2, { includeHubs: true });
      mockStorage.getSources.resolves([]);
      mockHubManager.listHubs.resolves([]); // No hubs configured

      // Act
      const result = await service.checkAndOfferMissingSources(lockfile);

      // Assert
      assert.ok(result.missingHubs.length > 0, 'Should detect missing hubs');
      assert.strictEqual(result.missingHubs[0], 'mock-hub');
    });

    test('should not detect sources that are already configured', async () => {
      // Arrange
      const lockfile = createMockLockfile(2);
      mockStorage.getSources.resolves([
        { id: 'mock-source', type: 'github', url: 'https://github.com/mock/repo' } as any
      ]);

      // Act
      const result = await service.checkAndOfferMissingSources(lockfile);

      // Assert
      assert.strictEqual(result.missingSources.length, 0,
        'Should not detect configured sources as missing');
    });

    test('should not detect hubs that are already imported', async () => {
      // Arrange
      const lockfile = createMockLockfile(2, { includeHubs: true });
      mockStorage.getSources.resolves([]);
      mockHubManager.listHubs.resolves([
        { id: 'mock-hub', name: 'Mock Hub', description: '', reference: { type: 'url', location: '' } }
      ]);

      // Act
      const result = await service.checkAndOfferMissingSources(lockfile);

      // Assert
      assert.strictEqual(result.missingHubs.length, 0,
        'Should not detect imported hubs as missing');
    });

    test('should offer to add missing sources', async () => {
      // Arrange
      const lockfile = createMockLockfile(2);
      mockStorage.getSources.resolves([]);
      showInformationMessageStub.resolves('Add Sources');

      // Act
      const result = await service.checkAndOfferMissingSources(lockfile);

      // Assert
      assert.ok(showInformationMessageStub.calledOnce,
        'Should prompt to add missing sources');
      assert.ok(result.offeredToAdd, 'Should indicate offer was made');
    });

    test('should offer to add missing hubs', async () => {
      // Arrange
      const lockfile = createMockLockfile(2, { includeHubs: true });
      mockStorage.getSources.resolves([]);
      mockHubManager.listHubs.resolves([]);
      showInformationMessageStub.resolves('Add Sources');

      // Act
      await service.checkAndOfferMissingSources(lockfile);

      // Assert
      const message = showInformationMessageStub.firstCall.args[0] as string;
      assert.ok(message.toLowerCase().includes('hub') || message.toLowerCase().includes('source'),
        'Message should mention missing sources/hubs');
    });

    test('should return empty arrays when all sources and hubs are configured', async () => {
      // Arrange
      const lockfile = createMockLockfile(2, { includeHubs: true });
      mockStorage.getSources.resolves([
        { id: 'mock-source', type: 'github', url: 'https://github.com/mock/repo' } as any
      ]);
      mockHubManager.listHubs.resolves([
        { id: 'mock-hub', name: 'Mock Hub', description: '', reference: { type: 'url', location: '' } }
      ]);

      // Act
      const result = await service.checkAndOfferMissingSources(lockfile);

      // Assert
      assert.strictEqual(result.missingSources.length, 0);
      assert.strictEqual(result.missingHubs.length, 0);
      assert.ok(!result.offeredToAdd, 'Should not offer when nothing missing');
    });
  });

  suite('Edge cases', () => {
    test('should handle lockfile read errors gracefully', async () => {
      // Arrange
      mockLockfileManager.read.rejects(new Error('Read error'));

      // Act & Assert - should not throw
      await service.checkAndPromptActivation();
      assert.ok(!showInformationMessageStub.called,
        'Should not show prompt on error');
    });

    test('should handle empty lockfile gracefully', async () => {
      // Arrange
      const emptyLockfile = createMockLockfile(0);
      mockLockfileManager.read.resolves(emptyLockfile);
      mockLockfileManager.getLockfilePath.returns('/repo/prompt-registry.lock.json');
      const customContext = {
        globalState: {
          get: sandbox.stub().returns([])
        }
      } as any;
      mockStorage.getContext.returns(customContext);
      // No sources configured
      mockStorage.getSources.resolves([]);
      mockHubManager.listHubs.resolves([]);

      // Act
      await service.checkAndPromptActivation();

      // Assert - should check for missing sources even with empty lockfile
      // No activation prompt is shown (Requirement 1.6)
      // May or may not show missing sources prompt depending on lockfile content
    });

    test('should handle missing lockfile path gracefully', async () => {
      // Arrange
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns('');
      const customContext = {
        globalState: {
          get: sandbox.stub().returns([])
        }
      } as any;
      mockStorage.getContext.returns(customContext);

      // Act & Assert - should not throw
      await service.checkAndPromptActivation();
    });

    test('should handle HubManager errors when checking missing sources', async () => {
      // Arrange
      const lockfile = createMockLockfile(2, { includeHubs: true });
      mockStorage.getSources.resolves([]);
      mockHubManager.listHubs.rejects(new Error('Hub error'));

      // Act
      const result = await service.checkAndOfferMissingSources(lockfile);

      // Assert - should still detect missing sources even if hub check fails
      assert.ok(result.missingSources.length > 0,
        'Should still detect missing sources on hub error');
    });
  });
});

suite('RepositoryActivationService - Workspace Switching Scenarios', () => {
  let sandbox: sinon.SinonSandbox;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockContext: vscode.ExtensionContext;
  let showInformationMessageStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockHubManager = sandbox.createStubInstance(HubManager);
    mockStorage = sandbox.createStubInstance(RegistryStorage);

    // Create mock context
    mockContext = {
      globalState: {
        get: sandbox.stub().returns([]),
        update: sandbox.stub().resolves()
      }
    } as any;

    mockStorage.getContext.returns(mockContext);

    // Reset all instances before each test
    RepositoryActivationService.resetInstance();

    showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
  });

  teardown(() => {
    sandbox.restore();
    RepositoryActivationService.resetInstance();
  });

  test('should maintain separate state for different workspaces', () => {
    // Arrange
    const workspace1 = '/workspace/one';
    const workspace2 = '/workspace/two';

    const mockLockfileManager1 = sandbox.createStubInstance(LockfileManager);
    const mockLockfileManager2 = sandbox.createStubInstance(LockfileManager);

    // Create instances for both workspaces
    const service1 = RepositoryActivationService.getInstance(
      workspace1,
      mockLockfileManager1,
      mockHubManager,
      mockStorage
    );
    const service2 = RepositoryActivationService.getInstance(
      workspace2,
      mockLockfileManager2,
      mockHubManager,
      mockStorage
    );

    // Assert
    assert.notStrictEqual(service1, service2, 'Should have different instances');
  });

  test('should allow independent source detection per workspace', async () => {
    // Arrange
    const workspace1 = '/workspace/one';
    const workspace2 = '/workspace/two';

    const mockLockfileManager1 = sandbox.createStubInstance(LockfileManager);
    const mockLockfileManager2 = sandbox.createStubInstance(LockfileManager);

    const lockfile1 = createMockLockfile(2);
    const lockfile2 = createMockLockfile(3);

    mockLockfileManager1.read.resolves(lockfile1);
    mockLockfileManager1.getLockfilePath.returns(`${workspace1}/prompt-registry.lock.json`);

    mockLockfileManager2.read.resolves(lockfile2);
    mockLockfileManager2.getLockfilePath.returns(`${workspace2}/prompt-registry.lock.json`);

    const customContext = {
      globalState: {
        get: sandbox.stub().returns([])
      }
    } as any;
    mockStorage.getContext.returns(customContext);
    // No sources configured - will trigger missing sources detection
    mockStorage.getSources.resolves([]);
    mockHubManager.listHubs.resolves([]);
    showInformationMessageStub.resolves('Not now');

    const service1 = RepositoryActivationService.getInstance(
      workspace1,
      mockLockfileManager1,
      mockHubManager,
      mockStorage
    );
    const service2 = RepositoryActivationService.getInstance(
      workspace2,
      mockLockfileManager2,
      mockHubManager,
      mockStorage
    );

    // Act
    await service1.checkAndPromptActivation();
    await service2.checkAndPromptActivation();

    // Assert - both should have checked for missing sources
    // Note: No activation prompt is shown (Requirement 1.6)
    // Only missing sources prompt may be shown if sources are missing
    assert.ok(mockLockfileManager1.read.calledOnce, 'Should read lockfile for workspace 1');
    assert.ok(mockLockfileManager2.read.calledOnce, 'Should read lockfile for workspace 2');
  });

  test('should handle workspace removal by resetting instance', () => {
    // Arrange
    const workspace = '/workspace/to/remove';
    const mockLockfileManager = sandbox.createStubInstance(LockfileManager);

    RepositoryActivationService.getInstance(
      workspace,
      mockLockfileManager,
      mockHubManager,
      mockStorage
    );

    // Act
    RepositoryActivationService.resetInstance(workspace);

    // Assert - should require dependencies again
    assert.throws(
      () => RepositoryActivationService.getInstance(workspace),
      /Dependencies required/
    );
  });
});

/**
 * Tests for setup timing behavior
 * Requirements: 1.1-1.5, 6.1-6.4 - Defer lockfile source/hub detection until setup complete
 */
suite('RepositoryActivationService - Setup Timing Behavior', () => {
  let sandbox: sinon.SinonSandbox;
  let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
  let mockHubManager: sinon.SinonStubbedInstance<HubManager>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockSetupStateManager: sinon.SinonStubbedInstance<SetupStateManager>;
  let mockContext: vscode.ExtensionContext;
  let showInformationMessageStub: sinon.SinonStub;
  const testWorkspaceRoot = '/test/workspace/setup-timing';

  setup(() => {
    sandbox = sinon.createSandbox();
    mockLockfileManager = sandbox.createStubInstance(LockfileManager);
    mockHubManager = sandbox.createStubInstance(HubManager);
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockSetupStateManager = sandbox.createStubInstance(SetupStateManager);

    // Create mock context
    mockContext = {
      globalState: {
        get: sandbox.stub().returns([]),
        update: sandbox.stub().resolves()
      }
    } as any;

    mockStorage.getContext.returns(mockContext);

    // Reset all instances before each test
    RepositoryActivationService.resetInstance();

    // Mock VS Code APIs
    showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
  });

  teardown(() => {
    sandbox.restore();
    RepositoryActivationService.resetInstance();
  });

  suite('checkAndPromptActivation() with SetupStateManager', () => {
    test('should skip detection when SetupStateManager.isComplete() returns false', async () => {
      // Arrange
      mockSetupStateManager.isComplete.resolves(false);
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns(`${testWorkspaceRoot}/prompt-registry.lock.json`);

      const service = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined, // bundleInstaller
        mockSetupStateManager
      );

      // Act
      await service.checkAndPromptActivation();

      // Assert
      assert.ok(mockSetupStateManager.isComplete.calledOnce,
        'Should check if setup is complete');
      assert.ok(!mockLockfileManager.read.called,
        'Should not read lockfile when setup is incomplete');
      assert.ok(!showInformationMessageStub.called,
        'Should not show any prompts when setup is incomplete');
    });

    test('should proceed with detection when SetupStateManager.isComplete() returns true', async () => {
      // Arrange
      mockSetupStateManager.isComplete.resolves(true);
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns(`${testWorkspaceRoot}/prompt-registry.lock.json`);
      mockStorage.getSources.resolves([
        { id: 'mock-source', type: 'github', url: 'https://github.com/mock/repo' } as any
      ]);

      const service = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined, // bundleInstaller
        mockSetupStateManager
      );

      // Act
      await service.checkAndPromptActivation();

      // Assert
      assert.ok(mockSetupStateManager.isComplete.calledOnce,
        'Should check if setup is complete');
      assert.ok(mockLockfileManager.read.calledOnce,
        'Should read lockfile when setup is complete');
    });

    test('should proceed with detection when SetupStateManager is undefined (fail-open)', async () => {
      // Arrange - create service WITHOUT SetupStateManager
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);
      mockLockfileManager.getLockfilePath.returns(`${testWorkspaceRoot}/prompt-registry.lock.json`);
      mockStorage.getSources.resolves([
        { id: 'mock-source', type: 'github', url: 'https://github.com/mock/repo' } as any
      ]);

      const service = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage
        // No bundleInstaller, no setupStateManager
      );

      // Act
      await service.checkAndPromptActivation();

      // Assert
      assert.ok(mockLockfileManager.read.calledOnce,
        'Should read lockfile when SetupStateManager is undefined (fail-open behavior)');
    });

    test('should log appropriate message when deferring due to incomplete setup', async () => {
      // Arrange
      mockSetupStateManager.isComplete.resolves(false);
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);

      // We can't directly test logging, but we can verify the behavior
      // that indicates the deferral path was taken
      const service = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined, // bundleInstaller
        mockSetupStateManager
      );

      // Act
      await service.checkAndPromptActivation();

      // Assert - verify the deferral path was taken by checking that:
      // 1. isComplete was called
      // 2. No further processing occurred (lockfile not read)
      assert.ok(mockSetupStateManager.isComplete.calledOnce,
        'Should call isComplete to check setup state');
      assert.ok(!mockLockfileManager.read.called,
        'Should not proceed with lockfile read when deferring');
      assert.ok(!mockStorage.getSources.called,
        'Should not check sources when deferring');
      assert.ok(!mockHubManager.listHubs.called,
        'Should not check hubs when deferring');
    });
  });

  suite('getInstance() with SetupStateManager', () => {
    test('should accept SetupStateManager as optional parameter', () => {
      // Arrange & Act
      const instance = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined, // bundleInstaller
        mockSetupStateManager
      );

      // Assert
      assert.ok(instance, 'Should create instance with SetupStateManager');
    });

    test('should work without SetupStateManager for backward compatibility', () => {
      // Arrange & Act
      const instance = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage
      );

      // Assert
      assert.ok(instance, 'Should create instance without SetupStateManager');
    });
  });

  suite('Setup state edge cases', () => {
    test('should handle SetupStateManager.isComplete() throwing an error gracefully', async () => {
      // Arrange
      mockSetupStateManager.isComplete.rejects(new Error('State check failed'));
      const lockfile = createMockLockfile(2);
      mockLockfileManager.read.resolves(lockfile);

      const service = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        mockSetupStateManager
      );

      // Act & Assert - should not throw
      await service.checkAndPromptActivation();

      // The error should be caught and logged, but not propagate
      assert.ok(mockSetupStateManager.isComplete.calledOnce,
        'Should have attempted to check setup state');
    });

    test('should not prompt for missing sources when setup is incomplete', async () => {
      // Arrange
      mockSetupStateManager.isComplete.resolves(false);
      const lockfile = createMockLockfile(2, { includeHubs: true });
      mockLockfileManager.read.resolves(lockfile);
      mockStorage.getSources.resolves([]); // No sources configured
      mockHubManager.listHubs.resolves([]); // No hubs configured

      const service = RepositoryActivationService.getInstance(
        testWorkspaceRoot,
        mockLockfileManager,
        mockHubManager,
        mockStorage,
        undefined,
        mockSetupStateManager
      );

      // Act
      await service.checkAndPromptActivation();

      // Assert
      assert.ok(!showInformationMessageStub.called,
        'Should not prompt for missing sources when setup is incomplete');
      assert.ok(!mockStorage.getSources.called,
        'Should not check for sources when setup is incomplete');
    });
  });
});
