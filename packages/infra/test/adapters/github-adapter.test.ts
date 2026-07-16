import type {
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  GitHubAdapter,
} from '../../src/adapters/github-adapter';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  RecordingGitHubApi,
} from '../helpers/recording-github-api';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'github-test',
    name: 'GitHub Test',
    type: 'github',
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

const RELEASES_PATH = '/repos/owner/repo/releases';
const REPO_PATH = '/repos/owner/repo';
const MANIFEST_ASSET_URL = 'https://api.github.com/repos/owner/repo/releases/assets/1';
const BUNDLE_ASSET_URL = 'https://api.github.com/repos/owner/repo/releases/assets/2';

const MANIFEST_YAML = ['id: my-collection', 'name: My Bundle', 'version: 1.0.0', 'description: From manifest', 'author: manifest-author', 'tags: [from-manifest]', 'license: MIT'].join(
  '\n'
);

function makeRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v1.0.0',
    name: 'Release Name',
    body: 'A release description.\n\nSecond paragraph.',
    assets: [
      { name: 'deployment-manifest.yml', browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/deployment-manifest.yml', url: MANIFEST_ASSET_URL, size: 128 },
      { name: 'bundle.zip', browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/bundle.zip', url: BUNDLE_ASSET_URL, size: 4096 }
    ],
    published_at: '2024-01-01T00:00:00Z',
    ...overrides
  };
}

describe('GitHubAdapter', () => {
  describe('URL validation', () => {
    it('rejects a non-GitHub HTTPS URL', () => {
      expect(() => new GitHubAdapter(makeSource({ url: 'https://gitlab.com/owner/repo' }), new FakeGitHubApi())).toThrow(
        'Invalid GitHub URL'
      );
    });

    it('accepts an HTTPS github.com URL', () => {
      expect(() => new GitHubAdapter(makeSource(), new FakeGitHubApi())).not.toThrow();
    });

    it('accepts an SSH git@github.com URL', () => {
      expect(() => new GitHubAdapter(makeSource({ url: 'git@github.com:owner/repo.git' }), new FakeGitHubApi())).not.toThrow();
    });

    it('rejects a URL that is neither https:// nor git@', () => {
      expect(() => new GitHubAdapter(makeSource({ url: 'ftp://github.com/owner/repo' }), new FakeGitHubApi())).toThrow(
        'Invalid GitHub URL'
      );
    });
  });

  describe('requiresAuthentication', () => {
    it('defaults to false when the source is not marked private', () => {
      expect(new GitHubAdapter(makeSource(), new FakeGitHubApi()).requiresAuthentication()).toBe(false);
    });

    it('is true when the source is marked private', () => {
      expect(new GitHubAdapter(makeSource({ private: true }), new FakeGitHubApi()).requiresAuthentication()).toBe(true);
    });
  });

  describe('getManifestUrl / getDownloadUrl', () => {
    it('builds "latest" URLs when no version is given', () => {
      const adapter = new GitHubAdapter(makeSource(), new FakeGitHubApi());
      expect(adapter.getManifestUrl('my-bundle')).toBe(
        'https://github.com/owner/repo/releases/download/latest/deployment-manifest.json'
      );
      expect(adapter.getDownloadUrl('my-bundle')).toBe('https://github.com/owner/repo/releases/download/latest/bundle.zip');
    });

    it('builds v-prefixed URLs when a version is given', () => {
      const adapter = new GitHubAdapter(makeSource(), new FakeGitHubApi());
      expect(adapter.getManifestUrl('my-bundle', '2.0.0')).toBe(
        'https://github.com/owner/repo/releases/download/v2.0.0/deployment-manifest.json'
      );
      expect(adapter.getDownloadUrl('my-bundle', '2.0.0')).toBe('https://github.com/owner/repo/releases/download/v2.0.0/bundle.zip');
    });
  });

  describe('fetchBundles', () => {
    it('builds a bundle from a release with both a manifest and a bundle asset', async () => {
      const api = new FakeGitHubApi().seedJson(RELEASES_PATH, [makeRelease()]).seedText(MANIFEST_ASSET_URL, MANIFEST_YAML);
      const bundles = await new GitHubAdapter(makeSource(), api).fetchBundles();

      expect(bundles).toHaveLength(1);
      expect(bundles[0]).toMatchObject({
        id: 'owner-repo-my-collection-1.0.0',
        name: 'My Bundle',
        version: '1.0.0',
        description: 'From manifest',
        author: 'manifest-author',
        sourceId: 'github-test',
        tags: ['from-manifest'],
        license: 'MIT',
        size: '4.0 KB',
        manifestUrl: MANIFEST_ASSET_URL,
        downloadUrl: BUNDLE_ASSET_URL,
        repository: 'https://github.com/owner/repo'
      });
    });

    it('parses a JSON manifest asset by its .json extension', async () => {
      const release = makeRelease({
        assets: [
          { name: 'deployment-manifest.json', browser_download_url: '', url: MANIFEST_ASSET_URL, size: 128 },
          { name: 'bundle.zip', browser_download_url: '', url: BUNDLE_ASSET_URL, size: 4096 }
        ]
      });
      const api = new FakeGitHubApi()
        .seedJson(RELEASES_PATH, [release])
        .seedText(MANIFEST_ASSET_URL, JSON.stringify({ id: 'json-collection', name: 'JSON Bundle', version: '3.0.0' }));

      const bundles = await new GitHubAdapter(makeSource(), api).fetchBundles();

      expect(bundles[0]).toMatchObject({ id: 'owner-repo-json-collection-3.0.0', name: 'JSON Bundle', version: '3.0.0' });
    });

    it('attaches manifest prompts/mcpServers to the bundle for the Marketplace content-breakdown UI', async () => {
      const manifestYaml = [
        'id: my-collection',
        'name: My Bundle',
        'version: 1.0.0',
        'prompts:',
        '  - id: example',
        '    file: prompts/example.prompt.md',
        'mcpServers:',
        '  example-server:',
        '    command: node'
      ].join('\n');
      const api = new FakeGitHubApi().seedJson(RELEASES_PATH, [makeRelease()]).seedText(MANIFEST_ASSET_URL, manifestYaml);

      const bundles = await new GitHubAdapter(makeSource(), api).fetchBundles();

      expect((bundles[0] as unknown as { prompts: unknown[] }).prompts).toEqual([{ id: 'example', file: 'prompts/example.prompt.md' }]);
      expect((bundles[0] as unknown as { mcpServers: unknown }).mcpServers).toEqual({ 'example-server': { command: 'node' } });
    });

    it('does not attach prompts/mcpServers when the manifest declares neither', async () => {
      const bundles = await new GitHubAdapter(makeSource(), new FakeGitHubApi().seedJson(RELEASES_PATH, [makeRelease()]).seedText(MANIFEST_ASSET_URL, MANIFEST_YAML)).fetchBundles();

      expect(bundles[0]).not.toHaveProperty('prompts');
      expect(bundles[0]).not.toHaveProperty('mcpServers');
    });

    it('skips a release missing a manifest asset', async () => {
      const release = makeRelease({ assets: [{ name: 'bundle.zip', browser_download_url: '', url: BUNDLE_ASSET_URL, size: 10 }] });
      const api = new FakeGitHubApi().seedJson(RELEASES_PATH, [release]);
      expect(await new GitHubAdapter(makeSource(), api).fetchBundles()).toEqual([]);
    });

    it('skips a release missing a bundle asset', async () => {
      const release = makeRelease({
        assets: [{ name: 'deployment-manifest.yml', browser_download_url: '', url: MANIFEST_ASSET_URL, size: 10 }]
      });
      const api = new FakeGitHubApi().seedJson(RELEASES_PATH, [release]);
      expect(await new GitHubAdapter(makeSource(), api).fetchBundles()).toEqual([]);
    });

    it('falls back to release-derived metadata when the manifest download fails', async () => {
      // MANIFEST_ASSET_URL deliberately not seeded in getText, so it 404s.
      const release = makeRelease({
        tag_name: 'v9.9.9',
        name: 'Fallback Release',
        body: 'Description paragraph.\n\nenvironments: vscode, jetbrains\ntags: alpha, beta'
      });
      const api = new FakeGitHubApi().seedJson(RELEASES_PATH, [release]);

      const bundles = await new GitHubAdapter(makeSource(), api).fetchBundles();

      expect(bundles).toHaveLength(1);
      expect(bundles[0]).toMatchObject({
        id: 'owner-repo-v9.9.9',
        name: 'Fallback Release',
        version: '9.9.9',
        description: 'Description paragraph.',
        author: 'owner',
        environments: ['vscode', 'jetbrains'],
        tags: ['alpha', 'beta'],
        license: 'Unknown'
      });
    });

    it('defaults environments to ["vscode"] when the release body declares none', async () => {
      const release = makeRelease({ body: 'No structured fields here.' });
      const api = new FakeGitHubApi().seedJson(RELEASES_PATH, [release]);
      const bundles = await new GitHubAdapter(makeSource(), api).fetchBundles();
      expect(bundles[0].environments).toEqual(['vscode']);
      expect(bundles[0].tags).toEqual([]);
    });

    it('processes every release across a manifest-download concurrency batch boundary', async () => {
      const releaseCount = 12; // > MANIFEST_DOWNLOAD_CONCURRENCY (10)
      const api = new FakeGitHubApi();
      const releases = Array.from({ length: releaseCount }, (_, i) => {
        const manifestUrl = `https://api.github.com/repos/owner/repo/releases/assets/manifest-${i}`;
        const bundleUrl = `https://api.github.com/repos/owner/repo/releases/assets/bundle-${i}`;
        api.seedText(manifestUrl, `id: bundle-${i}\nversion: 1.0.${i}`);
        return makeRelease({
          tag_name: `v1.0.${i}`,
          assets: [
            { name: 'deployment-manifest.yml', browser_download_url: '', url: manifestUrl, size: 10 },
            { name: 'bundle.zip', browser_download_url: '', url: bundleUrl, size: 10 }
          ]
        });
      });
      api.seedJson(RELEASES_PATH, releases);

      const bundles = await new GitHubAdapter(makeSource(), api).fetchBundles();

      expect(bundles).toHaveLength(releaseCount);
      expect(new Set(bundles.map((b) => b.id)).size).toBe(releaseCount);
    });

    it('caches a manifest across repeated fetchBundles() calls instead of re-downloading it', async () => {
      const api = new FakeGitHubApi().seedJson(RELEASES_PATH, [makeRelease()]).seedText(MANIFEST_ASSET_URL, MANIFEST_YAML);
      const recordingApi = new RecordingGitHubApi(api);

      const adapter = new GitHubAdapter(makeSource(), recordingApi);
      await adapter.fetchBundles();
      await adapter.fetchBundles();

      expect(recordingApi.countOf('getText')).toBe(1);
    });

    it('clearManifestCache() forces the next fetchBundles() to re-download the manifest', async () => {
      const api = new FakeGitHubApi().seedJson(RELEASES_PATH, [makeRelease()]).seedText(MANIFEST_ASSET_URL, MANIFEST_YAML);
      const recordingApi = new RecordingGitHubApi(api);

      const adapter = new GitHubAdapter(makeSource(), recordingApi);
      await adapter.fetchBundles();
      adapter.clearManifestCache();
      await adapter.fetchBundles();

      expect(recordingApi.countOf('getText')).toBe(2);
    });

    it('wraps a releases-list failure with a descriptive error', async () => {
      await expect(new GitHubAdapter(makeSource(), new FakeGitHubApi()).fetchBundles()).rejects.toThrow(
        'Failed to fetch bundles from GitHub'
      );
    });
  });

  describe('downloadBundle', () => {
    it('returns the downloaded bytes as a Buffer', async () => {
      const bytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04]);
      const api = new FakeGitHubApi().seedBytes(BUNDLE_ASSET_URL, bytes);
      const buffer = await new GitHubAdapter(makeSource(), api).downloadBundle({ downloadUrl: BUNDLE_ASSET_URL } as never);
      expect(buffer).toEqual(Buffer.from(bytes));
    });

    it('wraps a download failure with a descriptive error', async () => {
      const api = new FakeGitHubApi();
      await expect(new GitHubAdapter(makeSource(), api).downloadBundle({ downloadUrl: BUNDLE_ASSET_URL } as never)).rejects.toThrow(
        'Failed to download bundle'
      );
    });
  });

  describe('fetchMetadata', () => {
    it('combines repo info and release count', async () => {
      const api = new FakeGitHubApi()
        .seedJson(REPO_PATH, { name: 'repo', description: 'A repo', updated_at: '2024-06-01T00:00:00Z' })
        .seedJson(RELEASES_PATH, [makeRelease(), makeRelease({ tag_name: 'v1.0.1' })]);

      const metadata = await new GitHubAdapter(makeSource(), api).fetchMetadata();

      expect(metadata).toEqual({ name: 'repo', description: 'A repo', bundleCount: 2, lastUpdated: '2024-06-01T00:00:00Z', version: '1.0.0' });
    });

    it('wraps a failure with a descriptive error', async () => {
      await expect(new GitHubAdapter(makeSource(), new FakeGitHubApi()).fetchMetadata()).rejects.toThrow(
        'Failed to fetch GitHub metadata'
      );
    });
  });

  describe('validate', () => {
    it('is valid with no warnings when releases exist', async () => {
      const api = new FakeGitHubApi().seedJson(REPO_PATH, { name: 'repo' }).seedJson(RELEASES_PATH, [makeRelease()]);
      expect(await new GitHubAdapter(makeSource(), api).validate()).toEqual({ valid: true, errors: [], warnings: [], bundlesFound: 1 });
    });

    it('is valid but warns when there are no releases', async () => {
      const api = new FakeGitHubApi().seedJson(REPO_PATH, { name: 'repo' }).seedJson(RELEASES_PATH, []);
      expect(await new GitHubAdapter(makeSource(), api).validate()).toEqual({
        valid: true,
        errors: [],
        warnings: ['No releases found in repository'],
        bundlesFound: 0
      });
    });

    it('is invalid when the repository cannot be reached', async () => {
      const result = await new GitHubAdapter(makeSource(), new FakeGitHubApi()).validate();
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('GitHub validation failed');
      expect(result.bundlesFound).toBe(0);
    });
  });
});
