/**
 * E2E Tests: Lockfile as Single Source of Truth
 *
 * Tests the lockfile-based repository bundle management:
 * - Repository bundle listing from lockfile
 * - Stale record handling (lockfile takes precedence over RegistryStorage)
 * - Cleanup command for stale lockfile entries
 *
 * Requirements covered:
 * - 1.1: Repository scope queries lockfile
 * - 1.3: LockfileBundleEntry to InstalledBundle conversion
 * - 2.1: Repository scope operations don't modify RegistryStorage
 * - 3.4: Cleanup command for stale lockfile entries
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  BundleCommands,
} from '../../src/commands/bundle-commands';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  RepositoryCommitMode,
} from '../../src/types/registry';
import {
  generateHubSourceId,
  isLegacyHubSourceId,
} from '../../src/utils/source-id-utils';
import {
  createE2ETestContext,
  E2ETestContext,
  generateTestId,
} from '../helpers/e2e-test-helpers';
import {
  cleanupReleaseMocks,
  computeBundleId,
  createMockGitHubSource,
  MochaTestContext,
  ReleaseConfig,
  RepositoryTestConfig,
  setupReleaseMocks,
  setupSourceWithCustomConfig,
} from '../helpers/repository-fixture-helpers';

suite('E2E: Lockfile as Single Source of Truth Tests', () => {
  let testContext: E2ETestContext;
  let testId: string;
  let sandbox: sinon.SinonSandbox;
  let workspaceRoot: string;

  // Test configuration using shared fixtures
  const TEST_CONFIG: RepositoryTestConfig = {
    owner: 'test-owner',
    repo: 'test-repo',
    manifestId: 'test-bundle',
    baseVersion: '1.0.0'
  };

  const LOCKFILE_NAME = 'prompt-registry.lock.json';
  const GITHUB_PROMPTS_DIR = '.github/prompts';

  // Compute bundle ID using shared helper
  const BUNDLE_ID = computeBundleId(TEST_CONFIG, TEST_CONFIG.baseVersion || '1.0.0');

  /**
   * Helper to handle "not yet implemented" errors gracefully.
   * Uses MochaTestContext for proper typing of the test context.
   * @param context
   * @param bundleId
   * @param options
   * @param options.scope
   * @param options.commitMode
   * @param options.version
   */
  const installBundleOrSkip = async (
    context: MochaTestContext,
    bundleId: string,
    options: { scope: 'repository' | 'user'; commitMode?: RepositoryCommitMode; version: string }
  ): Promise<void> => {
    try {
      await testContext.registryManager.installBundle(bundleId, {
        scope: options.scope,
        commitMode: options.commitMode || 'commit',
        version: options.version
      });
    } catch (error: any) {
      if (error.message.includes('not yet implemented')) {
        context.skip();
      }
      throw error;
    }
  };

  /**
   * Helper to clear adapter authentication for isolated testing.
   */
  const clearAdapterAuth = (): void => {
    const adapters = (testContext.registryManager as any).adapters;
    if (adapters) {
      adapters.forEach((adapter: any) => {
        if (adapter.authToken !== undefined) {
          adapter.authToken = undefined;
          adapter.authMethod = 'none';
        }
      });
    }
  };

  /**
   * Helper to set up a source and get a bundle for testing.
   * Uses shared repository fixture helpers.
   * @param testIdSuffix
   * @param content
   */
  const setupSourceAndGetBundle = async (
    testIdSuffix: string,
    content: string
  ): Promise<{ sourceId: string; bundle: any }> => {
    const sourceId = `${testId}-${testIdSuffix}`;
    const source = createMockGitHubSource(sourceId, TEST_CONFIG);
    const releases: ReleaseConfig[] = [{ tag: 'v1.0.0', version: '1.0.0', content }];
    setupReleaseMocks(TEST_CONFIG, releases);

    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
    ]);

    await testContext.registryManager.addSource(source);
    await testContext.registryManager.syncSource(sourceId);

    const rawBundles = await testContext.storage.getCachedSourceBundles(sourceId);
    const bundle = rawBundles.find((b) => b.id === BUNDLE_ID);

    if (!bundle) {
      throw new Error(`Should find bundle ${BUNDLE_ID}, found: ${rawBundles.map((b) => b.id).join(', ')}`);
    }

    return { sourceId, bundle };
  };

  setup(async function () {
    this.timeout(30_000);
    testId = generateTestId('lockfile-sot');
    sandbox = sinon.createSandbox();

    if (vscode.authentication && typeof vscode.authentication.getSession === 'function') {
      sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
    }

    const childProcess = require('node:child_process');
    sandbox.stub(childProcess, 'exec').callsFake((...args: unknown[]) => {
      const cmd = args[0] as string;
      const callback = args.at(-1) as (...callbackArgs: unknown[]) => void;
      if (cmd === 'gh auth token') {
        callback(new Error('gh not available'), '', '');
      } else {
        callback(null, '', '');
      }
    });

    testContext = await createE2ETestContext();
    workspaceRoot = path.join(testContext.tempStoragePath, 'test-workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, '.git', 'info'), { recursive: true });

    clearAdapterAuth();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  teardown(async function () {
    this.timeout(10_000);
    LockfileManager.resetInstance();
    await testContext.cleanup();
    sandbox.restore();
    cleanupReleaseMocks();
  });

  suite('11.1: Repository Bundle Listing from Lockfile', () => {
    /**
     * E2E Test: Install bundle at repository scope and verify listInstalledBundles returns it
     *
     * Requirements covered:
     * - 1.1: Repository scope queries lockfile
     * - 1.3: LockfileBundleEntry to InstalledBundle conversion
     */
    test('Requirement 1.1, 1.3: listInstalledBundles(repository) returns bundles from lockfile', async function () {
      this.timeout(60_000);

      const { bundle } = await setupSourceAndGetBundle('listing-source', 'listing-test');

      // Install bundle at repository scope
      await installBundleOrSkip(this, bundle.id, {
        scope: 'repository', commitMode: 'commit', version: '1.0.0'
      });

      // Verify lockfile was created
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      assert.ok(fs.existsSync(lockfilePath), 'Lockfile should exist after installation');

      // Read lockfile directly to get the actual bundle ID
      const lockfileContent = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      const lockfileBundleIds = Object.keys(lockfileContent.bundles);
      assert.ok(lockfileBundleIds.length > 0, 'Lockfile should have at least one bundle');

      const actualBundleId = lockfileBundleIds[0];
      const lockfileEntry = lockfileContent.bundles[actualBundleId];

      // Query repository bundles via listInstalledBundles
      const installedBundles = await testContext.registryManager.listInstalledBundles('repository');

      // Verify bundle is returned
      assert.ok(installedBundles.length > 0, 'listInstalledBundles should return at least one bundle');

      const installedBundle = installedBundles.find((b) => b.bundleId === actualBundleId);
      assert.ok(installedBundle, `Should find bundle ${actualBundleId} in installed bundles`);

      // Verify bundle data matches lockfile entry (Requirement 1.3)
      assert.strictEqual(installedBundle.version, lockfileEntry.version, 'Version should match lockfile entry');
      assert.strictEqual(installedBundle.sourceId, lockfileEntry.sourceId, 'SourceId should match lockfile entry');
      assert.strictEqual(installedBundle.sourceType, lockfileEntry.sourceType, 'SourceType should match lockfile entry');
      assert.strictEqual(installedBundle.scope, 'repository', 'Scope should be repository');
      assert.ok(installedBundle.installPath, 'InstallPath should be set');
      assert.ok(installedBundle.installPath.includes('.github'), 'InstallPath should include .github');
    });

    test('Requirement 1.1: listInstalledBundles without scope includes repository bundles', async function () {
      this.timeout(60_000);

      const { bundle } = await setupSourceAndGetBundle('combined-source', 'combined-test');

      // Install bundle at repository scope
      await installBundleOrSkip(this, bundle.id, {
        scope: 'repository', commitMode: 'commit', version: '1.0.0'
      });

      // Get the actual bundle ID from lockfile
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const lockfileContent = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      const actualBundleId = Object.keys(lockfileContent.bundles)[0];

      // Query all bundles (no scope filter)
      const allBundles = await testContext.registryManager.listInstalledBundles();

      // Verify repository bundle is included
      const repoBundle = allBundles.find((b) => b.bundleId === actualBundleId);
      assert.ok(repoBundle, 'Repository bundle should be included when querying without scope filter');
      assert.strictEqual(repoBundle.scope, 'repository', 'Bundle scope should be repository');
    });

    test('Requirement 1.4: listInstalledBundles returns empty array when lockfile does not exist', async function () {
      this.timeout(30_000);

      // Ensure no lockfile exists
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      if (fs.existsSync(lockfilePath)) {
        fs.unlinkSync(lockfilePath);
      }

      // Stub workspace folders to point to our test workspace
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Query repository bundles
      const installedBundles = await testContext.registryManager.listInstalledBundles('repository');

      // Should return empty array
      assert.strictEqual(installedBundles.length, 0, 'Should return empty array when lockfile does not exist');
    });
  });

  suite('11.2: Stale Record Handling', () => {
    /**
     * E2E Test: Verify lockfile takes precedence over stale RegistryStorage records
     *
     * Requirements covered:
     * - 1.1: Repository scope queries lockfile
     * - 2.1: Repository scope operations don't modify RegistryStorage
     */
    test('Requirement 1.1, 2.1: Lockfile takes precedence over stale RegistryStorage records', async function () {
      this.timeout(60_000);

      // Stub workspace folders
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Create a stale RegistryStorage record for repository scope
      // This simulates a scenario where RegistryStorage has old data
      const staleBundleId = 'stale-bundle-v1.0.0';

      // Note: RegistryStorage.getInstalledBundles('repository') returns empty array by design
      // This test verifies that listInstalledBundles queries the lockfile, not RegistryStorage

      // Create a lockfile with a different bundle
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const lockfileBundleId = 'lockfile-bundle-v2.0.0';
      const mockLockfile = {
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        generatedBy: 'prompt-registry@1.0.0',
        bundles: {
          [lockfileBundleId]: {
            version: '2.0.0',
            sourceId: 'lockfile-source',
            sourceType: 'github',
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/test.prompt.md', checksum: 'abc123' }]
          }
        },
        sources: {
          'lockfile-source': { type: 'github', url: 'https://github.com/test/repo' }
        }
      };

      // Create the files so they're not marked as missing
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'test.prompt.md'), '# Test Prompt');

      fs.writeFileSync(lockfilePath, JSON.stringify(mockLockfile, null, 2));

      // Reset LockfileManager to pick up the new lockfile
      LockfileManager.resetInstance();

      // Query repository bundles
      const installedBundles = await testContext.registryManager.listInstalledBundles('repository');

      // Verify lockfile bundle is returned (not the stale record)
      assert.strictEqual(installedBundles.length, 1, 'Should return exactly one bundle from lockfile');
      assert.strictEqual(installedBundles[0].bundleId, lockfileBundleId, 'Should return bundle from lockfile');
      assert.strictEqual(installedBundles[0].version, '2.0.0', 'Version should match lockfile');

      // Verify stale record is NOT returned
      const staleBundle = installedBundles.find((b) => b.bundleId === staleBundleId);
      assert.ok(!staleBundle, 'Stale RegistryStorage record should NOT be returned');
    });

    test('Requirement 2.1: Repository scope installation does not create RegistryStorage record', async function () {
      this.timeout(60_000);

      const { bundle } = await setupSourceAndGetBundle('no-storage-source', 'no-storage-test');

      // Get RegistryStorage records before installation
      const storageBundlesBefore = await testContext.storage.getInstalledBundles('user');
      const storageCountBefore = storageBundlesBefore.length;

      // Install bundle at repository scope
      await installBundleOrSkip(this, bundle.id, {
        scope: 'repository', commitMode: 'commit', version: '1.0.0'
      });

      // Verify lockfile was created
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      assert.ok(fs.existsSync(lockfilePath), 'Lockfile should exist after installation');

      // Verify RegistryStorage was NOT modified
      const storageBundlesAfter = await testContext.storage.getInstalledBundles('user');
      assert.strictEqual(
        storageBundlesAfter.length,
        storageCountBefore,
        'RegistryStorage should NOT have new records for repository scope installation'
      );

      // Also check workspace scope
      const workspaceBundles = await testContext.storage.getInstalledBundles('workspace');
      const repoScopeInWorkspace = workspaceBundles.find((b) => b.scope === 'repository');
      assert.ok(!repoScopeInWorkspace, 'Repository scope bundle should NOT be in workspace storage');
    });
  });

  suite('11.3: Cleanup Command for Stale Lockfile Entries', () => {
    /**
     * E2E Test: Verify cleanup command removes stale lockfile entries
     *
     * Requirements covered:
     * - 3.4: Provide command to clean up stale lockfile entries
     */
    test('Requirement 3.4: Cleanup command removes stale entries with missing files', async function () {
      this.timeout(60_000);

      // Stub workspace folders
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Create a lockfile with a bundle that has missing files
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const staleBundleId = 'stale-bundle-missing-files';
      const validBundleId = 'valid-bundle-with-files';

      const mockLockfile = {
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        generatedBy: 'prompt-registry@1.0.0',
        bundles: {
          [staleBundleId]: {
            version: '1.0.0',
            sourceId: 'test-source',
            sourceType: 'github',
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/missing.prompt.md', checksum: 'abc123' }]
          },
          [validBundleId]: {
            version: '1.0.0',
            sourceId: 'test-source',
            sourceType: 'github',
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/existing.prompt.md', checksum: 'def456' }]
          }
        },
        sources: {
          'test-source': { type: 'github', url: 'https://github.com/test/repo' }
        }
      };

      // Create only the valid bundle's files (not the stale one)
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'existing.prompt.md'), '# Existing Prompt');
      // Note: missing.prompt.md is NOT created, making staleBundleId stale

      fs.writeFileSync(lockfilePath, JSON.stringify(mockLockfile, null, 2));

      // Reset LockfileManager to pick up the new lockfile
      LockfileManager.resetInstance();

      // Verify initial state - should have 2 bundles, one with missing files
      const lockfileManager = LockfileManager.getInstance(workspaceRoot);
      const bundlesBefore = await lockfileManager.getInstalledBundles();
      assert.strictEqual(bundlesBefore.length, 2, 'Should have 2 bundles initially');

      const staleBundle = bundlesBefore.find((b) => b.bundleId === staleBundleId);
      assert.ok(staleBundle, 'Should find stale bundle');
      assert.ok(staleBundle.filesMissing, 'Stale bundle should have filesMissing flag set');

      const validBundle = bundlesBefore.find((b) => b.bundleId === validBundleId);
      assert.ok(validBundle, 'Should find valid bundle');
      assert.ok(!validBundle.filesMissing, 'Valid bundle should NOT have filesMissing flag set');

      // Stub the confirmation dialog to auto-confirm
      const showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');
      showWarningMessageStub.resolves('Remove' as any);

      // Stub the info message
      const showInfoMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
      showInfoMessageStub.resolves(undefined);

      // Execute cleanup command
      const bundleCommands = new BundleCommands(testContext.registryManager);
      await bundleCommands.cleanupStaleLockfileEntries();

      // Verify confirmation dialog was shown
      assert.ok(showWarningMessageStub.called, 'Should show confirmation dialog');

      // Verify stale entry was removed from lockfile
      LockfileManager.resetInstance();
      const lockfileManagerAfter = LockfileManager.getInstance(workspaceRoot);
      const bundlesAfter = await lockfileManagerAfter.getInstalledBundles();

      assert.strictEqual(bundlesAfter.length, 1, 'Should have 1 bundle after cleanup');
      assert.strictEqual(bundlesAfter[0].bundleId, validBundleId, 'Valid bundle should remain');

      const staleBundleAfter = bundlesAfter.find((b) => b.bundleId === staleBundleId);
      assert.ok(!staleBundleAfter, 'Stale bundle should be removed');
    });

    test('Requirement 3.4: Cleanup command shows info message when no stale entries', async function () {
      this.timeout(30_000);

      // Stub workspace folders
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Create a lockfile with only valid bundles (files exist)
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const validBundleId = 'valid-bundle';

      const mockLockfile = {
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        generatedBy: 'prompt-registry@1.0.0',
        bundles: {
          [validBundleId]: {
            version: '1.0.0',
            sourceId: 'test-source',
            sourceType: 'github',
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/valid.prompt.md', checksum: 'abc123' }]
          }
        },
        sources: {
          'test-source': { type: 'github', url: 'https://github.com/test/repo' }
        }
      };

      // Create the bundle's files
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'valid.prompt.md'), '# Valid Prompt');

      fs.writeFileSync(lockfilePath, JSON.stringify(mockLockfile, null, 2));

      // Reset LockfileManager
      LockfileManager.resetInstance();

      // Stub the info message
      const showInfoMessageStub = sandbox.stub(vscode.window, 'showInformationMessage');
      showInfoMessageStub.resolves(undefined);

      // Execute cleanup command
      const bundleCommands = new BundleCommands(testContext.registryManager);
      await bundleCommands.cleanupStaleLockfileEntries();

      // Verify info message was shown (no stale entries)
      assert.ok(showInfoMessageStub.called, 'Should show info message');
      const infoMessage = showInfoMessageStub.firstCall.args[0];
      assert.ok(
        infoMessage.includes('No stale') || infoMessage.includes('no stale'),
        `Info message should indicate no stale entries, got: ${infoMessage}`
      );
    });

    test('Requirement 3.4: Cleanup command respects user cancellation', async function () {
      this.timeout(30_000);

      // Stub workspace folders
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Create a lockfile with a stale bundle
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const staleBundleId = 'stale-bundle';

      const mockLockfile = {
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        generatedBy: 'prompt-registry@1.0.0',
        bundles: {
          [staleBundleId]: {
            version: '1.0.0',
            sourceId: 'test-source',
            sourceType: 'github',
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/missing.prompt.md', checksum: 'abc123' }]
          }
        },
        sources: {
          'test-source': { type: 'github', url: 'https://github.com/test/repo' }
        }
      };

      // Don't create the files (making the bundle stale)
      fs.writeFileSync(lockfilePath, JSON.stringify(mockLockfile, null, 2));

      // Reset LockfileManager
      LockfileManager.resetInstance();

      // Stub the confirmation dialog to cancel
      const showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage');
      showWarningMessageStub.resolves('Cancel' as any);

      // Execute cleanup command
      const bundleCommands = new BundleCommands(testContext.registryManager);
      await bundleCommands.cleanupStaleLockfileEntries();

      // Verify stale entry was NOT removed (user cancelled)
      LockfileManager.resetInstance();
      const lockfileManagerAfter = LockfileManager.getInstance(workspaceRoot);
      const bundlesAfter = await lockfileManagerAfter.getInstalledBundles();

      assert.strictEqual(bundlesAfter.length, 1, 'Bundle should still exist after cancellation');
      assert.strictEqual(bundlesAfter[0].bundleId, staleBundleId, 'Stale bundle should remain');
    });
  });

  suite('11.4: Uninstall Scenarios', () => {
    /**
     * E2E Test: Uninstalling the last bundle deletes the lockfile and fires event
     *
     * Requirements covered:
     * - 3.1: Last bundle uninstall deletes lockfile
     * - 3.2: onLockfileUpdated event fires with null
     * - 3.4: Complete uninstall workflow verification
     */
    test('Requirement 3.1, 3.2, 3.4: Uninstalling last bundle deletes lockfile and fires event with null', async function () {
      this.timeout(60_000);

      const { bundle } = await setupSourceAndGetBundle('uninstall-last-source', 'uninstall-last-test');

      // Install single bundle at repository scope
      await installBundleOrSkip(this, bundle.id, {
        scope: 'repository', commitMode: 'commit', version: '1.0.0'
      });

      // Verify lockfile exists after installation
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      assert.ok(fs.existsSync(lockfilePath), 'Lockfile should exist after installation');

      // Verify this is the only bundle in the lockfile
      const lockfileBefore = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      const bundleCount = Object.keys(lockfileBefore.bundles).length;
      assert.strictEqual(bundleCount, 1, 'Should have exactly one bundle in lockfile');

      // Get the actual bundle ID from the lockfile
      const actualBundleId = Object.keys(lockfileBefore.bundles)[0];

      // Set up event listener to capture onLockfileUpdated event
      const lockfileManager = LockfileManager.getInstance(workspaceRoot);
      let eventFired = false;
      let eventPayload: any = 'not-fired';

      const disposable = lockfileManager.onLockfileUpdated((lockfile) => {
        eventFired = true;
        eventPayload = lockfile;
      });

      try {
        // Uninstall the bundle
        await testContext.registryManager.uninstallBundle(actualBundleId, 'repository');

        // Verify lockfile is deleted
        assert.ok(!fs.existsSync(lockfilePath), 'Lockfile should be deleted when last bundle is uninstalled');

        // Verify onLockfileUpdated event fired with null
        assert.ok(eventFired, 'onLockfileUpdated event should fire');
        assert.strictEqual(eventPayload, null, 'onLockfileUpdated event should fire with null when lockfile is deleted');
      } finally {
        disposable.dispose();
      }
    });

    /**
     * E2E Test: Uninstalling one bundle preserves others in lockfile
     *
     * Requirements covered:
     * - 3.3: Partial uninstall preserves other bundles
     */
    test('Requirement 3.3: Uninstalling one bundle preserves other bundles in lockfile', async function () {
      this.timeout(60_000);

      // Stub workspace folders once for both bundles
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Dependencies for the shared helper
      const deps = { registryManager: testContext.registryManager, storage: testContext.storage };

      // Set up and install first bundle
      const config1: RepositoryTestConfig = {
        owner: 'test-owner-1',
        repo: 'test-repo-1',
        manifestId: 'bundle-1',
        baseVersion: '1.0.0'
      };
      const { bundle: bundle1 } = await setupSourceWithCustomConfig(
        deps, testId, 'partial-source-1', config1, 'bundle1'
      );
      await installBundleOrSkip(this, bundle1.id, { scope: 'repository', commitMode: 'commit', version: '1.0.0' });

      // Set up and install second bundle
      const config2: RepositoryTestConfig = {
        owner: 'test-owner-2',
        repo: 'test-repo-2',
        manifestId: 'bundle-2',
        baseVersion: '1.0.0'
      };
      const { sourceId: sourceId2, bundle: bundle2 } = await setupSourceWithCustomConfig(
        deps, testId, 'partial-source-2', config2, 'bundle2'
      );
      await installBundleOrSkip(this, bundle2.id, { scope: 'repository', commitMode: 'commit', version: '1.0.0' });

      // Verify lockfile has two bundles
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      assert.ok(fs.existsSync(lockfilePath), 'Lockfile should exist');

      const lockfileBefore = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      const bundleIdsBefore = Object.keys(lockfileBefore.bundles);
      assert.strictEqual(bundleIdsBefore.length, 2, 'Should have two bundles in lockfile');

      // Find the actual bundle IDs from lockfile
      const actualBundleId1 = bundleIdsBefore.find((id) => id.includes('bundle-1'));
      const actualBundleId2 = bundleIdsBefore.find((id) => id.includes('bundle-2'));
      assert.ok(actualBundleId1, 'Should find bundle-1 in lockfile');
      assert.ok(actualBundleId2, 'Should find bundle-2 in lockfile');

      // Uninstall first bundle
      await testContext.registryManager.uninstallBundle(actualBundleId1, 'repository');

      // Verify lockfile still exists
      assert.ok(fs.existsSync(lockfilePath), 'Lockfile should still exist after partial uninstall');

      // Verify second bundle remains in lockfile
      LockfileManager.resetInstance();
      const lockfileManager = LockfileManager.getInstance(workspaceRoot);
      const lockfileAfter = await lockfileManager.read();

      assert.ok(lockfileAfter, 'Lockfile should exist');
      const bundleIdsAfter = Object.keys(lockfileAfter.bundles);
      assert.strictEqual(bundleIdsAfter.length, 1, 'Should have one bundle remaining in lockfile');
      assert.ok(bundleIdsAfter.includes(actualBundleId2), 'Bundle-2 should remain in lockfile');
      assert.ok(!bundleIdsAfter.includes(actualBundleId1), 'Bundle-1 should be removed from lockfile');

      // Verify bundle-2 data is intact
      const remainingBundle = lockfileAfter.bundles[actualBundleId2];
      assert.strictEqual(remainingBundle.version, '1.0.0', 'Remaining bundle version should be intact');
      assert.strictEqual(remainingBundle.sourceId, sourceId2, 'Remaining bundle sourceId should be intact');
    });
  });

  suite('12.2: Lockfile Portability - SourceId Format', () => {
    /**
     * E2E Test: Verify lockfile with new sourceId format works across different hub configurations
     *
     * The new sourceId format is `{sourceType}-{12-char-hash}` (e.g., `github-a1b2c3d4e5f6`)
     * which is based on source properties (type + URL), not hub ID.
     * This makes lockfiles portable across different hub configurations.
     *
     * Requirements covered:
     * - Requirement 2: Remove Hub ID from SourceId Generation
     * - Requirement 3: Backward Compatibility for Legacy Lockfiles
     */
    test('Requirement 2.1, 2.3: Lockfile with new sourceId format is portable across hub configurations', async function () {
      this.timeout(60_000);

      // Stub workspace folders
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Generate a sourceId using the new format
      const sourceUrl = 'https://github.com/test-owner/test-repo';
      const sourceType = 'github';
      const newFormatSourceId = generateHubSourceId(sourceType, sourceUrl);

      assert.ok(
        !isLegacyHubSourceId(newFormatSourceId),
        'New format sourceId should NOT be detected as legacy format'
      );

      // Create a lockfile with the new sourceId format
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const bundleId = 'portable-bundle-v1.0.0';

      const mockLockfile = {
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        generatedBy: 'prompt-registry@1.0.0',
        bundles: {
          [bundleId]: {
            version: '1.0.0',
            sourceId: newFormatSourceId,
            sourceType: sourceType,
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/portable.prompt.md', checksum: 'abc123' }]
          }
        },
        sources: {
          [newFormatSourceId]: {
            type: sourceType,
            url: sourceUrl
          }
        }
      };

      // Create the bundle files so they're not marked as missing
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'portable.prompt.md'), '# Portable Prompt');

      fs.writeFileSync(lockfilePath, JSON.stringify(mockLockfile, null, 2));

      // Reset LockfileManager to pick up the new lockfile
      LockfileManager.resetInstance();

      // Query repository bundles - this simulates a different user with different hub config
      // The lockfile should work regardless of what hubs the user has configured
      const installedBundles = await testContext.registryManager.listInstalledBundles('repository');

      // Verify bundle is returned correctly
      assert.strictEqual(installedBundles.length, 1, 'Should return exactly one bundle');
      assert.strictEqual(installedBundles[0].bundleId, bundleId, 'Bundle ID should match');
      assert.strictEqual(installedBundles[0].version, '1.0.0', 'Version should match');
      assert.strictEqual(installedBundles[0].sourceId, newFormatSourceId, 'SourceId should use new format');
      assert.strictEqual(installedBundles[0].sourceType, sourceType, 'SourceType should match');
      assert.strictEqual(installedBundles[0].scope, 'repository', 'Scope should be repository');
    });

    test('Requirement 2.2, 2.3: Same source URL always produces same sourceId (deterministic)', function () {
      this.timeout(30_000);

      const sourceUrl = 'https://github.com/owner/repo';
      const sourceType = 'github';

      // Generate sourceId multiple times
      const sourceId1 = generateHubSourceId(sourceType, sourceUrl);
      const sourceId2 = generateHubSourceId(sourceType, sourceUrl);
      const sourceId3 = generateHubSourceId(sourceType, sourceUrl);

      // All should be identical (deterministic)
      assert.strictEqual(sourceId1, sourceId2, 'SourceId should be deterministic (1 vs 2)');
      assert.strictEqual(sourceId2, sourceId3, 'SourceId should be deterministic (2 vs 3)');
    });

    test('Requirement 2.3: SourceId is URL-normalized (case-insensitive, protocol-agnostic)', function () {
      this.timeout(30_000);

      const sourceType = 'github';

      // Different URL variations that should produce the same sourceId
      const url1 = 'https://github.com/Owner/Repo';
      const url2 = 'HTTPS://GITHUB.COM/OWNER/REPO';
      const url3 = 'http://github.com/owner/repo';
      const url4 = 'https://github.com/owner/repo/';

      const sourceId1 = generateHubSourceId(sourceType, url1);
      const sourceId2 = generateHubSourceId(sourceType, url2);
      const sourceId3 = generateHubSourceId(sourceType, url3);
      const sourceId4 = generateHubSourceId(sourceType, url4);

      // All should produce the same sourceId due to URL normalization
      assert.strictEqual(sourceId1, sourceId2, 'SourceId should be case-insensitive');
      assert.strictEqual(sourceId2, sourceId3, 'SourceId should be protocol-agnostic');
      assert.strictEqual(sourceId3, sourceId4, 'SourceId should ignore trailing slashes');
    });

    test('Requirement 3.1, 3.4: Legacy hub-prefixed sourceId still resolves correctly', async function () {
      this.timeout(60_000);

      // Stub workspace folders
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Create a lockfile with legacy hub-prefixed sourceId format
      const legacySourceId = 'hub-my-hub-github-source';
      const bundleId = 'legacy-bundle-v1.0.0';

      // Verify this is detected as legacy format
      assert.ok(
        isLegacyHubSourceId(legacySourceId),
        'Legacy sourceId should be detected as legacy format'
      );

      const mockLockfile = {
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        generatedBy: 'prompt-registry@1.0.0',
        bundles: {
          [bundleId]: {
            version: '1.0.0',
            sourceId: legacySourceId,
            sourceType: 'github',
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/legacy.prompt.md', checksum: 'def456' }]
          }
        },
        sources: {
          [legacySourceId]: {
            type: 'github',
            url: 'https://github.com/legacy-owner/legacy-repo'
          }
        }
      };

      // Create the bundle files
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'legacy.prompt.md'), '# Legacy Prompt');

      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      fs.writeFileSync(lockfilePath, JSON.stringify(mockLockfile, null, 2));

      // Reset LockfileManager
      LockfileManager.resetInstance();

      // Query repository bundles - legacy format should still work
      const installedBundles = await testContext.registryManager.listInstalledBundles('repository');

      // Verify bundle is returned correctly (backward compatibility)
      assert.strictEqual(installedBundles.length, 1, 'Should return exactly one bundle');
      assert.strictEqual(installedBundles[0].bundleId, bundleId, 'Bundle ID should match');
      assert.strictEqual(installedBundles[0].sourceId, legacySourceId, 'Legacy sourceId should be preserved');
      assert.strictEqual(installedBundles[0].sourceType, 'github', 'SourceType should match');
    });

    test('Requirement 2.5: Different source types with same URL produce different sourceIds', function () {
      this.timeout(30_000);

      const url = 'https://example.com/repo';

      // Same URL but different source types
      const githubSourceId = generateHubSourceId('github', url);
      const localSourceId = generateHubSourceId('local', url);

      // Should be different because source type is part of the hash input
      assert.notStrictEqual(githubSourceId, localSourceId, 'Different types should produce different sourceIds');

      // Verify each has correct type prefix
      assert.ok(githubSourceId.startsWith('github-'), 'GitHub sourceId should start with github-');
      assert.ok(localSourceId.startsWith('local-'), 'Local sourceId should start with local-');
    });

    test('Requirement 2: Lockfile with multiple bundles from different sources works correctly', async function () {
      this.timeout(60_000);

      // Stub workspace folders
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([
        { uri: vscode.Uri.file(workspaceRoot), name: 'test-workspace', index: 0 }
      ]);

      // Generate sourceIds for different sources
      const githubSourceId = generateHubSourceId('github', 'https://github.com/owner1/repo1');
      const localSourceId = generateHubSourceId('local', '/path/to/local/bundles');

      // Create a lockfile with bundles from multiple sources
      const lockfilePath = path.join(workspaceRoot, LOCKFILE_NAME);
      const bundle1Id = 'github-bundle-v1.0.0';
      const bundle2Id = 'local-bundle-v2.0.0';

      const mockLockfile = {
        $schema: 'https://github.com/AmadeusITGroup/prompt-registry/schemas/lockfile.schema.json',
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        generatedBy: 'prompt-registry@1.0.0',
        bundles: {
          [bundle1Id]: {
            version: '1.0.0',
            sourceId: githubSourceId,
            sourceType: 'github',
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/github-bundle.prompt.md', checksum: 'gh123' }]
          },
          [bundle2Id]: {
            version: '2.0.0',
            sourceId: localSourceId,
            sourceType: 'local',
            installedAt: new Date().toISOString(),
            commitMode: 'commit',
            files: [{ path: '.github/prompts/local-bundle.prompt.md', checksum: 'gl456' }]
          }
        },
        sources: {
          [githubSourceId]: {
            type: 'github',
            url: 'https://github.com/owner1/repo1'
          },
          [localSourceId]: {
            type: 'local',
            url: '/path/to/local/bundles'
          }
        }
      };

      // Create the bundle files
      const promptsDir = path.join(workspaceRoot, GITHUB_PROMPTS_DIR);
      fs.mkdirSync(promptsDir, { recursive: true });
      fs.writeFileSync(path.join(promptsDir, 'github-bundle.prompt.md'), '# GitHub Bundle');
      fs.writeFileSync(path.join(promptsDir, 'local-bundle.prompt.md'), '# Local Bundle');

      fs.writeFileSync(lockfilePath, JSON.stringify(mockLockfile, null, 2));

      // Reset LockfileManager
      LockfileManager.resetInstance();

      // Query repository bundles
      const installedBundles = await testContext.registryManager.listInstalledBundles('repository');

      // Verify both bundles are returned correctly
      assert.strictEqual(installedBundles.length, 2, 'Should return both bundles');

      const githubBundle = installedBundles.find((b) => b.bundleId === bundle1Id);
      const localBundle = installedBundles.find((b) => b.bundleId === bundle2Id);

      assert.ok(githubBundle, 'Should find GitHub bundle');
      assert.strictEqual(githubBundle.sourceId, githubSourceId, 'GitHub bundle sourceId should match');
      assert.strictEqual(githubBundle.sourceType, 'github', 'GitHub bundle sourceType should match');

      assert.ok(localBundle, 'Should find local bundle');
      assert.strictEqual(localBundle.sourceId, localSourceId, 'Local bundle sourceId should match');
      assert.strictEqual(localBundle.sourceType, 'local', 'Local bundle sourceType should match');
    });
  });
});
