/**
 * BundleScopeCommands Unit Tests
 *
 * Tests for bundle scope management commands including:
 * - Move operations between scopes (user <-> repository)
 * - Commit mode switching (commit <-> local-only)
 * - Context menu visibility based on bundle scope/mode
 *
 * Requirements: 7.1-7.10
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleScopeCommands,
} from '../../src/commands/bundle-scope-commands';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RepositoryScopeService,
} from '../../src/services/repository-scope-service';
import {
  ScopeConflictResolver,
} from '../../src/services/scope-conflict-resolver';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  InstallationScope,
  InstalledBundle,
  RepositoryCommitMode,
} from '../../src/types/registry';
import {
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';

suite('BundleScopeCommands', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRegistryManager: sinon.SinonStubbedInstance<RegistryManager>;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let mockScopeConflictResolver: sinon.SinonStubbedInstance<ScopeConflictResolver>;
  let mockRepositoryScopeService: sinon.SinonStubbedInstance<RepositoryScopeService>;
  let mockLockfileManager: sinon.SinonStubbedInstance<LockfileManager>;
  let mockShowInformationMessage: sinon.SinonStub;
  let mockShowWarningMessage: sinon.SinonStub;
  let mockShowErrorMessage: sinon.SinonStub;
  let mockWithProgress: sinon.SinonStub;
  let mockWorkspaceFolders: vscode.WorkspaceFolder[] | undefined;

  // Test data
  const testBundleId = 'test-bundle';
  const testBundleName = 'Test Bundle';

  // Helper to create mock installed bundle
  const createTestInstalledBundle = (
    scope: InstallationScope,
    commitMode?: RepositoryCommitMode
  ): InstalledBundle => {
    return createMockInstalledBundle(testBundleId, '1.0.0', {
      scope,
      commitMode,
      installPath: `/mock/path/${testBundleId}`
    });
  };

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create mock instances
    mockRegistryManager = sandbox.createStubInstance(RegistryManager);
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockScopeConflictResolver = sandbox.createStubInstance(ScopeConflictResolver);
    mockRepositoryScopeService = sandbox.createStubInstance(RepositoryScopeService);
    mockLockfileManager = sandbox.createStubInstance(LockfileManager);

    // Setup VS Code mocks
    mockShowInformationMessage = sandbox.stub(vscode.window, 'showInformationMessage');
    mockShowWarningMessage = sandbox.stub(vscode.window, 'showWarningMessage');
    mockShowErrorMessage = sandbox.stub(vscode.window, 'showErrorMessage');
    mockWithProgress = sandbox.stub(vscode.window, 'withProgress');

    // Setup workspace folders mock
    mockWorkspaceFolders = [{ uri: vscode.Uri.file('/mock/workspace'), name: 'workspace', index: 0 }];
    sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => mockWorkspaceFolders);

    // Setup LockfileManager.getInstance to return our mock
    sandbox.stub(LockfileManager, 'getInstance').returns(mockLockfileManager);
    mockLockfileManager.updateCommitMode.resolves();

    // Setup default behaviors
    mockRegistryManager.getStorage.returns(mockStorage);
    mockRegistryManager.getBundleName.resolves(testBundleName);
    mockWithProgress.callsFake(async (_options: any, callback: any) => {
      return await callback({ report: sandbox.stub() });
    });
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('moveToRepository()', () => {
    test('should move bundle from user scope to repository scope with commit mode', async () => {
      // Arrange
      const userBundle = createTestInstalledBundle('user');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(userBundle);
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(undefined);
      mockScopeConflictResolver.migrateBundle.resolves({ success: true, bundleId: testBundleId, fromScope: 'user', toScope: 'repository' });
      mockShowWarningMessage.resolves('Move');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToRepository(testBundleId, 'commit');

      // Assert
      assert.ok(mockScopeConflictResolver.migrateBundle.calledOnce, 'migrateBundle should be called');
      assert.ok(mockShowInformationMessage.calledOnce, 'Success message should be shown');
    });

    test('should move bundle from user scope to repository scope with local-only mode', async () => {
      // Arrange
      const userBundle = createTestInstalledBundle('user');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(userBundle);
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(undefined);
      mockScopeConflictResolver.migrateBundle.resolves({ success: true, bundleId: testBundleId, fromScope: 'user', toScope: 'repository' });
      mockShowWarningMessage.resolves('Move');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToRepository(testBundleId, 'local-only');

      // Assert
      assert.ok(mockScopeConflictResolver.migrateBundle.calledOnce, 'migrateBundle should be called');
    });

    test('should abort move if user cancels confirmation', async () => {
      // Arrange
      const userBundle = createTestInstalledBundle('user');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(userBundle);
      mockShowWarningMessage.resolves('Cancel');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToRepository(testBundleId, 'commit');

      // Assert
      assert.ok(mockScopeConflictResolver.migrateBundle.notCalled, 'migrateBundle should not be called');
    });

    test('should show error if bundle is not installed at user scope', async () => {
      // Arrange
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(undefined);

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToRepository(testBundleId, 'commit');

      // Assert
      assert.ok(mockShowErrorMessage.calledOnce, 'Error message should be shown');
    });

    test('should show error if no workspace is open', async () => {
      // Arrange
      mockWorkspaceFolders = undefined;
      const userBundle = createTestInstalledBundle('user');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(userBundle);

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToRepository(testBundleId, 'commit');

      // Assert
      assert.ok(mockShowErrorMessage.calledOnce, 'Error message should be shown');
    });

    test('should pass user scope to uninstallBundle — Validates: Requirement 3.2', async () => {
      // Arrange: bundle exists at user scope
      const userBundle = createTestInstalledBundle('user');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(userBundle);
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(undefined);
      mockShowWarningMessage.resolves('Move');
      mockRegistryManager.uninstallBundle.resolves();
      mockRegistryManager.installBundle.resolves();

      // Capture and execute the uninstall callback using callsFake()
      mockScopeConflictResolver.migrateBundle.callsFake(
        async (_bundleId, _fromScope, _toScope, uninstallCallback, _installCallback) => {
          await uninstallCallback(userBundle);
          return { success: true, bundleId: testBundleId, fromScope: 'user', toScope: 'repository' };
        }
      );

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToRepository(testBundleId, 'commit');

      // Assert: Verify uninstallBundle was called with 'user' scope
      assert.ok(
        mockRegistryManager.uninstallBundle.calledWith(testBundleId, 'user'),
        'uninstallBundle should be called with user scope'
      );
    });
  });

  suite('moveToUser()', () => {
    test('should move bundle from repository scope to user scope', async () => {
      // Arrange
      const repoBundle = createTestInstalledBundle('repository', 'commit');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(repoBundle);
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(undefined);
      mockScopeConflictResolver.migrateBundle.resolves({ success: true, bundleId: testBundleId, fromScope: 'repository', toScope: 'user' });
      mockShowWarningMessage.resolves('Move');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToUser(testBundleId);

      // Assert
      assert.ok(mockScopeConflictResolver.migrateBundle.calledOnce, 'migrateBundle should be called');
      assert.ok(mockShowInformationMessage.calledOnce, 'Success message should be shown');
    });

    test('should abort move if user cancels confirmation', async () => {
      // Arrange
      const repoBundle = createTestInstalledBundle('repository', 'commit');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(repoBundle);
      mockShowWarningMessage.resolves('Cancel');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToUser(testBundleId);

      // Assert
      assert.ok(mockScopeConflictResolver.migrateBundle.notCalled, 'migrateBundle should not be called');
    });

    test('should show error if bundle is not installed at repository scope', async () => {
      // Arrange
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(undefined);

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToUser(testBundleId);

      // Assert
      assert.ok(mockShowErrorMessage.calledOnce, 'Error message should be shown');
    });

    test('should pass repository scope to uninstallBundle — Validates: Requirement 3.1', async () => {
      // Arrange: bundle exists at repository scope
      const repoBundle = createTestInstalledBundle('repository', 'commit');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(repoBundle);
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(undefined);
      mockShowWarningMessage.resolves('Move');
      mockRegistryManager.uninstallBundle.resolves();
      mockRegistryManager.installBundle.resolves();

      // Capture and execute the uninstall callback using callsFake()
      mockScopeConflictResolver.migrateBundle.callsFake(
        async (_bundleId, _fromScope, _toScope, uninstallCallback, _installCallback) => {
          await uninstallCallback(repoBundle);
          return { success: true, bundleId: testBundleId, fromScope: 'repository', toScope: 'user' };
        }
      );

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToUser(testBundleId);

      // Assert: Verify uninstallBundle was called with 'repository' scope
      assert.ok(
        mockRegistryManager.uninstallBundle.calledWith(testBundleId, 'repository'),
        'uninstallBundle should be called with repository scope'
      );
    });
  });

  suite('switchCommitMode()', () => {
    test('should switch from commit mode to local-only mode', async () => {
      // Arrange
      const repoBundle = createTestInstalledBundle('repository', 'commit');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(repoBundle);
      mockRepositoryScopeService.switchCommitMode.resolves();
      mockShowWarningMessage.resolves('Switch');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.switchCommitMode(testBundleId, 'local-only');

      // Assert
      assert.ok(mockRepositoryScopeService.switchCommitMode.calledOnceWith(testBundleId, 'local-only'), 'switchCommitMode should be called with correct args');
      assert.ok(mockShowInformationMessage.calledOnce, 'Success message should be shown');
    });

    test('should switch from local-only mode to commit mode', async () => {
      // Arrange
      const repoBundle = createTestInstalledBundle('repository', 'local-only');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(repoBundle);
      mockRepositoryScopeService.switchCommitMode.resolves();
      mockShowWarningMessage.resolves('Switch');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.switchCommitMode(testBundleId, 'commit');

      // Assert
      assert.ok(mockRepositoryScopeService.switchCommitMode.calledOnceWith(testBundleId, 'commit'), 'switchCommitMode should be called with correct args');
    });

    test('should abort switch if user cancels confirmation', async () => {
      // Arrange
      const repoBundle = createTestInstalledBundle('repository', 'commit');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(repoBundle);
      mockShowWarningMessage.resolves('Cancel');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.switchCommitMode(testBundleId, 'local-only');

      // Assert
      assert.ok(mockRepositoryScopeService.switchCommitMode.notCalled, 'switchCommitMode should not be called');
    });

    test('should show error if bundle is not installed at repository scope', async () => {
      // Arrange
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(undefined);

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.switchCommitMode(testBundleId, 'local-only');

      // Assert
      assert.ok(mockShowErrorMessage.calledOnce, 'Error message should be shown');
    });

    test('should show error if bundle is already in the target mode', async () => {
      // Arrange
      const repoBundle = createTestInstalledBundle('repository', 'commit');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(repoBundle);

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.switchCommitMode(testBundleId, 'commit');

      // Assert
      assert.ok(mockShowInformationMessage.calledOnce, 'Info message should be shown');
      assert.ok(mockRepositoryScopeService.switchCommitMode.notCalled, 'switchCommitMode should not be called');
    });
  });

  suite('Error Handling', () => {
    test('should handle migration failure gracefully', async () => {
      // Arrange
      const userBundle = createTestInstalledBundle('user');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'user').resolves(userBundle);
      mockScopeConflictResolver.migrateBundle.resolves({
        success: false,
        bundleId: testBundleId,
        fromScope: 'user',
        toScope: 'repository',
        error: 'Migration failed'
      });
      mockShowWarningMessage.resolves('Move');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.moveToRepository(testBundleId, 'commit');

      // Assert
      assert.ok(mockShowErrorMessage.calledOnce, 'Error message should be shown');
    });

    test('should handle switchCommitMode failure gracefully', async () => {
      // Arrange
      const repoBundle = createTestInstalledBundle('repository', 'commit');
      mockStorage.getInstalledBundle.withArgs(testBundleId, 'repository').resolves(repoBundle);
      mockRepositoryScopeService.switchCommitMode.rejects(new Error('Switch failed'));
      mockShowWarningMessage.resolves('Switch');

      const commands = new BundleScopeCommands(
        mockRegistryManager,
        mockScopeConflictResolver,
        mockRepositoryScopeService

      );

      // Act
      await commands.switchCommitMode(testBundleId, 'local-only');

      // Assert
      assert.ok(mockShowErrorMessage.calledOnce, 'Error message should be shown');
    });
  });
});
