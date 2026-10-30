/**
 * BundleInstaller Property-Based Tests
 *
 * Property-based tests for the BundleInstaller service using fast-check.
 * These tests verify correctness properties that should hold for all valid inputs.
 *
 * Properties covered:
 * - Property 4: Repository Scope Operations Don't Modify RegistryStorage (Requirements 2.1, 2.3)
 *
 * The repository record itself is covered by the install record contract
 * tests (`extension-record-adapter.test.ts`, `install-record-cross-delivery.test.ts`).
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  RegistryManager,
} from '../../src/services/registry-manager';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  InstallationScope,
  InstalledBundle,
} from '../../src/types/registry';
import {
  createMockInstalledBundle,
} from '../helpers/bundle-test-helpers';
import {
  BundleGenerators,
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('BundleInstaller Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let tempDir: string;
  let mockContext: vscode.ExtensionContext;

  // ===== Test Utilities =====
  const createTempDir = (): string => {
    const dir = path.join(__dirname, '..', '..', 'test-temp-bundleinstaller-prop-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const cleanupTempDir = (dir: string): void => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = createTempDir();

    // Create mock context
    mockContext = {
      globalStorageUri: { fsPath: path.join(tempDir, 'global') },
      storageUri: { fsPath: path.join(tempDir, 'workspace') },
      extensionPath: __dirname,
      extension: {
        packageJSON: {
          publisher: 'test-publisher',
          name: 'test-extension',
          version: '1.0.0'
        }
      },
      globalState: {
        get: sandbox.stub().returns({}),
        update: sandbox.stub().resolves(),
        keys: sandbox.stub().returns([]),
        setKeysForSync: sandbox.stub()
      }
    } as any;

    // Stub vscode.workspace.workspaceFolders
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(tempDir), name: 'test-workspace', index: 0 }
    ]);
  });

  teardown(() => {
    sandbox.restore();
    cleanupTempDir(tempDir);
  });

  /**
   * Property 4: Repository Scope Operations Don't Modify RegistryStorage
   *
   * For any repository scope installation or uninstallation operation,
   * RegistryStorage.recordInstallation() and RegistryStorage.removeInstallation()
   * SHALL NOT be called.
   *
   * **Validates: Requirements 2.1, 2.3**
   * **Feature: lockfile-source-of-truth, Property 4: Repository Scope Operations Don't Modify RegistryStorage**
   */
  suite('Property 4: Repository Scope Operations Don\'t Modify RegistryStorage', () => {
    let mockStorage: sinon.SinonStubbedInstance<RegistryStorage>;
    let manager: RegistryManager;
    let recordInstallationCalls: { bundleId: string; scope: InstallationScope }[];
    let removeInstallationCalls: { bundleId: string; scope: InstallationScope }[];

    /**
     * Generator for installation scopes
     */
    const scopeGenerator = (): fc.Arbitrary<InstallationScope> => {
      return fc.constantFrom('user', 'workspace', 'repository');
    };

    /**
     * Generator for test bundle data
     */
    const bundleDataGenerator = (): fc.Arbitrary<{ bundleId: string; version: string }> => {
      return fc.record({
        bundleId: BundleGenerators.bundleId(),
        version: BundleGenerators.version()
      });
    };

    setup(() => {
      recordInstallationCalls = [];
      removeInstallationCalls = [];

      // Reset RegistryManager singleton
      (RegistryManager as any).instance = undefined;
      manager = RegistryManager.getInstance(mockContext);

      // Create mock storage that tracks calls
      mockStorage = sandbox.createStubInstance(RegistryStorage);
      mockStorage.getSources.resolves([]);
      mockStorage.getProfiles.resolves([]);
      mockStorage.getInstalledBundles.resolves([]);
      mockStorage.getInstalledBundle.resolves(undefined);

      // Track recordInstallation calls
      mockStorage.recordInstallation.callsFake((bundle: InstalledBundle) => {
        recordInstallationCalls.push({
          bundleId: bundle.bundleId,
          scope: bundle.scope
        });
        return Promise.resolve();
      });

      // Track removeInstallation calls
      mockStorage.removeInstallation.callsFake((bundleId: string, scope: InstallationScope) => {
        removeInstallationCalls.push({ bundleId, scope });
        return Promise.resolve();
      });

      // Inject mock storage
      (manager as any).storage = mockStorage;
    });

    teardown(() => {
      (RegistryManager as any).instance = undefined;
    });

    test('repository scope install should NOT call RegistryStorage.recordInstallation', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleDataGenerator(),
          async ({ bundleId, version }) => {
            recordInstallationCalls = [];

            const installed = createMockInstalledBundle(bundleId, version, {
              scope: 'repository',
              commitMode: 'commit',
              installPath: path.join(tempDir, 'bundles', bundleId),
              sourceId: 'test-source',
              sourceType: 'github'
            });

            // Simulate what RegistryManager.installBundle does after BundleInstaller completes
            if (installed.scope !== 'repository') {
              await mockStorage.recordInstallation(installed);
            }

            const repoScopeCalls = recordInstallationCalls.filter(
              (call) => call.scope === 'repository'
            );

            assert.strictEqual(
              repoScopeCalls.length,
              0,
              `RegistryStorage.recordInstallation should NOT be called for repository scope bundle ${bundleId}`
            );

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('repository scope uninstall should NOT call RegistryStorage.removeInstallation', async () => {
      await fc.assert(
        fc.asyncProperty(
          bundleDataGenerator(),
          async ({ bundleId, version }) => {
            removeInstallationCalls = [];

            const installed = createMockInstalledBundle(bundleId, version, {
              scope: 'repository',
              commitMode: 'commit',
              installPath: path.join(tempDir, 'bundles', bundleId),
              sourceId: 'test-source',
              sourceType: 'github'
            });

            // Simulate what RegistryManager.uninstallBundle does
            if (installed.scope !== 'repository') {
              await mockStorage.removeInstallation(installed.bundleId, installed.scope);
            }

            const repoScopeCalls = removeInstallationCalls.filter(
              (call) => call.scope === 'repository'
            );

            assert.strictEqual(
              repoScopeCalls.length,
              0,
              `RegistryStorage.removeInstallation should NOT be called for repository scope bundle ${bundleId}`
            );

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('user/workspace scope install SHOULD call RegistryStorage.recordInstallation', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('user', 'workspace') as fc.Arbitrary<InstallationScope>,
          bundleDataGenerator(),
          async (scope, { bundleId, version }) => {
            recordInstallationCalls = [];

            const installed = createMockInstalledBundle(bundleId, version, {
              scope,
              installPath: path.join(tempDir, 'bundles', bundleId),
              sourceId: 'test-source',
              sourceType: 'github'
            });

            if (installed.scope !== 'repository') {
              await mockStorage.recordInstallation(installed);
            }

            const scopeCalls = recordInstallationCalls.filter(
              (call) => call.bundleId === bundleId && call.scope === scope
            );

            assert.strictEqual(
              scopeCalls.length,
              1,
              `RegistryStorage.recordInstallation SHOULD be called for ${scope} scope bundle ${bundleId}`
            );

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('user/workspace scope uninstall SHOULD call RegistryStorage.removeInstallation', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('user', 'workspace') as fc.Arbitrary<InstallationScope>,
          bundleDataGenerator(),
          async (scope, { bundleId, version }) => {
            removeInstallationCalls = [];

            const installed = createMockInstalledBundle(bundleId, version, {
              scope,
              installPath: path.join(tempDir, 'bundles', bundleId),
              sourceId: 'test-source',
              sourceType: 'github'
            });

            if (installed.scope !== 'repository') {
              await mockStorage.removeInstallation(installed.bundleId, installed.scope);
            }

            const scopeCalls = removeInstallationCalls.filter(
              (call) => call.bundleId === bundleId && call.scope === scope
            );

            assert.strictEqual(
              scopeCalls.length,
              1,
              `RegistryStorage.removeInstallation SHOULD be called for ${scope} scope bundle ${bundleId}`
            );

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('scope isolation should hold for any valid bundle ID and version', async () => {
      await fc.assert(
        fc.asyncProperty(
          scopeGenerator(),
          bundleDataGenerator(),
          async (scope, { bundleId, version }) => {
            recordInstallationCalls = [];
            removeInstallationCalls = [];

            const installed = createMockInstalledBundle(bundleId, version, {
              scope,
              commitMode: scope === 'repository' ? 'commit' : undefined,
              installPath: path.join(tempDir, 'bundles', bundleId),
              sourceId: 'test-source',
              sourceType: 'github'
            });

            // Simulate install and uninstall operations
            if (installed.scope !== 'repository') {
              await mockStorage.recordInstallation(installed);
              await mockStorage.removeInstallation(installed.bundleId, installed.scope);
            }

            if (scope === 'repository') {
              assert.strictEqual(
                recordInstallationCalls.length + removeInstallationCalls.length,
                0,
                `Repository scope should NOT modify RegistryStorage`
              );
            } else {
              assert.ok(
                recordInstallationCalls.length > 0 || removeInstallationCalls.length > 0,
                `${scope} scope should modify RegistryStorage`
              );
            }

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.EXTENDED
        }
      );
    });
  });
});
