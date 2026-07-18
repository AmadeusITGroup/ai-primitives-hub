/**
 * Tests for E2E Test Helpers
 *
 * Validates that the E2ETestContext helper properly:
 * - Creates isolated storage directories
 * - Cleans up test artifacts
 * - Handles cleanup even on test failure
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createE2ETestContext,
  generateTestId,
  waitForCondition,
} from './e2e-test-helpers';

suite('E2E Test Helpers', () => {
  suite('createE2ETestContext', () => {
    test('should create isolated storage directory for each test (Example 3.1)', async function () {
      this.timeout(10_000);

      // Create two test contexts
      const context1 = await createE2ETestContext();
      const context2 = await createE2ETestContext();

      try {
        // Verify each has unique storage path
        assert.notStrictEqual(
          context1.tempStoragePath,
          context2.tempStoragePath,
          'Each test context should have unique storage path'
        );

        // Verify directories exist
        assert.ok(
          fs.existsSync(context1.tempStoragePath),
          'Context 1 storage directory should exist'
        );
        assert.ok(
          fs.existsSync(context2.tempStoragePath),
          'Context 2 storage directory should exist'
        );

        // Verify storage subdirectories are created
        const paths1 = context1.storage.getPaths();
        assert.ok(
          fs.existsSync(paths1.installed),
          'Installed directory should be created'
        );
        assert.ok(
          fs.existsSync(paths1.cache),
          'Cache directory should be created'
        );
      } finally {
        // Cleanup both contexts
        await context1.cleanup();
        await context2.cleanup();
      }
    });

    test('should cleanup all test artifacts after teardown (Example 3.2)', async function () {
      this.timeout(10_000);

      // Create test context
      const context = await createE2ETestContext();
      const storagePath = context.tempStoragePath;

      // Verify directory exists before cleanup
      assert.ok(
        fs.existsSync(storagePath),
        'Storage directory should exist before cleanup'
      );

      // Create some test files to simulate test artifacts
      const testFile = path.join(storagePath, 'test-artifact.json');
      fs.writeFileSync(testFile, JSON.stringify({ test: 'data' }));
      assert.ok(fs.existsSync(testFile), 'Test artifact should be created');

      // Run cleanup
      await context.cleanup();

      // Verify directory is removed
      assert.ok(
        !fs.existsSync(storagePath),
        'Storage directory should be removed after cleanup'
      );
      assert.ok(
        !fs.existsSync(testFile),
        'Test artifacts should be removed after cleanup'
      );
    });

    test('should cleanup even on test failure (Example 3.3)', async function () {
      this.timeout(10_000);

      let cleanupCalled = false;

      // Create test context
      const context = await createE2ETestContext();
      const storagePath = context.tempStoragePath;

      // Wrap cleanup to track if it was called
      const originalCleanup = context.cleanup;
      context.cleanup = async () => {
        cleanupCalled = true;
        await originalCleanup();
      };

      try {
        // Simulate test failure
        throw new Error('Simulated test failure');
      } catch {
        // In real tests, this would be in teardown
        // Here we manually call cleanup to simulate teardown behavior
        await context.cleanup();
      }

      // Verify cleanup was called and directory removed
      assert.ok(cleanupCalled, 'Cleanup should be called');
      assert.ok(
        !fs.existsSync(storagePath),
        'Storage directory should be removed even after test failure'
      );
    });

    test('should provide working RegistryManager instance', async function () {
      this.timeout(10_000);

      const context = await createE2ETestContext();

      try {
        // Verify RegistryManager is available
        assert.ok(context.registryManager, 'RegistryManager should be available');

        // Verify storage is available
        assert.ok(context.storage, 'Storage should be available');

        // Verify storage paths point to temp directory
        const paths = context.storage.getPaths();
        assert.ok(
          paths.root.startsWith(context.tempStoragePath)
          || paths.root === context.tempStoragePath,
          'Storage root should be in temp directory'
        );
      } finally {
        await context.cleanup();
      }
    });
  });

  suite('generateTestId', () => {
    test('should generate unique IDs', () => {
      const id1 = generateTestId();
      const id2 = generateTestId();

      assert.notStrictEqual(id1, id2, 'Generated IDs should be unique');
    });

    test('should include prefix in ID', () => {
      const id = generateTestId('my-prefix');

      assert.ok(id.startsWith('my-prefix-'), 'ID should start with prefix');
    });
  });

  suite('waitForCondition', () => {
    test('should resolve when condition becomes true', async function () {
      this.timeout(5000);

      let counter = 0;
      const condition = () => {
        counter++;
        return counter >= 3;
      };

      await waitForCondition(condition, 2000, 50);

      assert.ok(counter >= 3, 'Condition should have been checked multiple times');
    });

    test('should reject on timeout', async function () {
      this.timeout(5000);

      const condition = () => false; // Never true

      try {
        await waitForCondition(condition, 200, 50);
        assert.fail('Should have thrown timeout error');
      } catch (error: any) {
        assert.ok(
          error.message.includes('timeout'),
          'Error should mention timeout'
        );
      }
    });
  });
});
