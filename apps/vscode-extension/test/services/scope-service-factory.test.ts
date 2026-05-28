/**
 * ScopeServiceFactory Unit Tests
 *
 * Tests for the factory that creates appropriate scope services based on InstallationScope.
 *
 * Requirements: 1.1, 1.8, 2.5
 */

import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RepositoryScopeService,
} from '../../src/services/repository-scope-service';
import {
  ScopeServiceFactory,
} from '../../src/services/scope-service-factory';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  InstallationScope,
} from '../../src/types/registry';

suite('ScopeServiceFactory', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let workspaceRoot: string;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create mock extension context
    const globalStateData = new Map<string, any>();
    mockContext = {
      globalState: {
        get: (key: string, defaultValue?: any) => globalStateData.get(key) ?? defaultValue,
        update: (key: string, value: any) => {
          globalStateData.set(key, value);
        },
        keys: () => Array.from(globalStateData.keys()),
        setKeysForSync: sandbox.stub()
      } as any,
      globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'test-storage')),
      subscriptions: [],
      extensionUri: vscode.Uri.file('/mock/extension'),
      extensionPath: '/mock/extension',
      storagePath: '/mock/storage',
      globalStoragePath: path.join(os.tmpdir(), 'test-storage'),
      logPath: '/mock/log',
      extensionMode: 3, // ExtensionMode.Test
      workspaceState: {
        get: sandbox.stub() as any,
        update: sandbox.stub(),
        keys: sandbox.stub().returns([])
      },
      secrets: {
        get: sandbox.stub(),
        store: sandbox.stub(),
        delete: sandbox.stub(),
        onDidChange: sandbox.stub()
      } as any,
      environmentVariableCollection: {} as any,
      extension: {} as any,
      asAbsolutePath: (relativePath: string) => path.join('/mock/extension', relativePath),
      storageUri: vscode.Uri.file('/mock/storage'),
      logUri: vscode.Uri.file('/mock/log'),
      languageModelAccessInformation: {} as any
    };

    // Create mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);

    // Set workspace root
    workspaceRoot = path.join(os.tmpdir(), 'test-workspace');
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('create()', () => {
    test('should return UserScopeService for user scope', () => {
      // Arrange
      const scope: InstallationScope = 'user';

      // Act
      const service = ScopeServiceFactory.create(scope, mockContext, workspaceRoot, mockStorage);

      // Assert
      assert.ok(service, 'Service should be created');
      assert.ok(service instanceof UserScopeService, 'Should return UserScopeService instance');
    });

    test('should return UserScopeService for workspace scope', () => {
      // Arrange
      const scope: InstallationScope = 'workspace';

      // Act
      const service = ScopeServiceFactory.create(scope, mockContext, workspaceRoot, mockStorage);

      // Assert
      assert.ok(service, 'Service should be created');
      assert.ok(service instanceof UserScopeService, 'Should return UserScopeService instance for workspace scope');
    });

    test('should return RepositoryScopeService for repository scope', () => {
      // Arrange
      const scope: InstallationScope = 'repository';

      // Act
      const service = ScopeServiceFactory.create(scope, mockContext, workspaceRoot, mockStorage);

      // Assert
      assert.ok(service, 'Service should be created');
      assert.ok(service instanceof RepositoryScopeService, 'Should return RepositoryScopeService instance');
    });

    test('should throw error for unknown scope', () => {
      // Arrange
      const unknownScope = 'unknown' as InstallationScope;

      // Act & Assert
      assert.throws(
        () => ScopeServiceFactory.create(unknownScope, mockContext, workspaceRoot, mockStorage),
        /Unknown installation scope/,
        'Should throw error for unknown scope'
      );
    });
  });

  suite('IScopeService interface compliance', () => {
    test('UserScopeService should implement IScopeService', () => {
      // Arrange
      const scope: InstallationScope = 'user';

      // Act
      const service = ScopeServiceFactory.create(scope, mockContext, workspaceRoot, mockStorage);

      // Assert - verify interface methods exist
      assert.ok(typeof service.syncBundle === 'function', 'Should have syncBundle method');
      assert.ok(typeof service.unsyncBundle === 'function', 'Should have unsyncBundle method');
    });

    test('RepositoryScopeService should implement IScopeService', () => {
      // Arrange
      const scope: InstallationScope = 'repository';

      // Act
      const service = ScopeServiceFactory.create(scope, mockContext, workspaceRoot, mockStorage);

      // Assert - verify interface methods exist
      assert.ok(typeof service.syncBundle === 'function', 'Should have syncBundle method');
      assert.ok(typeof service.unsyncBundle === 'function', 'Should have unsyncBundle method');
    });
  });

  suite('Factory configuration', () => {
    test('should pass context to UserScopeService', () => {
      // Arrange
      const scope: InstallationScope = 'user';

      // Act
      const service = ScopeServiceFactory.create(scope, mockContext, workspaceRoot, mockStorage);

      // Assert - UserScopeService should be created with context
      assert.ok(service instanceof UserScopeService);
    });

    test('should pass workspaceRoot and storage to RepositoryScopeService', () => {
      // Arrange
      const scope: InstallationScope = 'repository';

      // Act
      const service = ScopeServiceFactory.create(scope, mockContext, workspaceRoot, mockStorage);

      // Assert - RepositoryScopeService should be created with workspaceRoot and storage
      assert.ok(service instanceof RepositoryScopeService);
    });

    test('should throw error when repository scope requested without workspaceRoot', () => {
      // Arrange
      const scope: InstallationScope = 'repository';

      // Act & Assert
      assert.throws(
        () => ScopeServiceFactory.create(scope, mockContext, undefined, mockStorage),
        /workspaceRoot is required for repository scope/,
        'Should throw error when workspaceRoot is missing for repository scope'
      );
    });

    test('should throw error when repository scope requested without storage', () => {
      // Arrange
      const scope: InstallationScope = 'repository';

      // Act & Assert
      assert.throws(
        () => ScopeServiceFactory.create(scope, mockContext, workspaceRoot, undefined),
        /storage is required for repository scope/,
        'Should throw error when storage is missing for repository scope'
      );
    });
  });

  suite('Scope type mapping', () => {
    test('should map all valid InstallationScope values', () => {
      // Arrange
      const validScopes: InstallationScope[] = ['user', 'workspace', 'repository'];

      // Act & Assert
      for (const scope of validScopes) {
        const service = ScopeServiceFactory.create(scope, mockContext, workspaceRoot, mockStorage);
        assert.ok(service, `Should create service for scope: ${scope}`);
      }
    });
  });
});
