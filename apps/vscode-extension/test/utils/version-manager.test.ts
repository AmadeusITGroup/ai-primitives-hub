/**
 * Unit tests for VersionManager
 * Requirements: 2.1, 2.2, 4.2
 */
import * as assert from 'node:assert';
import {
  VersionManager,
} from '../../src/utils/version-manager';

suite('VersionManager Unit Tests', () => {
  suite('compareVersions', () => {
    test('should compare standard semver versions correctly', () => {
      assert.strictEqual(VersionManager.compareVersions('1.0.0', '2.0.0'), -1);
      assert.strictEqual(VersionManager.compareVersions('2.0.0', '1.0.0'), 1);
      assert.strictEqual(VersionManager.compareVersions('1.0.0', '1.0.0'), 0);
    });

    test('should handle versions with v prefix', () => {
      assert.strictEqual(VersionManager.compareVersions('v1.0.0', 'v2.0.0'), -1);
      assert.strictEqual(VersionManager.compareVersions('v2.0.0', 'v1.0.0'), 1);
      assert.strictEqual(VersionManager.compareVersions('v1.0.0', 'v1.0.0'), 0);
    });

    test('should handle mixed format versions', () => {
      assert.strictEqual(VersionManager.compareVersions('v1.0.0', '2.0.0'), -1);
      assert.strictEqual(VersionManager.compareVersions('1.0.0', 'v2.0.0'), -1);
    });

    test('should compare patch versions correctly', () => {
      assert.strictEqual(VersionManager.compareVersions('1.0.0', '1.0.1'), -1);
      assert.strictEqual(VersionManager.compareVersions('1.0.1', '1.0.0'), 1);
    });

    test('should compare minor versions correctly', () => {
      assert.strictEqual(VersionManager.compareVersions('1.0.0', '1.1.0'), -1);
      assert.strictEqual(VersionManager.compareVersions('1.1.0', '1.0.0'), 1);
    });

    test('should handle pre-release versions', () => {
      assert.strictEqual(VersionManager.compareVersions('1.0.0-alpha', '1.0.0'), -1);
      assert.strictEqual(VersionManager.compareVersions('1.0.0', '1.0.0-alpha'), 1);
      assert.strictEqual(VersionManager.compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
    });

    test('should coerce malformed versions', () => {
      // These should be coerced to valid semver
      assert.strictEqual(VersionManager.compareVersions('1', '2'), -1);
      assert.strictEqual(VersionManager.compareVersions('1.0', '1.1'), -1);
    });

    test('should fall back to string comparison for non-semver', () => {
      // When coercion fails, use string comparison
      const result = VersionManager.compareVersions('abc', 'def');
      assert.strictEqual(result, 'abc'.localeCompare('def'));
    });

    test('should throw error for empty strings', () => {
      // Empty strings should throw validation error
      assert.throws(() => VersionManager.compareVersions('', '1.0.0'), /cannot be empty/);
      assert.throws(() => VersionManager.compareVersions('1.0.0', ''), /cannot be empty/);
      assert.throws(() => VersionManager.compareVersions('', ''), /cannot be empty/);
    });

    test('should throw error for very long version strings', () => {
      const longVersion = '1.0.0-' + 'a'.repeat(200);
      assert.throws(() => VersionManager.compareVersions(longVersion, '1.0.0'), /exceeds maximum length/);
      assert.throws(() => VersionManager.compareVersions('1.0.0', longVersion), /exceeds maximum length/);
    });

    test('should handle build metadata correctly', () => {
      // Build metadata should be ignored per semver spec
      assert.strictEqual(VersionManager.compareVersions('1.0.0+build.123', '1.0.0+build.456'), 0);
      assert.strictEqual(VersionManager.compareVersions('1.0.0+build', '1.0.0'), 0);
    });
  });

  suite('isUpdateAvailable', () => {
    test('should return true when latest version is higher', () => {
      assert.strictEqual(VersionManager.isUpdateAvailable('1.0.0', '2.0.0'), true);
      assert.strictEqual(VersionManager.isUpdateAvailable('1.0.0', '1.1.0'), true);
      assert.strictEqual(VersionManager.isUpdateAvailable('1.0.0', '1.0.1'), true);
    });

    test('should return false when versions are equal', () => {
      assert.strictEqual(VersionManager.isUpdateAvailable('1.0.0', '1.0.0'), false);
      assert.strictEqual(VersionManager.isUpdateAvailable('v1.0.0', 'v1.0.0'), false);
    });

    test('should return false when installed version is higher', () => {
      assert.strictEqual(VersionManager.isUpdateAvailable('2.0.0', '1.0.0'), false);
      assert.strictEqual(VersionManager.isUpdateAvailable('1.1.0', '1.0.0'), false);
    });

    test('should handle versions with v prefix', () => {
      assert.strictEqual(VersionManager.isUpdateAvailable('v1.0.0', 'v2.0.0'), true);
      assert.strictEqual(VersionManager.isUpdateAvailable('v2.0.0', 'v1.0.0'), false);
    });

    test('should handle mixed format versions', () => {
      assert.strictEqual(VersionManager.isUpdateAvailable('v1.0.0', '2.0.0'), true);
      assert.strictEqual(VersionManager.isUpdateAvailable('1.0.0', 'v2.0.0'), true);
    });

    test('should throw error for empty versions', () => {
      assert.throws(() => VersionManager.isUpdateAvailable('', '1.0.0'), /cannot be empty/);
      assert.throws(() => VersionManager.isUpdateAvailable('1.0.0', ''), /cannot be empty/);
    });
  });

  suite('extractBundleIdentity', () => {
    test('should extract identity from GitHub bundle IDs with version', () => {
      assert.strictEqual(
        VersionManager.extractBundleIdentity('owner-repo-v1.0.0', 'github'),
        'owner-repo'
      );
      assert.strictEqual(
        VersionManager.extractBundleIdentity('microsoft-vscode-1.0.0', 'github'),
        'microsoft-vscode'
      );
    });

    test('should handle GitHub bundle IDs with complex versions', () => {
      assert.strictEqual(
        VersionManager.extractBundleIdentity('owner-repo-v1.0.0-alpha', 'github'),
        'owner-repo'
      );
      assert.strictEqual(
        VersionManager.extractBundleIdentity('owner-repo-2.1.3', 'github'),
        'owner-repo'
      );
    });

    test('should handle GitHub bundle IDs with hyphens in name', () => {
      assert.strictEqual(
        VersionManager.extractBundleIdentity('my-org-my-repo-v1.0.0', 'github'),
        'my-org-my-repo'
      );
    });

    test('should return as-is for GitHub bundles without version', () => {
      assert.strictEqual(
        VersionManager.extractBundleIdentity('owner-repo', 'github'),
        'owner-repo'
      );
    });

    test('should handle bundle IDs with multiple version-like patterns', () => {
      assert.strictEqual(
        VersionManager.extractBundleIdentity('v1-repo-v2.0.0', 'github'),
        'v1-repo'
      );
    });

    test('should handle single-part bundle IDs', () => {
      assert.strictEqual(
        VersionManager.extractBundleIdentity('repo', 'github'),
        'repo'
      );
    });

    test('should handle numeric repo names', () => {
      assert.strictEqual(
        VersionManager.extractBundleIdentity('owner-123-v1.0.0', 'github'),
        'owner-123'
      );
    });

    test('should throw error for excessively long bundle IDs', () => {
      const longId = 'a'.repeat(201) + '-v1.0.0';
      assert.throws(() => VersionManager.extractBundleIdentity(longId, 'github'), /exceeds maximum length/);
    });

    test('should return as-is for non-GitHub sources', () => {
      assert.strictEqual(
        VersionManager.extractBundleIdentity('bundle-id-v1.0.0', 'local'),
        'bundle-id-v1.0.0'
      );
    });
  });
});
