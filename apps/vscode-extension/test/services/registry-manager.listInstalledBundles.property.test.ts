/**
 * RegistryManager.listInstalledBundles Property-Based Tests
 *
 * Property-based tests for the listInstalledBundles method.
 * These tests verify correctness properties for the lockfile-as-source-of-truth feature.
 *
 * Properties covered:
 * - Property 1: Repository Scope Queries Lockfile (Requirements 1.1)
 * - Property 2: Combined Scope Queries Both Sources (Requirements 1.2)
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  InstalledBundle,
} from '../../src/types/registry';
import {
  createMockLockfile,
} from '../helpers/lockfile-test-helpers';
import {
  cleanupTestWorkspace,
  createTestWorkspace,
} from '../helpers/mock-data';
import {
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('RegistryManager.listInstalledBundles Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let manager: RegistryManager;
  let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
  let tempDir: string;
  let getWorkspaceRootStub: sinon.SinonStub;

  /**
   * Create a mock VS Code ExtensionContext for testing.
   * Uses sinon sandbox for proper cleanup.
   * @param mockSandbox
   */
  const createMockContext = (mockSandbox: sinon.SinonSandbox): vscode.ExtensionContext => {
    return {
      globalState: {
        get: mockSandbox.stub(),
        update: mockSandbox.stub().resolves(),
        keys: mockSandbox.stub().returns([]),
        setKeysForSync: mockSandbox.stub()
      } as any,
      workspaceState: {
        get: mockSandbox.stub(),
        update: mockSandbox.stub().resolves(),
        keys: mockSandbox.stub().returns([]),
        setKeysForSync: mockSandbox.stub()
      } as any,
      subscriptions: [],
      extensionPath: '/mock/path',
      extensionUri: vscode.Uri.file('/mock/path'),
      storageUri: vscode.Uri.file('/mock/storage'),
      globalStorageUri: vscode.Uri.file('/mock/global'),
      asAbsolutePath: (p: string) => `/mock/path/${p}`
    } as any;
  };

  const createMockUserBundle = (id: string, version: string): InstalledBundle => ({
    bundleId: id,
    version,
    installedAt: new Date().toISOString(),
    scope: 'user',
    installPath: '/mock/user/path',
    sourceId: 'mock-source',
    sourceType: 'github',
    manifest: {
      common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
      bundle_settings: { include_common_in_environment_bundles: false, create_common_bundle: false, compression: 'none', naming: { environment_bundle: id } },
      metadata: { manifest_version: '1.0.0', description: `User bundle: ${id}` }
    }
  });

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = createTestWorkspace();
    mockContext = createMockContext(sandbox);

    // Reset RegistryManager singleton for clean test state
    (RegistryManager as any).instance = undefined;
    manager = RegistryManager.getInstance(mockContext);

    // Create and inject mock storage
    mockStorage = sandbox.createStubInstance(RegistryStorage);
    mockStorage.getSources.resolves([]);
    mockStorage.getProfiles.resolves([]);
    mockStorage.getInstalledBundles.resolves([]);
    (manager as any).storage = mockStorage;

    // Stub getWorkspaceRoot to return our temp directory
    const scopeSelectionUI = require('../../src/utils/scope-selection-ui');
    getWorkspaceRootStub = sandbox.stub(scopeSelectionUI, 'getWorkspaceRoot').returns(tempDir);

    // Reset LockfileManager instances
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    cleanupTestWorkspace(tempDir);
    LockfileManager.resetInstance();
    (RegistryManager as any).instance = undefined;
  });

  /**
   * Property 1: Repository Scope Queries Lockfile
   *
   * For any call to listInstalledBundles('repository'), the returned bundles
   * SHALL be derived from the lockfile, not from RegistryStorage.
   *
   * **Validates: Requirements 1.1**
   * **Feature: lockfile-source-of-truth, Property 1: Repository Scope Queries Lockfile**
   */
  suite('Property 1: Repository Scope Queries Lockfile', () => {
    test('repository scope should return bundles from lockfile only', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (bundleCount: number) => {
            // Arrange: Create lockfile with bundles
            const lockfile = createMockLockfile(bundleCount, {
              sourceType: 'github',
              commitMode: 'commit',
              includeFiles: true
            });

            // Write lockfile to temp directory
            const lockfilePath = path.join(tempDir, 'prompt-registry.lock.json');
            fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));

            // Create files for each bundle to avoid filesMissing flag
            for (const [, entry] of Object.entries(lockfile.bundles)) {
              for (const file of entry.files) {
                const filePath = path.join(tempDir, file.path);
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, 'mock content');
              }
            }

            // Mock RegistryStorage to return user bundles (should NOT be included)
            const userBundles = [createMockUserBundle('user-bundle-1', '1.0.0')];
            mockStorage.getInstalledBundles.resolves(userBundles);

            // Act: Query repository scope
            const result = await manager.listInstalledBundles('repository');

            // Assert: Should return only lockfile bundles
            assert.strictEqual(
              result.length,
              bundleCount,
              `Should return ${bundleCount} bundles from lockfile`
            );

            // All returned bundles should have scope 'repository'
            for (const bundle of result) {
              assert.strictEqual(
                bundle.scope,
                'repository',
                'All bundles should have repository scope'
              );
            }

            // Should NOT include user bundles
            const hasUserBundle = result.some((b) => b.bundleId === 'user-bundle-1');
            assert.strictEqual(
              hasUserBundle,
              false,
              'Should not include user bundles when querying repository scope'
            );

            // Cleanup
            fs.unlinkSync(lockfilePath);

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('repository scope should return empty array when lockfile does not exist', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(true), // Dummy property to run the test
          async () => {
            // Arrange: No lockfile exists (temp dir is empty)
            // Mock RegistryStorage to return user bundles
            const userBundles = [createMockUserBundle('user-bundle-1', '1.0.0')];
            mockStorage.getInstalledBundles.resolves(userBundles);

            // Act: Query repository scope
            const result = await manager.listInstalledBundles('repository');

            // Assert: Should return empty array
            assert.strictEqual(
              result.length,
              0,
              'Should return empty array when lockfile does not exist'
            );

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.QUICK
        }
      );
    });

    test('repository scope should not call RegistryStorage.getInstalledBundles with repository scope', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 3 }),
          async (bundleCount: number) => {
            // Arrange: Create lockfile
            const lockfile = createMockLockfile(bundleCount);
            const lockfilePath = path.join(tempDir, 'prompt-registry.lock.json');
            fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));

            // Reset call history
            mockStorage.getInstalledBundles.resetHistory();

            // Act: Query repository scope
            await manager.listInstalledBundles('repository');

            // Assert: RegistryStorage should NOT be called for repository scope
            assert.strictEqual(
              mockStorage.getInstalledBundles.called,
              false,
              'RegistryStorage.getInstalledBundles should not be called for repository scope'
            );

            // Cleanup
            fs.unlinkSync(lockfilePath);

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.QUICK
        }
      );
    });
  });

  /**
   * Property 2: Combined Scope Queries Both Sources
   *
   * For any call to listInstalledBundles() without a scope filter, the returned
   * bundles SHALL include bundles from both RegistryStorage (user/workspace)
   * and LockfileManager (repository).
   *
   * **Validates: Requirements 1.2**
   * **Feature: lockfile-source-of-truth, Property 2: Combined Scope Queries Both Sources**
   */
  suite('Property 2: Combined Scope Queries Both Sources', () => {
    test('no scope filter should return bundles from both sources', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          fc.integer({ min: 1, max: 3 }),
          async (lockfileBundleCount: number, userBundleCount: number) => {
            // Arrange: Create lockfile with repository bundles
            const lockfile = createMockLockfile(lockfileBundleCount, {
              sourceType: 'github',
              commitMode: 'commit'
            });

            const lockfilePath = path.join(tempDir, 'prompt-registry.lock.json');
            fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));

            // Create user bundles in RegistryStorage
            const userBundles: InstalledBundle[] = [];
            for (let i = 0; i < userBundleCount; i++) {
              userBundles.push(createMockUserBundle(`user-bundle-${i}`, `${i + 1}.0.0`));
            }
            mockStorage.getInstalledBundles.resolves(userBundles);

            // Act: Query without scope filter
            const result = await manager.listInstalledBundles();

            // Assert: Should return bundles from both sources
            const expectedTotal = lockfileBundleCount + userBundleCount;
            assert.strictEqual(
              result.length,
              expectedTotal,
              `Should return ${expectedTotal} bundles (${lockfileBundleCount} from lockfile + ${userBundleCount} from storage)`
            );

            // Verify we have both repository and user scope bundles
            const repoBundles = result.filter((b) => b.scope === 'repository');
            const userScopeBundles = result.filter((b) => b.scope === 'user');

            assert.strictEqual(
              repoBundles.length,
              lockfileBundleCount,
              `Should have ${lockfileBundleCount} repository bundles`
            );
            assert.strictEqual(
              userScopeBundles.length,
              userBundleCount,
              `Should have ${userBundleCount} user bundles`
            );

            // Cleanup
            fs.unlinkSync(lockfilePath);

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('no scope filter should call both RegistryStorage and LockfileManager', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 3 }),
          async (bundleCount: number) => {
            // Arrange: Create lockfile
            const lockfile = createMockLockfile(bundleCount);
            const lockfilePath = path.join(tempDir, 'prompt-registry.lock.json');
            fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));

            // Reset call history
            mockStorage.getInstalledBundles.resetHistory();

            // Act: Query without scope filter
            await manager.listInstalledBundles();

            // Assert: RegistryStorage should be called (for user/workspace bundles)
            assert.strictEqual(
              mockStorage.getInstalledBundles.called,
              true,
              'RegistryStorage.getInstalledBundles should be called for combined query'
            );

            // Cleanup
            fs.unlinkSync(lockfilePath);

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.QUICK
        }
      );
    });

    test('user scope should only query RegistryStorage, not lockfile', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          async (lockfileBundleCount: number) => {
            // Arrange: Create lockfile with bundles
            const lockfile = createMockLockfile(lockfileBundleCount);
            const lockfilePath = path.join(tempDir, 'prompt-registry.lock.json');
            fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));

            // Create user bundles
            const userBundles = [createMockUserBundle('user-bundle-1', '1.0.0')];
            mockStorage.getInstalledBundles.resolves(userBundles);

            // Act: Query user scope
            const result = await manager.listInstalledBundles('user');

            // Assert: Should return only user bundles, not lockfile bundles
            assert.strictEqual(
              result.length,
              1,
              'Should return only user bundles'
            );
            assert.strictEqual(
              result[0].scope,
              'user',
              'Returned bundle should have user scope'
            );

            // Should NOT include repository bundles
            const hasRepoBundles = result.some((b) => b.scope === 'repository');
            assert.strictEqual(
              hasRepoBundles,
              false,
              'Should not include repository bundles when querying user scope'
            );

            // Cleanup
            fs.unlinkSync(lockfilePath);

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.QUICK
        }
      );
    });

    test('workspace scope should only query RegistryStorage, not lockfile', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          async (lockfileBundleCount: number) => {
            // Arrange: Create lockfile with bundles
            const lockfile = createMockLockfile(lockfileBundleCount);
            const lockfilePath = path.join(tempDir, 'prompt-registry.lock.json');
            fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));

            // Create workspace bundles
            const workspaceBundles: InstalledBundle[] = [{
              bundleId: 'workspace-bundle-1',
              version: '1.0.0',
              installedAt: new Date().toISOString(),
              scope: 'workspace',
              installPath: '/mock/workspace/path',
              sourceId: 'mock-source',
              sourceType: 'github',
              manifest: {
                common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
                bundle_settings: { include_common_in_environment_bundles: false, create_common_bundle: false, compression: 'none', naming: { environment_bundle: 'workspace-bundle-1' } },
                metadata: { manifest_version: '1.0.0', description: 'Workspace bundle' }
              }
            }];
            mockStorage.getInstalledBundles.resolves(workspaceBundles);

            // Act: Query workspace scope
            const result = await manager.listInstalledBundles('workspace');

            // Assert: Should return only workspace bundles, not lockfile bundles
            assert.strictEqual(
              result.length,
              1,
              'Should return only workspace bundles'
            );
            assert.strictEqual(
              result[0].scope,
              'workspace',
              'Returned bundle should have workspace scope'
            );

            // Should NOT include repository bundles
            const hasRepoBundles = result.some((b) => b.scope === 'repository');
            assert.strictEqual(
              hasRepoBundles,
              false,
              'Should not include repository bundles when querying workspace scope'
            );

            // Cleanup
            fs.unlinkSync(lockfilePath);

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.QUICK
        }
      );
    });

    test('combined query should handle empty lockfile gracefully', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          async (userBundleCount: number) => {
            // Arrange: No lockfile exists
            // Create user bundles
            const userBundles: InstalledBundle[] = [];
            for (let i = 0; i < userBundleCount; i++) {
              userBundles.push(createMockUserBundle(`user-bundle-${i}`, `${i + 1}.0.0`));
            }
            mockStorage.getInstalledBundles.resolves(userBundles);

            // Act: Query without scope filter
            const result = await manager.listInstalledBundles();

            // Assert: Should return only user bundles
            assert.strictEqual(
              result.length,
              userBundleCount,
              `Should return ${userBundleCount} user bundles when lockfile doesn't exist`
            );

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.QUICK
        }
      );
    });

    test('combined query should handle no workspace gracefully', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }),
          async (userBundleCount: number) => {
            // Arrange: No workspace open
            getWorkspaceRootStub.returns(undefined);

            // Create user bundles
            const userBundles: InstalledBundle[] = [];
            for (let i = 0; i < userBundleCount; i++) {
              userBundles.push(createMockUserBundle(`user-bundle-${i}`, `${i + 1}.0.0`));
            }
            mockStorage.getInstalledBundles.resolves(userBundles);

            // Act: Query without scope filter
            const result = await manager.listInstalledBundles();

            // Assert: Should return only user bundles (no repository bundles without workspace)
            assert.strictEqual(
              result.length,
              userBundleCount,
              `Should return ${userBundleCount} user bundles when no workspace is open`
            );

            // Restore workspace root for other tests
            getWorkspaceRootStub.returns(tempDir);

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.QUICK
        }
      );
    });
  });
});
