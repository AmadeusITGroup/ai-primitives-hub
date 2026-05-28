/**
 * BundleCommands Cleanup Stale Entries Property-Based Tests
 *
 * Property-based tests for the cleanupStaleLockfileEntries command.
 *
 * Properties covered:
 * - Property 10: Stale Entry Cleanup (Requirements 3.4)
 *
 * **Feature: lockfile-source-of-truth, Property 10: Stale Entry Cleanup**
 * **Validates: Requirements 3.4**
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fc from 'fast-check';
import * as sinon from 'sinon';
import {
  LockfileManager,
} from '../../src/services/lockfile-manager';
import {
  Lockfile,
} from '../../src/types/lockfile';
import {
  generateMockChecksum,
  LockfileBuilder,
} from '../helpers/lockfile-test-helpers';
import {
  PropertyTestConfig,
} from '../helpers/property-test-helpers';

suite('BundleCommands Cleanup Stale Property Tests', () => {
  let sandbox: sinon.SinonSandbox;
  let tempDir: string;

  // ===== Test Utilities =====
  const createTempDir = (): string => {
    const dir = path.join(__dirname, '..', '..', 'test-temp-cleanup-prop-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const cleanupTempDir = (dir: string): void => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  /**
   * Create actual files on disk for a bundle's file entries
   * @param workspaceRoot
   * @param bundleId
   * @param filePaths
   */
  const createBundleFiles = (workspaceRoot: string, bundleId: string, filePaths: string[]): void => {
    for (const filePath of filePaths) {
      const fullPath = path.join(workspaceRoot, filePath);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, `Content for ${bundleId}`);
    }
  };

  /**
   * Write a lockfile to disk
   * @param workspaceRoot
   * @param lockfile
   */
  const writeLockfile = (workspaceRoot: string, lockfile: Lockfile): void => {
    const lockfilePath = path.join(workspaceRoot, 'prompt-registry.lock.json');
    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));
  };

  /**
   * Read a lockfile from disk
   * @param workspaceRoot
   */
  const readLockfile = (workspaceRoot: string): Lockfile | null => {
    const lockfilePath = path.join(workspaceRoot, 'prompt-registry.lock.json');
    if (!fs.existsSync(lockfilePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  };

  setup(() => {
    sandbox = sinon.createSandbox();
    tempDir = createTempDir();
    LockfileManager.resetInstance();
  });

  teardown(() => {
    sandbox.restore();
    LockfileManager.resetInstance();
    cleanupTempDir(tempDir);
  });

  /**
   * Property 10: Stale Entry Cleanup
   *
   * For any lockfile entry where the corresponding files do not exist,
   * the cleanup command SHALL remove that entry from the lockfile
   * without affecting entries with valid files.
   *
   * **Feature: lockfile-source-of-truth, Property 10: Stale Entry Cleanup**
   * **Validates: Requirements 3.4**
   */
  suite('Property 10: Stale Entry Cleanup', () => {
    test('stale entries should be identified correctly based on file existence', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate 1-3 bundles, some with files that exist, some without
          fc.integer({ min: 1, max: 3 }),
          fc.integer({ min: 0, max: 3 }),
          async (validBundleCount: number, staleBundleCount: number) => {
            // Skip if no bundles at all
            fc.pre(validBundleCount + staleBundleCount > 0);

            const workspaceRoot = path.join(tempDir, `workspace-${Date.now()}`);
            fs.mkdirSync(workspaceRoot, { recursive: true });

            // Build lockfile with both valid and stale bundles
            const builder = LockfileBuilder.create()
              .withSource('test-source', 'github', 'https://github.com/test/repo');

            const validBundleIds: string[] = [];
            const staleBundleIds: string[] = [];

            // Add valid bundles (files will exist)
            for (let i = 0; i < validBundleCount; i++) {
              const bundleId = `valid-bundle-${i}`;
              const filePath = `.github/prompts/${bundleId}.prompt.md`;
              validBundleIds.push(bundleId);

              builder.withBundleAndFiles(bundleId, '1.0.0', 'test-source', [
                { path: filePath, checksum: generateMockChecksum() }
              ]);

              // Create the actual file
              createBundleFiles(workspaceRoot, bundleId, [filePath]);
            }

            // Add stale bundles (files will NOT exist)
            for (let i = 0; i < staleBundleCount; i++) {
              const bundleId = `stale-bundle-${i}`;
              const filePath = `.github/prompts/${bundleId}.prompt.md`;
              staleBundleIds.push(bundleId);

              builder.withBundleAndFiles(bundleId, '1.0.0', 'test-source', [
                { path: filePath, checksum: generateMockChecksum() }
              ]);
              // Do NOT create the actual file - this makes it stale
            }

            const lockfile = builder.build();
            writeLockfile(workspaceRoot, lockfile);

            // Get installed bundles via LockfileManager
            const lockfileManager = LockfileManager.getInstance(workspaceRoot);
            const installedBundles = await lockfileManager.getInstalledBundles();

            // Property: Valid bundles should NOT have filesMissing flag
            for (const bundleId of validBundleIds) {
              const bundle = installedBundles.find((b) => b.bundleId === bundleId);
              assert.ok(bundle, `Valid bundle ${bundleId} should be in installed bundles`);
              assert.strictEqual(
                bundle.filesMissing,
                false,
                `Valid bundle ${bundleId} should NOT have filesMissing flag`
              );
            }

            // Property: Stale bundles SHOULD have filesMissing flag
            for (const bundleId of staleBundleIds) {
              const bundle = installedBundles.find((b) => b.bundleId === bundleId);
              assert.ok(bundle, `Stale bundle ${bundleId} should be in installed bundles`);
              assert.strictEqual(
                bundle.filesMissing,
                true,
                `Stale bundle ${bundleId} SHOULD have filesMissing flag`
              );
            }

            // Cleanup
            LockfileManager.resetInstance(workspaceRoot);
            fs.rmSync(workspaceRoot, { recursive: true, force: true });

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('removing stale entries should preserve valid entries', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate 1-3 valid bundles and 1-3 stale bundles
          fc.integer({ min: 1, max: 3 }),
          fc.integer({ min: 1, max: 3 }),
          async (validBundleCount: number, staleBundleCount: number) => {
            const workspaceRoot = path.join(tempDir, `workspace-${Date.now()}`);
            fs.mkdirSync(workspaceRoot, { recursive: true });

            // Build lockfile with both valid and stale bundles
            const builder = LockfileBuilder.create()
              .withSource('test-source', 'github', 'https://github.com/test/repo');

            const validBundleIds: string[] = [];
            const staleBundleIds: string[] = [];

            // Add valid bundles (files will exist)
            for (let i = 0; i < validBundleCount; i++) {
              const bundleId = `valid-bundle-${i}`;
              const filePath = `.github/prompts/${bundleId}.prompt.md`;
              validBundleIds.push(bundleId);

              builder.withBundleAndFiles(bundleId, '1.0.0', 'test-source', [
                { path: filePath, checksum: generateMockChecksum() }
              ]);

              // Create the actual file
              createBundleFiles(workspaceRoot, bundleId, [filePath]);
            }

            // Add stale bundles (files will NOT exist)
            for (let i = 0; i < staleBundleCount; i++) {
              const bundleId = `stale-bundle-${i}`;
              const filePath = `.github/prompts/${bundleId}.prompt.md`;
              staleBundleIds.push(bundleId);

              builder.withBundleAndFiles(bundleId, '1.0.0', 'test-source', [
                { path: filePath, checksum: generateMockChecksum() }
              ]);
              // Do NOT create the actual file - this makes it stale
            }

            const lockfile = builder.build();
            writeLockfile(workspaceRoot, lockfile);

            // Get LockfileManager and identify stale bundles
            const lockfileManager = LockfileManager.getInstance(workspaceRoot);
            const installedBundles = await lockfileManager.getInstalledBundles();
            const staleBundles = installedBundles.filter((b) => b.filesMissing);

            // Verify we identified the correct stale bundles
            assert.strictEqual(
              staleBundles.length,
              staleBundleCount,
              `Should identify ${staleBundleCount} stale bundles`
            );

            // Remove stale entries (simulating what the cleanup command does)
            for (const bundle of staleBundles) {
              await lockfileManager.remove(bundle.bundleId);
            }

            // Read the updated lockfile
            const updatedLockfile = readLockfile(workspaceRoot);

            // Property: Valid bundles should still exist in lockfile
            for (const bundleId of validBundleIds) {
              assert.ok(
                updatedLockfile?.bundles[bundleId],
                `Valid bundle ${bundleId} should still exist after cleanup`
              );
            }

            // Property: Stale bundles should be removed from lockfile
            for (const bundleId of staleBundleIds) {
              assert.ok(
                !updatedLockfile?.bundles[bundleId],
                `Stale bundle ${bundleId} should be removed after cleanup`
              );
            }

            // Property: Total bundle count should be reduced by stale count
            const remainingBundleCount = Object.keys(updatedLockfile?.bundles || {}).length;
            assert.strictEqual(
              remainingBundleCount,
              validBundleCount,
              `Should have ${validBundleCount} bundles remaining after cleanup`
            );

            // Cleanup
            LockfileManager.resetInstance(workspaceRoot);
            fs.rmSync(workspaceRoot, { recursive: true, force: true });

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('cleanup with no stale entries should not modify lockfile', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate 1-3 valid bundles only
          fc.integer({ min: 1, max: 3 }),
          async (validBundleCount: number) => {
            const workspaceRoot = path.join(tempDir, `workspace-${Date.now()}`);
            fs.mkdirSync(workspaceRoot, { recursive: true });

            // Build lockfile with only valid bundles
            const builder = LockfileBuilder.create()
              .withSource('test-source', 'github', 'https://github.com/test/repo');

            const validBundleIds: string[] = [];

            // Add valid bundles (files will exist)
            for (let i = 0; i < validBundleCount; i++) {
              const bundleId = `valid-bundle-${i}`;
              const filePath = `.github/prompts/${bundleId}.prompt.md`;
              validBundleIds.push(bundleId);

              builder.withBundleAndFiles(bundleId, '1.0.0', 'test-source', [
                { path: filePath, checksum: generateMockChecksum() }
              ]);

              // Create the actual file
              createBundleFiles(workspaceRoot, bundleId, [filePath]);
            }

            const lockfile = builder.build();
            writeLockfile(workspaceRoot, lockfile);

            // Get LockfileManager and check for stale bundles
            const lockfileManager = LockfileManager.getInstance(workspaceRoot);
            const installedBundles = await lockfileManager.getInstalledBundles();
            const staleBundles = installedBundles.filter((b) => b.filesMissing);

            // Property: No stale bundles should be identified
            assert.strictEqual(
              staleBundles.length,
              0,
              'Should identify 0 stale bundles when all files exist'
            );

            // Read the lockfile (should be unchanged)
            const currentLockfile = readLockfile(workspaceRoot);

            // Property: All valid bundles should still exist
            for (const bundleId of validBundleIds) {
              assert.ok(
                currentLockfile?.bundles[bundleId],
                `Valid bundle ${bundleId} should still exist`
              );
            }

            // Property: Bundle count should be unchanged
            const bundleCount = Object.keys(currentLockfile?.bundles || {}).length;
            assert.strictEqual(
              bundleCount,
              validBundleCount,
              `Should have ${validBundleCount} bundles (unchanged)`
            );

            // Cleanup
            LockfileManager.resetInstance(workspaceRoot);
            fs.rmSync(workspaceRoot, { recursive: true, force: true });

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });

    test('cleanup should delete lockfile when all entries are stale', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate 1-3 stale bundles only
          fc.integer({ min: 1, max: 3 }),
          async (staleBundleCount: number) => {
            const workspaceRoot = path.join(tempDir, `workspace-${Date.now()}`);
            fs.mkdirSync(workspaceRoot, { recursive: true });

            // Build lockfile with only stale bundles
            const builder = LockfileBuilder.create()
              .withSource('test-source', 'github', 'https://github.com/test/repo');

            const staleBundleIds: string[] = [];

            // Add stale bundles (files will NOT exist)
            for (let i = 0; i < staleBundleCount; i++) {
              const bundleId = `stale-bundle-${i}`;
              const filePath = `.github/prompts/${bundleId}.prompt.md`;
              staleBundleIds.push(bundleId);

              builder.withBundleAndFiles(bundleId, '1.0.0', 'test-source', [
                { path: filePath, checksum: generateMockChecksum() }
              ]);
              // Do NOT create the actual file - this makes it stale
            }

            const lockfile = builder.build();
            writeLockfile(workspaceRoot, lockfile);

            // Verify lockfile exists
            const lockfilePath = path.join(workspaceRoot, 'prompt-registry.lock.json');
            assert.ok(fs.existsSync(lockfilePath), 'Lockfile should exist before cleanup');

            // Get LockfileManager and identify stale bundles
            const lockfileManager = LockfileManager.getInstance(workspaceRoot);
            const installedBundles = await lockfileManager.getInstalledBundles();
            const staleBundles = installedBundles.filter((b) => b.filesMissing);

            // Verify all bundles are stale
            assert.strictEqual(
              staleBundles.length,
              staleBundleCount,
              `All ${staleBundleCount} bundles should be stale`
            );

            // Remove all stale entries (simulating what the cleanup command does)
            for (const bundle of staleBundles) {
              await lockfileManager.remove(bundle.bundleId);
            }

            // Property: Lockfile should be deleted when all entries are removed
            assert.ok(
              !fs.existsSync(lockfilePath),
              'Lockfile should be deleted when all entries are stale'
            );

            // Cleanup
            LockfileManager.resetInstance(workspaceRoot);
            if (fs.existsSync(workspaceRoot)) {
              fs.rmSync(workspaceRoot, { recursive: true, force: true });
            }

            return true;
          }
        ),
        {
          ...PropertyTestConfig.FAST_CHECK_OPTIONS,
          numRuns: PropertyTestConfig.RUNS.STANDARD
        }
      );
    });
  });
});
