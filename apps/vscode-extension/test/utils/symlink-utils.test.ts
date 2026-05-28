/**
 * Symlink Utilities Unit Tests
 * Tests for broken symlink detection and symlink target verification
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  checkPathExists,
} from '../../src/utils/symlink-utils';

suite('symlinkUtils', () => {
  let tempDir: string;

  setup(() => {
    tempDir = path.join(__dirname, '..', '..', '..', 'test-temp-symlink-utils');

    // Create temp directory
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  teardown(() => {
    // Cleanup temp directories
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('checkPathExists', () => {
    test('should return exists=false for non-existent path', async () => {
      const result = await checkPathExists(path.join(tempDir, 'non-existent'));

      assert.strictEqual(result.exists, false);
      assert.strictEqual(result.isSymbolicLink, false);
      assert.strictEqual(result.isBroken, false);
    });

    test('should return exists=true for regular file', async () => {
      const filePath = path.join(tempDir, 'regular-file.txt');
      fs.writeFileSync(filePath, 'content');

      const result = await checkPathExists(filePath);

      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.isSymbolicLink, false);
      assert.strictEqual(result.isBroken, false);
    });

    test('should return exists=true for directory', async () => {
      const dirPath = path.join(tempDir, 'test-dir');
      fs.mkdirSync(dirPath);

      const result = await checkPathExists(dirPath);

      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.isSymbolicLink, false);
      assert.strictEqual(result.isBroken, false);
    });

    test('should detect valid symlink', async () => {
      const targetPath = path.join(tempDir, 'symlink-target.txt');
      const symlinkPath = path.join(tempDir, 'valid-symlink.txt');

      fs.writeFileSync(targetPath, 'target content');

      try {
        fs.symlinkSync(targetPath, symlinkPath);

        const result = await checkPathExists(symlinkPath);

        assert.strictEqual(result.exists, true);
        assert.strictEqual(result.isSymbolicLink, true);
        assert.strictEqual(result.isBroken, false);
      } catch (error: any) {
        // Symlinks may not be supported on all platforms
        if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
          assert.ok(true, 'Symlinks not supported on this platform');
        } else {
          throw error;
        }
      }
    });

    test('should detect broken symlink', async () => {
      const targetPath = path.join(tempDir, 'will-be-deleted.txt');
      const symlinkPath = path.join(tempDir, 'broken-symlink.txt');

      fs.writeFileSync(targetPath, 'will be deleted');

      try {
        fs.symlinkSync(targetPath, symlinkPath);

        // Remove target to make symlink broken
        fs.unlinkSync(targetPath);

        // Verify fs.existsSync returns false (the bug we're fixing)
        assert.strictEqual(fs.existsSync(symlinkPath), false,
          'fs.existsSync should return false for broken symlink');

        // Our utility should detect the broken symlink
        const result = await checkPathExists(symlinkPath);

        assert.strictEqual(result.exists, true, 'Should detect broken symlink exists');
        assert.strictEqual(result.isSymbolicLink, true, 'Should identify as symlink');
        assert.strictEqual(result.isBroken, true, 'Should identify as broken');
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
