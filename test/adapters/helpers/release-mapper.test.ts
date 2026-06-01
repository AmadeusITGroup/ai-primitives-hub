import * as assert from 'node:assert';
import {
  extractDescription,
  extractEnvironments,
  extractTags,
  hasValidBundleAssets,
  mapReleaseToBundle,
} from '../../../src/adapters/helpers/release-mapper';
import type {
  GitHubRelease,
} from '../../../src/services/github-client';

suite('release-mapper', () => {
  suite('extractDescription()', () => {
    test('extracts first paragraph from body', () => {
      const body = 'This is the description.\nSecond line.\n\nThis is second paragraph.';
      assert.strictEqual(extractDescription(body), 'This is the description. Second line.');
    });
    test('returns empty string for empty body', () => {
      assert.strictEqual(extractDescription(''), '');
    });
    test('truncates to 200 characters', () => {
      assert.strictEqual(extractDescription('a'.repeat(300)).length, 200);
    });
  });

  suite('extractEnvironments()', () => {
    test('extracts environments from body', () => {
      assert.deepStrictEqual(extractEnvironments('environments: vscode, cursor, windsurf'), ['vscode', 'cursor', 'windsurf']);
    });
    test('returns default [vscode] when not specified', () => {
      assert.deepStrictEqual(extractEnvironments('no env here'), ['vscode']);
    });
  });

  suite('extractTags()', () => {
    test('extracts tags from body', () => {
      assert.deepStrictEqual(extractTags('tags: python, testing, ai'), ['python', 'testing', 'ai']);
    });
    test('returns empty array when no tags', () => {
      assert.deepStrictEqual(extractTags('no tags'), []);
    });
  });

  suite('hasValidBundleAssets()', () => {
    test('returns true when release has manifest and bundle', () => {
      const release = { assets: [
        { name: 'deployment-manifest.yml', url: '', browser_download_url: '', size: 100 },
        { name: 'bundle.zip', url: '', browser_download_url: '', size: 5000 }
      ] } as any;
      assert.strictEqual(hasValidBundleAssets(release), true);
    });
    test('returns false when missing manifest', () => {
      const release = { assets: [{ name: 'bundle.zip', url: '', browser_download_url: '', size: 5000 }] } as any;
      assert.strictEqual(hasValidBundleAssets(release), false);
    });
  });

  suite('mapReleaseToBundle()', () => {
    test('maps release with manifest to Bundle', () => {
      const release: GitHubRelease = {
        tag_name: 'v1.2.3', name: 'My Bundle Release', body: 'A great bundle',
        assets: [
          { name: 'deployment-manifest.yml', url: 'https://api.github.com/assets/1', browser_download_url: '', size: 100 },
          { name: 'bundle.zip', url: 'https://api.github.com/assets/2', browser_download_url: '', size: 5000 }
        ],
        published_at: '2026-01-15T00:00:00Z'
      };
      const manifest = {
        id: 'my-bundle', name: 'My Bundle', version: '1.2.3', description: 'From manifest',
        author: 'manifest-author', environments: ['vscode'], tags: ['ai'], dependencies: [], license: 'MIT'
      };
      const bundle = mapReleaseToBundle(release, manifest, 'octocat', 'hello-world', 'source-1', 'https://github.com/octocat/hello-world');
      assert.strictEqual(bundle.name, 'My Bundle');
      assert.strictEqual(bundle.version, '1.2.3');
      assert.strictEqual(bundle.downloadUrl, 'https://api.github.com/assets/2');
    });
    test('falls back to release data when manifest is null', () => {
      const release: GitHubRelease = {
        tag_name: 'v2.0.0', name: 'Release Name', body: 'desc',
        assets: [
          { name: 'deployment-manifest.json', url: 'u1', browser_download_url: '', size: 100 },
          { name: 'my-bundle.tar.gz', url: 'u2', browser_download_url: '', size: 5000 }
        ],
        published_at: '2026-02-01T00:00:00Z'
      };
      const bundle = mapReleaseToBundle(release, null, 'octocat', 'hello-world', 'source-1', 'https://github.com/octocat/hello-world');
      assert.strictEqual(bundle.name, 'Release Name');
      assert.strictEqual(bundle.version, '2.0.0');
      assert.strictEqual(bundle.author, 'octocat');
    });
  });
});
