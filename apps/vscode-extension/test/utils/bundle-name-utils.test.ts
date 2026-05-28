/**
 * Bundle Name Utilities Tests
 */

import * as assert from 'node:assert';
import {
  formatByteSize,
  generateBuildScriptBundleId,
  generateGitHubBundleId,
  generateSanitizedId,
  isManifestIdMatch,
} from '../../src/utils/bundle-name-utils';

suite('bundleNameUtils', () => {
  suite('generateSanitizedId', () => {
    test('should convert to lowercase', () => {
      assert.strictEqual(generateSanitizedId('MyProject'), 'myproject');
      assert.strictEqual(generateSanitizedId('UPPERCASE'), 'uppercase');
    });

    test('should replace spaces with hyphens', () => {
      assert.strictEqual(generateSanitizedId('my project'), 'my-project');
      assert.strictEqual(generateSanitizedId('hello world test'), 'hello-world-test');
    });

    test('should replace multiple spaces with single hyphen', () => {
      assert.strictEqual(generateSanitizedId('my   project'), 'my-project');
      assert.strictEqual(generateSanitizedId('hello    world'), 'hello-world');
    });

    test('should remove special characters', () => {
      assert.strictEqual(generateSanitizedId('my-project!!'), 'my-project');
      assert.strictEqual(generateSanitizedId('test@#$%name'), 'test-name');
    });

    test('should trim leading and trailing whitespace', () => {
      assert.strictEqual(generateSanitizedId('  my project  '), 'my-project');
      assert.strictEqual(generateSanitizedId('\t\ntest\t\n'), 'test');
    });

    test('should remove leading and trailing hyphens', () => {
      assert.strictEqual(generateSanitizedId('--my-project--'), 'my-project');
      assert.strictEqual(generateSanitizedId('!!!test!!!'), 'test');
    });

    test('should handle complex cases', () => {
      assert.strictEqual(generateSanitizedId('  My  Project!!  '), 'my-project');
      assert.strictEqual(generateSanitizedId('Hello, World! 123'), 'hello-world-123');
      assert.strictEqual(generateSanitizedId('test_name-here'), 'test-name-here');
    });

    test('should preserve numbers', () => {
      assert.strictEqual(generateSanitizedId('project123'), 'project123');
      assert.strictEqual(generateSanitizedId('v2.0.0'), 'v2-0-0');
    });

    test('should handle empty string', () => {
      assert.strictEqual(generateSanitizedId(''), '');
      assert.strictEqual(generateSanitizedId('   '), '');
    });
  });

  suite('formatByteSize', () => {
    test('should format bytes', () => {
      assert.strictEqual(formatByteSize(0), '0 B');
      assert.strictEqual(formatByteSize(512), '512 B');
      assert.strictEqual(formatByteSize(1023), '1023 B');
    });

    test('should format kilobytes', () => {
      assert.strictEqual(formatByteSize(1024), '1.0 KB');
      assert.strictEqual(formatByteSize(1536), '1.5 KB');
      assert.strictEqual(formatByteSize(10_240), '10.0 KB');
    });

    test('should format megabytes', () => {
      assert.strictEqual(formatByteSize(1024 * 1024), '1.0 MB');
      assert.strictEqual(formatByteSize(1.5 * 1024 * 1024), '1.5 MB');
      assert.strictEqual(formatByteSize(10 * 1024 * 1024), '10.0 MB');
    });
  });

  suite('isManifestIdMatch', () => {
    test('should match exact IDs', () => {
      assert.ok(isManifestIdMatch('my-bundle', '1.0.0', 'my-bundle'));
      assert.ok(isManifestIdMatch('owner-repo-v1.0.0', '1.0.0', 'owner-repo-v1.0.0'));
    });

    test('should match suffix pattern with v prefix', () => {
      assert.ok(isManifestIdMatch('collection', '1.0.0', 'owner-repo-collection-v1.0.0'));
      assert.ok(isManifestIdMatch('test2', '1.0.2', 'org-repo-test2-v1.0.2'));
    });

    test('should match suffix pattern without v prefix', () => {
      assert.ok(isManifestIdMatch('collection', '1.0.0', 'owner-repo-collection-1.0.0'));
      assert.ok(isManifestIdMatch('test2', '1.0.2', 'org-repo-test2-1.0.2'));
    });

    test('should not match mismatched IDs', () => {
      assert.ok(!isManifestIdMatch('wrong', '1.0.0', 'owner-repo-collection-v1.0.0'));
      assert.ok(!isManifestIdMatch('collection', '2.0.0', 'owner-repo-collection-v1.0.0'));
    });

    test('should handle special characters in repo names', () => {
      assert.ok(isManifestIdMatch('test2', '1.0.2', 'org-repo.name-test2-1.0.2'));
    });
  });

  suite('generateGitHubBundleId', () => {
    test('should generate ID with manifest info', () => {
      const id = generateGitHubBundleId('owner', 'repo', 'v1.0.0', 'collection', '1.0.0');
      assert.strictEqual(id, 'owner-repo-collection-1.0.0');
    });

    test('should generate legacy ID without manifest info', () => {
      const id = generateGitHubBundleId('owner', 'repo', 'v1.0.0');
      assert.strictEqual(id, 'owner-repo-v1.0.0');
    });

    test('should strip v prefix from tag when no manifest version', () => {
      const id = generateGitHubBundleId('owner', 'repo', 'v2.0.0', 'test');
      assert.strictEqual(id, 'owner-repo-test-2.0.0');
    });

    test('should use manifest version as-is when provided', () => {
      const id = generateGitHubBundleId('owner', 'repo', 'v2.0.0', 'test', '2.0.0');
      assert.strictEqual(id, 'owner-repo-test-2.0.0');
    });
  });

  suite('generateBuildScriptBundleId', () => {
    test('should generate ID with v prefix', () => {
      const id = generateBuildScriptBundleId('owner/repo', 'collection', '1.0.0');
      assert.strictEqual(id, 'owner-repo-collection-v1.0.0');
    });

    test('should normalize repo slug', () => {
      const id1 = generateBuildScriptBundleId('owner/repo', 'test', '1.0.0');
      const id2 = generateBuildScriptBundleId('owner-repo', 'test', '1.0.0');
      assert.strictEqual(id1, id2);
    });
  });
});
