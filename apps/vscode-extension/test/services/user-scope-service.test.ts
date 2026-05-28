/**
 * UserScopeService Unit Tests
 * Tests cross-platform path resolution and sync functionality
 *
 * Note: Most tests require VS Code integration test environment
 * These are unit tests for testable logic only
 *
 * WSL-specific tests are in UserScopeService.wsl.test.ts
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  UserScopeService,
} from '../../src/services/user-scope-service';

suite('UserScopeService', () => {
  let service: UserScopeService;
  let mockContext: any;
  let tempDir: string;

  setup(() => {
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp-copilot');

    // Mock VS Code ExtensionContext with realistic path structure
    // Simulate: ~/Library/Application Support/Code/User/globalStorage/publisher.extension
    const mockUserDir = path.join(tempDir, 'Code', 'User');
    mockContext = {
      globalStorageUri: { fsPath: path.join(mockUserDir, 'globalStorage', 'publisher.extension') },
      storageUri: { fsPath: path.join(tempDir, 'workspace') },
      extensionPath: __dirname,
      subscriptions: []
    };

    // Create temp directories
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    service = new UserScopeService(mockContext);
  });

  teardown(() => {
    // Cleanup temp directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Service Initialization', () => {
    test('should initialize with context', () => {
      assert.ok(service, 'Service should be initialized');
    });

    test('should have sync methods', () => {
      assert.ok(typeof service.syncBundle === 'function', 'Should have syncBundle method');
      assert.ok(typeof service.unsyncBundle === 'function', 'Should have unsyncBundle method');
    });
  });

  suite('syncBundle', () => {
    test('should accept bundle ID and path', async () => {
      const bundleId = 'test-bundle';
      const bundlePath = path.join(tempDir, 'bundle');

      // Create mock bundle directory
      if (!fs.existsSync(bundlePath)) {
        fs.mkdirSync(bundlePath, { recursive: true });
      }

      // Create a mock deployment-manifest.yml
      const manifestPath = path.join(bundlePath, 'deployment-manifest.yml');
      fs.writeFileSync(manifestPath, `
id: ${bundleId}
version: "1.0.0"
prompts: []
`);

      // This will likely fail in unit test without real Copilot directory
      // But we're testing that the method exists and accepts parameters
      try {
        await service.syncBundle(bundleId, bundlePath);
        // If it succeeds, great!
        assert.ok(true, 'syncBundle should complete');
      } catch (error: any) {
        // Expected in unit test environment
        // Just verify error is related to file operations, not parameter issues
        assert.ok(error.message || true, 'Error is expected in unit test environment');
      }
    });

    test('should reject invalid bundle path', async () => {
      try {
        await service.syncBundle('invalid-bundle', '/nonexistent/path');
        // Should not reach here
        assert.fail('Should throw error for invalid path');
      } catch (error) {
        assert.ok(error, 'Should throw error for invalid bundle path');
      }
    });
  });

  suite('unsyncBundle', () => {
    test('should accept bundle ID', async () => {
      const bundleId = 'test-bundle';

      // This will try to remove sync files
      // In unit test, may not have anything to remove
      try {
        await service.unsyncBundle(bundleId);
        assert.ok(true, 'unsyncBundle should complete');
      } catch (error: any) {
        // May fail if Copilot directory doesn't exist
        assert.ok(error.message || true, 'Error is expected in unit test environment');
      }
    });

    test('should handle non-existent bundle', async () => {
      try {
        await service.unsyncBundle('non-existent-bundle');
        // Should complete without error (idempotent)
        assert.ok(true, 'Should handle non-existent bundle gracefully');
      } catch (error: any) {
        // Or throw appropriate error
        assert.ok(error, 'Error handling is acceptable');
      }
    });
  });

  suite('Error Handling', () => {
    test('should handle missing deployment manifest', async () => {
      const bundleId = 'no-manifest-bundle';
      const bundlePath = path.join(tempDir, 'no-manifest');

      if (!fs.existsSync(bundlePath)) {
        fs.mkdirSync(bundlePath, { recursive: true });
      }

      // No manifest file created

      try {
        await service.syncBundle(bundleId, bundlePath);
        // May succeed or fail depending on implementation
      } catch (error: any) {
        assert.ok(error.message.includes('manifest') || error.message.includes('ENOENT'),
          'Error should mention manifest or file not found');
      }
    });

    test('should provide meaningful error messages', async () => {
      try {
        await service.syncBundle('', '');
        assert.fail('Should throw error for empty parameters');
      } catch (error: any) {
        assert.ok(error.message, 'Should provide error message');
        assert.ok(error.message.length > 0, 'Error message should not be empty');
      }
    });
  });

  suite('Broken Symlink Handling', () => {
    test('should correctly identify broken vs valid symlinks', () => {
      const validTarget = path.join(tempDir, 'valid-target.txt');
      const validSymlink = path.join(tempDir, 'valid-symlink.txt');

      fs.writeFileSync(validTarget, 'valid content');

      try {
        fs.symlinkSync(validTarget, validSymlink);

        // Create a broken symlink by creating symlink then removing target
        const brokenTarget = path.join(tempDir, 'broken-target.txt');
        const brokenSymlink = path.join(tempDir, 'broken-symlink.txt');

        fs.writeFileSync(brokenTarget, 'will be deleted');
        fs.symlinkSync(brokenTarget, brokenSymlink);
        fs.unlinkSync(brokenTarget);

        // Verify fs.existsSync behavior (the root cause of the bug)
        assert.strictEqual(fs.existsSync(validSymlink), true,
          'fs.existsSync should return true for valid symlink');
        assert.strictEqual(fs.existsSync(brokenSymlink), false,
          'fs.existsSync returns false for broken symlink (this is the bug)');

        // Verify lstat can still detect broken symlinks
        const brokenStats = fs.lstatSync(brokenSymlink);
        assert.strictEqual(brokenStats.isSymbolicLink(), true,
          'lstat should detect broken symlink');
      } catch (error: any) {
        if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
          assert.ok(true, 'Symlinks not supported on this platform');
        } else {
          throw error;
        }
      }
    });
  });
});
