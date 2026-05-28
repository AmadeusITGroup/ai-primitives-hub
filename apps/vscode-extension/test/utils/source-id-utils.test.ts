/**
 * Source ID Utilities Tests
 *
 * Tests for the sourceIdUtils module which provides stable, portable
 * source identifiers for lockfile entries.
 */

import * as assert from 'node:assert';
import {
  generateHubKey,
  generateHubSourceId,
  generateLegacyHubKey,
  generateLegacyHubSourceId,
  isLegacyHubSourceId,
  normalizeUrl,
  normalizeUrlLegacy,
} from '../../src/utils/source-id-utils';

suite('sourceIdUtils', () => {
  suite('generateHubSourceId()', () => {
    test('should produce correct format: {sourceType}-{12-char-hash}', () => {
      const result = generateHubSourceId('github', 'https://github.com/owner/repo');

      // Should match format: type-12hexchars
      assert.match(result, /^github-[a-f0-9]{12}$/);
    });

    test('should be deterministic - same input produces same output', () => {
      const url = 'https://github.com/owner/repo';
      const sourceType = 'github';

      const result1 = generateHubSourceId(sourceType, url);
      const result2 = generateHubSourceId(sourceType, url);
      const result3 = generateHubSourceId(sourceType, url);

      assert.strictEqual(result1, result2);
      assert.strictEqual(result2, result3);
    });

    test('should normalize URL case', () => {
      const result1 = generateHubSourceId('github', 'https://GitHub.com/Owner/Repo');
      const result2 = generateHubSourceId('github', 'https://github.com/Owner/Repo');

      // Host should be case-insensitive, but path should be case-sensitive
      // So these should be EQUAL (same host, same path case)
      assert.strictEqual(result1, result2, 'Host case should be normalized');
    });

    test('should normalize path case (case-insensitive)', () => {
      const result1 = generateHubSourceId('github', 'https://github.com/Owner/Repo');
      const result2 = generateHubSourceId('github', 'https://github.com/owner/repo');

      // Different path case should produce same IDs (case-insensitive)
      assert.strictEqual(result1, result2, 'Path case should be normalized (case-insensitive)');
    });

    test('should normalize full URL case', () => {
      const resultMixedHost = generateHubSourceId('github', 'https://GitHub.COM/Owner/Repo');
      const resultLowerHost = generateHubSourceId('github', 'https://github.com/Owner/Repo');
      const resultDiffPath = generateHubSourceId('github', 'https://github.com/owner/repo');

      // Same path, different host case -> should be equal
      assert.strictEqual(resultMixedHost, resultLowerHost, 'Host case should be normalized');

      // Different path case -> should also be equal (full case-insensitive normalization)
      assert.strictEqual(resultLowerHost, resultDiffPath, 'Path case should be normalized');
    });

    test('should normalize URL protocol', () => {
      const result1 = generateHubSourceId('github', 'https://github.com/owner/repo');
      const result2 = generateHubSourceId('github', 'http://github.com/owner/repo');

      assert.strictEqual(result1, result2);
    });

    test('should normalize trailing slashes', () => {
      const result1 = generateHubSourceId('github', 'https://github.com/owner/repo');
      const result2 = generateHubSourceId('github', 'https://github.com/owner/repo/');
      const result3 = generateHubSourceId('github', 'https://github.com/owner/repo///');

      assert.strictEqual(result1, result2);
      assert.strictEqual(result2, result3);
    });

    test('should produce different IDs for different source types', () => {
      const url = 'https://example.com/repo';

      const githubId = generateHubSourceId('github', url);
      const localId = generateHubSourceId('local', url);
      const awesomeId = generateHubSourceId('awesome-copilot', url);

      assert.notStrictEqual(githubId, localId);
      assert.notStrictEqual(localId, awesomeId);
      assert.notStrictEqual(githubId, awesomeId);
    });

    test('should produce different IDs for different URLs', () => {
      const sourceType = 'github';

      const id1 = generateHubSourceId(sourceType, 'https://github.com/owner1/repo');
      const id2 = generateHubSourceId(sourceType, 'https://github.com/owner2/repo');

      assert.notStrictEqual(id1, id2);
    });

    test('should handle various source types', () => {
      const url = 'https://example.com/repo';

      assert.match(generateHubSourceId('github', url), /^github-[a-f0-9]{12}$/);
      assert.match(generateHubSourceId('local', url), /^local-[a-f0-9]{12}$/);
      assert.match(generateHubSourceId('awesome-copilot', url), /^awesome-copilot-[a-f0-9]{12}$/);
      assert.match(generateHubSourceId('apm', url), /^apm-[a-f0-9]{12}$/);
    });

    test('should produce different IDs for same URL but different branch', () => {
      const url = 'https://github.com/owner/repo';
      const sourceType = 'github';

      const id1 = generateHubSourceId(sourceType, url, { branch: 'main' });
      const id2 = generateHubSourceId(sourceType, url, { branch: 'develop' });

      assert.notStrictEqual(id1, id2, 'Different branches should produce different IDs');
    });

    test('should produce different IDs for same URL but different collectionsPath', () => {
      const url = 'https://github.com/owner/repo';
      const sourceType = 'github';

      const id1 = generateHubSourceId(sourceType, url, { collectionsPath: 'collections' });
      const id2 = generateHubSourceId(sourceType, url, { collectionsPath: 'prompts' });

      assert.notStrictEqual(id1, id2, 'Different collectionsPath should produce different IDs');
    });

    test('should produce same ID when defaults are explicit vs omitted', () => {
      const url = 'https://github.com/owner/repo';
      const sourceType = 'github';

      const idNoConfig = generateHubSourceId(sourceType, url);
      const idExplicitDefaults = generateHubSourceId(sourceType, url, {
        branch: 'main',
        collectionsPath: 'collections'
      });

      assert.strictEqual(idNoConfig, idExplicitDefaults, 'Omitted config should equal explicit defaults');
    });

    test('should produce same ID when branch default varies (main vs master)', () => {
      const url = 'https://github.com/owner/repo';
      const sourceType = 'github';

      const idMain = generateHubSourceId(sourceType, url, { branch: 'main' });
      const idMaster = generateHubSourceId(sourceType, url, { branch: 'master' });

      // Both main and master should be treated as the default branch
      assert.strictEqual(idMain, idMaster, 'main and master should produce same ID');
    });
  });

  suite('isLegacyHubSourceId()', () => {
    test('should return true for legacy format with 3 segments', () => {
      assert.strictEqual(isLegacyHubSourceId('hub-my-hub-source1'), true);
    });

    test('should return true for legacy format with more than 3 segments', () => {
      assert.strictEqual(isLegacyHubSourceId('hub-test-hub-github-source'), true);
      assert.strictEqual(isLegacyHubSourceId('hub-a-b-c-d-e'), true);
    });

    test('should return false for new format', () => {
      assert.strictEqual(isLegacyHubSourceId('github-a1b2c3d4e5f6'), false);
      assert.strictEqual(isLegacyHubSourceId('local-123456789abc'), false);
      assert.strictEqual(isLegacyHubSourceId('apm-abcdef123456'), false);
    });

    test('should return false for hub- prefix with only 2 segments', () => {
      assert.strictEqual(isLegacyHubSourceId('hub-only'), false);
    });

    test('should return false for non-hub prefixed IDs', () => {
      assert.strictEqual(isLegacyHubSourceId('github-source'), false);
      assert.strictEqual(isLegacyHubSourceId('my-custom-source'), false);
      assert.strictEqual(isLegacyHubSourceId('source-id'), false);
    });

    test('should return false for empty string', () => {
      assert.strictEqual(isLegacyHubSourceId(''), false);
    });

    test('should return false for hub prefix without hyphen', () => {
      assert.strictEqual(isLegacyHubSourceId('hubsource'), false);
    });
  });

  suite('generateHubKey()', () => {
    test('should produce correct format: 12-char hash', () => {
      const result = generateHubKey('https://example.com/hub.json');

      assert.match(result, /^[a-f0-9]{12}$/);
    });

    test('should be deterministic - same input produces same output', () => {
      const url = 'https://example.com/hub.json';

      const result1 = generateHubKey(url);
      const result2 = generateHubKey(url);
      const result3 = generateHubKey(url);

      assert.strictEqual(result1, result2);
      assert.strictEqual(result2, result3);
    });

    test('should not append branch for main', () => {
      const url = 'https://example.com/hub.json';

      const result = generateHubKey(url, 'main');

      // Should be just the hash, no branch suffix
      assert.match(result, /^[a-f0-9]{12}$/);
    });

    test('should not append branch for master', () => {
      const url = 'https://example.com/hub.json';

      const result = generateHubKey(url, 'master');

      // Should be just the hash, no branch suffix
      assert.match(result, /^[a-f0-9]{12}$/);
    });

    test('should append branch for non-main/master branches', () => {
      const url = 'https://example.com/hub.json';

      const result = generateHubKey(url, 'develop');

      // Should be hash-branch format
      assert.match(result, /^[a-f0-9]{12}-develop$/);
    });

    test('should handle various branch names', () => {
      const url = 'https://example.com/hub.json';

      assert.match(generateHubKey(url, 'feature/test'), /^[a-f0-9]{12}-feature\/test$/);
      assert.match(generateHubKey(url, 'release-1.0'), /^[a-f0-9]{12}-release-1\.0$/);
      assert.match(generateHubKey(url, 'v2'), /^[a-f0-9]{12}-v2$/);
    });

    test('should produce same hash for same URL regardless of branch', () => {
      const url = 'https://example.com/hub.json';

      const keyMain = generateHubKey(url, 'main');
      const keyDevelop = generateHubKey(url, 'develop');

      // Extract hash portion (first 12 chars)
      const hashMain = keyMain.substring(0, 12);
      const hashDevelop = keyDevelop.substring(0, 12);

      assert.strictEqual(hashMain, hashDevelop);
    });

    test('should normalize full URL case', () => {
      // Same path, different host case -> should be equal
      const result1 = generateHubKey('https://Example.COM/hub.json');
      const result2 = generateHubKey('https://example.com/hub.json');
      assert.strictEqual(result1, result2, 'Host case should be normalized');

      // Different path case -> should also be equal (full case-insensitive normalization)
      const result3 = generateHubKey('https://example.com/Hub.json');
      assert.strictEqual(result2, result3, 'Path case should be normalized');
    });

    test('should normalize URL protocol', () => {
      const result1 = generateHubKey('https://example.com/hub.json');
      const result2 = generateHubKey('http://example.com/hub.json');

      assert.strictEqual(result1, result2);
    });

    test('should normalize trailing slashes', () => {
      const result1 = generateHubKey('https://example.com/hub.json');
      const result2 = generateHubKey('https://example.com/hub.json/');

      assert.strictEqual(result1, result2);
    });

    test('should produce different keys for different URLs', () => {
      const key1 = generateHubKey('https://example.com/hub1.json');
      const key2 = generateHubKey('https://example.com/hub2.json');

      assert.notStrictEqual(key1, key2);
    });

    test('should handle undefined branch', () => {
      const result = generateHubKey('https://example.com/hub.json', undefined);

      // Should be just the hash, no branch suffix
      assert.match(result, /^[a-f0-9]{12}$/);
    });

    test('should handle empty string branch', () => {
      const result = generateHubKey('https://example.com/hub.json', '');

      // Empty string is falsy, should be just the hash
      assert.match(result, /^[a-f0-9]{12}$/);
    });
  });

  suite('normalizeUrlLegacy()', () => {
    test('should lowercase host only, preserve path case', () => {
      const result = normalizeUrlLegacy('https://GitHub.COM/Owner/Repo');
      assert.strictEqual(result, 'github.com/Owner/Repo');
    });

    test('should match normalizeUrl when path is already lowercase', () => {
      const url = 'https://github.com/owner/repo';
      assert.strictEqual(normalizeUrlLegacy(url), normalizeUrl(url));
    });

    test('should differ from normalizeUrl when path has uppercase', () => {
      const url = 'https://github.com/Owner/Repo';
      assert.notStrictEqual(normalizeUrlLegacy(url), normalizeUrl(url));
    });

    test('should remove trailing slashes', () => {
      const result = normalizeUrlLegacy('https://github.com/Owner/Repo/');
      assert.strictEqual(result, 'github.com/Owner/Repo');
    });

    test('should remove protocol', () => {
      const result = normalizeUrlLegacy('https://github.com/Path');
      assert.ok(!result.startsWith('https://'));
    });
  });

  suite('generateLegacyHubSourceId()', () => {
    test('should return undefined when URL path is all lowercase', () => {
      const result = generateLegacyHubSourceId('github', 'https://github.com/owner/repo');
      assert.strictEqual(result, undefined);
    });

    test('should return a legacy ID when URL path has uppercase', () => {
      const result = generateLegacyHubSourceId('github', 'https://github.com/Owner/Repo');
      assert.ok(result, 'Should return a legacy ID');
      assert.match(result, /^github-[a-f0-9]{12}$/);
    });

    test('legacy ID should differ from current ID for mixed-case URL', () => {
      const url = 'https://github.com/Owner/Repo';
      const legacyId = generateLegacyHubSourceId('github', url);
      const currentId = generateHubSourceId('github', url);

      assert.ok(legacyId);
      assert.notStrictEqual(legacyId, currentId);
    });

    test('should respect branch and collectionsPath config', () => {
      const url = 'https://github.com/Owner/Repo';
      const id1 = generateLegacyHubSourceId('github', url, { branch: 'main' });
      const id2 = generateLegacyHubSourceId('github', url, { branch: 'develop' });

      assert.ok(id1);
      assert.ok(id2);
      assert.notStrictEqual(id1, id2, 'Different branches should produce different legacy IDs');
    });
  });

  suite('generateLegacyHubKey()', () => {
    test('should return undefined when URL path is all lowercase', () => {
      const result = generateLegacyHubKey('https://example.com/hub.json');
      assert.strictEqual(result, undefined);
    });

    test('should return a legacy key when URL path has uppercase', () => {
      const result = generateLegacyHubKey('https://example.com/Hub.json');
      assert.ok(result);
      assert.match(result, /^[a-f0-9]{12}$/);
    });

    test('legacy key should differ from current key for mixed-case URL', () => {
      const url = 'https://example.com/Hub.json';
      const legacyKey = generateLegacyHubKey(url);
      const currentKey = generateHubKey(url);

      assert.ok(legacyKey);
      assert.notStrictEqual(legacyKey, currentKey);
    });

    test('should append branch for non-main branches', () => {
      const result = generateLegacyHubKey('https://example.com/Hub.json', 'develop');
      assert.ok(result);
      assert.match(result, /^[a-f0-9]{12}-develop$/);
    });

    test('should not append branch for main', () => {
      const result = generateLegacyHubKey('https://example.com/Hub.json', 'main');
      assert.ok(result);
      assert.match(result, /^[a-f0-9]{12}$/);
    });
  });
});
