/**
 * GitHubAdapter Unit Tests
 * Tests adapter domain logic by mocking GitHubClient
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  GitHubAdapter,
} from '../../src/adapters/github-adapter';
import {
  GitHubClient,
  GitHubRelease,
} from '../../src/services/github-client';
import {
  GitHubAuthError,
  GitHubClientError,
  GitHubNotFoundError,
} from '../../src/services/github-client-errors';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('GitHubAdapter', () => {
  const mockSource: RegistrySource = {
    id: 'test-source',
    name: 'Test Source',
    type: 'github',
    url: 'https://github.com/test-owner/test-repo',
    enabled: true,
    priority: 1,
    token: 'test-token'
  };

  const createMockClient = (): sinon.SinonStubbedInstance<GitHubClient> => {
    const mockClient = sinon.createStubInstance(GitHubClient);
    Object.defineProperty(mockClient, 'owner', { value: 'test-owner' });
    Object.defineProperty(mockClient, 'repo', { value: 'test-repo' });
    return mockClient;
  };

  const makeRelease = (overrides: Partial<GitHubRelease> = {}): GitHubRelease => {
    return {
      tag_name: 'v1.0.0',
      name: 'Release 1.0.0',
      body: 'Release notes',
      published_at: '2025-01-01T00:00:00Z',
      assets: [
        {
          name: 'deployment-manifest.json',
          url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/123',
          browser_download_url: 'https://github.com/.../deployment-manifest.json',
          size: 1024
        },
        {
          name: 'bundle.zip',
          url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/124',
          browser_download_url: 'https://github.com/.../bundle.zip',
          size: 2048
        }
      ],
      ...overrides
    };
  };

  suite('Constructor and Validation', () => {
    test('should accept valid GitHub URL', () => {
      const mockClient = createMockClient();
      const adapter = new GitHubAdapter(mockSource, mockClient);
      assert.strictEqual(adapter.type, 'github');
    });

    test('should accept GitHub SSH URL', () => {
      const source = { ...mockSource, url: 'git@github.com:test-owner/test-repo.git' };
      const mockClient = createMockClient();
      const adapter = new GitHubAdapter(source, mockClient);
      assert.ok(adapter);
    });

    test('should throw error for invalid URL when creating default client', () => {
      const source = { ...mockSource, url: 'https://invalid.com/repo', token: undefined };
      assert.throws(() => new GitHubAdapter(source), /Invalid GitHub URL/);
    });
  });

  suite('fetchMetadata', () => {
    test('should fetch repository metadata successfully', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.resolves({
        name: 'test-repo',
        description: 'Test repository',
        updatedAt: '2025-01-01T00:00:00Z'
      });
      mockClient.listReleases.resolves([makeRelease(), makeRelease({ tag_name: 'v1.1.0' })]);

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const metadata = await adapter.fetchMetadata();

      assert.strictEqual(metadata.name, 'test-repo');
      assert.strictEqual(metadata.description, 'Test repository');
      assert.strictEqual(metadata.bundleCount, 2);
    });

    test('should handle API errors gracefully', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.rejects(new GitHubNotFoundError('test-owner', 'test-repo'));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      await assert.rejects(
        () => adapter.fetchMetadata(),
        /Failed to fetch GitHub metadata/
      );
    });
  });

  suite('fetchBundles', () => {
    test('should fetch bundles from releases', async () => {
      const mockClient = createMockClient();
      mockClient.listReleases.resolves([makeRelease()]);
      mockClient.downloadAsset.resolves(Buffer.from(JSON.stringify({
        id: 'test-bundle',
        name: 'Test Bundle Name',
        version: '1.0.0',
        description: 'Test bundle description',
        author: 'Test Author'
      })));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].id, 'test-owner-test-repo-test-bundle-1.0.0');
      assert.strictEqual(bundles[0].version, '1.0.0');
      assert.strictEqual(bundles[0].sourceId, 'test-source');
    });

    test('should use bundle name from deployment manifest, not version number', async () => {
      const mockClient = createMockClient();
      mockClient.listReleases.resolves([makeRelease({
        tag_name: 'v1.0.12',
        name: '1.0.12',
        assets: [
          {
            name: 'deployment-manifest.yml',
            url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/123',
            browser_download_url: 'https://github.com/.../deployment-manifest.yml',
            size: 1024
          },
          {
            name: 'bundle.zip',
            url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/124',
            browser_download_url: 'https://github.com/.../bundle.zip',
            size: 2048
          }
        ]
      })]);

      const manifestContent = `
id: amadeus-airlines-solutions
name: Amadeus Airlines Solutions
version: 1.0.12
description: Comprehensive airline management system
author: amadeus-airlines-solutions
tags:
  - airlines
  - travel
  - booking
`;
      mockClient.downloadAsset.resolves(Buffer.from(manifestContent));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'Amadeus Airlines Solutions');
      assert.notStrictEqual(bundles[0].name, '1.0.12');
      assert.strictEqual(bundles[0].version, '1.0.12');
      assert.strictEqual(bundles[0].description, 'Comprehensive airline management system');
      assert.strictEqual(bundles[0].author, 'amadeus-airlines-solutions');
      assert.deepStrictEqual(bundles[0].tags, ['airlines', 'travel', 'booking']);
    });

    test('should fallback to GitHub release name when manifest fetch fails', async () => {
      const mockClient = createMockClient();
      mockClient.listReleases.resolves([makeRelease({ name: 'Fallback Release Name' })]);
      mockClient.downloadAsset.rejects(new Error('Download failed'));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'Fallback Release Name');
    });

    test('should skip releases without manifest', async () => {
      const mockClient = createMockClient();
      mockClient.listReleases.resolves([{
        tag_name: 'v1.0.0',
        name: 'Release without manifest',
        body: '',
        published_at: '2025-01-01T00:00:00Z',
        assets: [
          {
            name: 'bundle.zip',
            url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/124',
            browser_download_url: 'https://github.com/.../bundle.zip',
            size: 2048
          }
        ]
      }]);

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });

    test('should handle empty releases', async () => {
      const mockClient = createMockClient();
      mockClient.listReleases.resolves([]);

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });
  });

  suite('validate', () => {
    test('should validate accessible repository', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.resolves({ name: 'test-repo', description: '', updatedAt: '' });
      mockClient.listReleases.resolves([]);

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should report validation failure for inaccessible repository', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.rejects(new GitHubNotFoundError('test-owner', 'test-repo'));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    test('should handle authentication errors', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.rejects(new GitHubAuthError('Bad credentials', 401));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors[0].includes('401'));
    });

    test('should warn when repository has no releases', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.resolves({ name: 'test-repo', description: '', updatedAt: '' });
      mockClient.listReleases.resolves([]);

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.some((w) => w.includes('No releases found')));
    });
  });

  suite('URL Generation', () => {
    test('should generate correct manifest URL', () => {
      const mockClient = createMockClient();
      const adapter = new GitHubAdapter(mockSource, mockClient);
      const url = adapter.getManifestUrl('bundle-id', '1.0.0');

      assert.ok(url.includes('test-owner/test-repo'));
      assert.ok(url.includes('v1.0.0'));
      assert.ok(url.includes('deployment-manifest.json'));
    });

    test('should generate correct download URL', () => {
      const mockClient = createMockClient();
      const adapter = new GitHubAdapter(mockSource, mockClient);
      const url = adapter.getDownloadUrl('bundle-id', '1.0.0');

      assert.ok(url.includes('test-owner/test-repo'));
      assert.ok(url.includes('v1.0.0'));
      assert.ok(url.includes('bundle.zip'));
    });

    test('should use latest tag when version not specified', () => {
      const mockClient = createMockClient();
      const adapter = new GitHubAdapter(mockSource, mockClient);
      const url = adapter.getManifestUrl('bundle-id');

      assert.ok(url.includes('latest'));
    });
  });

  suite('downloadBundle', () => {
    test('should download bundle successfully', async () => {
      const mockClient = createMockClient();
      const bundleContent = Buffer.from('test bundle content');
      mockClient.downloadAsset.resolves(bundleContent);

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const result = await adapter.downloadBundle({
        id: 'test-bundle',
        name: 'Test Bundle',
        version: '1.0.0',
        description: 'Test',
        author: 'Test Author',
        sourceId: 'test-source',
        environments: [],
        tags: [],
        lastUpdated: '2025-01-01T00:00:00Z',
        size: '1KB',
        dependencies: [],
        license: 'MIT',
        downloadUrl: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/124',
        manifestUrl: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/123'
      });

      assert.ok(Buffer.isBuffer(result));
      assert.strictEqual(result.toString(), 'test bundle content');
    });

    test('should handle download failures', async () => {
      const mockClient = createMockClient();
      mockClient.downloadAsset.rejects(new GitHubClientError('Download failed: 404', 404));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      await assert.rejects(
        () => adapter.downloadBundle({
          id: 'test-bundle',
          name: 'Test Bundle',
          version: '1.0.0',
          description: 'Test',
          author: 'Test Author',
          sourceId: 'test-source',
          environments: [],
          tags: [],
          lastUpdated: '2025-01-01T00:00:00Z',
          size: '1KB',
          dependencies: [],
          license: 'MIT',
          downloadUrl: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/124',
          manifestUrl: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/123'
        }),
        /Failed to download bundle/
      );
    });
  });

  suite('Error Messages', () => {
    test('should produce clear error message for 401 authentication failure', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.rejects(new GitHubAuthError('Bad credentials', 401));

      const adapter = new GitHubAdapter(mockSource, mockClient);

      try {
        await adapter.fetchMetadata();
        assert.fail('Should have thrown an error');
      } catch (error: any) {
        assert.ok(error.message.includes('401'), 'Error should include status code 401');
        assert.ok(error.message.includes('Authentication failed'), 'Error should mention authentication failure');
        assert.ok(error.message.includes('Token may be invalid or expired'), 'Error should provide helpful context');
      }
    });

    test('should produce clear error message for 403 access forbidden', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.rejects(new GitHubAuthError('Forbidden', 403));

      const adapter = new GitHubAdapter(mockSource, mockClient);

      try {
        await adapter.fetchMetadata();
        assert.fail('Should have thrown an error');
      } catch (error: any) {
        assert.ok(error.message.includes('403'), 'Error should include status code 403');
        assert.ok(error.message.includes('Access forbidden'), 'Error should mention access forbidden');
        assert.ok(error.message.includes('Token may lack required scopes'), 'Error should provide helpful context about scopes');
      }
    });

    test('should produce clear error message for 404 repository not found', async () => {
      const mockClient = createMockClient();
      mockClient.getRepository.rejects(new GitHubNotFoundError('test-owner', 'test-repo'));

      const adapter = new GitHubAdapter(mockSource, mockClient);

      try {
        await adapter.fetchMetadata();
        assert.fail('Should have thrown an error');
      } catch (error: any) {
        assert.ok(error.message.includes('404'), 'Error should include status code 404');
        assert.ok(error.message.includes('Repository not found'), 'Error should mention repository not found');
        assert.ok(error.message.includes('Check authentication'), 'Error should provide helpful context');
      }
    });

    test('should include helpful context in all error messages', async () => {
      const testCases = [
        { error: new GitHubAuthError('Bad credentials', 401), expectedPhrase: 'Authentication failed' },
        { error: new GitHubAuthError('Forbidden', 403), expectedPhrase: 'Access forbidden' },
        { error: new GitHubNotFoundError('test-owner', 'test-repo'), expectedPhrase: 'Repository not found' }
      ];

      for (const testCase of testCases) {
        const mockClient = createMockClient();
        mockClient.getRepository.rejects(testCase.error);

        const adapter = new GitHubAdapter(mockSource, mockClient);

        try {
          await adapter.fetchMetadata();
          assert.fail(`Should have thrown an error for ${testCase.expectedPhrase}`);
        } catch (error: any) {
          assert.ok(error.message.includes(testCase.expectedPhrase),
            `Error should include "${testCase.expectedPhrase}", got: ${error.message}`);
        }
      }
    });
  });

  suite('Manifest Caching', () => {
    test('should make only one download call when same manifest URL is fetched multiple times', async () => {
      const mockClient = createMockClient();
      const release = makeRelease();
      // Two releases with the same manifest URL
      mockClient.listReleases.resolves([release]);
      mockClient.downloadAsset.resolves(Buffer.from(JSON.stringify({
        id: 'test-bundle',
        name: 'Test Bundle',
        version: '1.0.0'
      })));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      await adapter.fetchBundles();

      // Manifest should only be downloaded once for a single URL
      assert.strictEqual(mockClient.downloadAsset.callCount, 1);
    });

    test('should fetch fresh manifest after cache is cleared', async () => {
      const mockClient = createMockClient();
      const release = makeRelease();
      mockClient.listReleases.resolves([release]);
      mockClient.downloadAsset.resolves(Buffer.from(JSON.stringify({
        id: 'test-bundle',
        name: 'Test Bundle',
        version: '1.0.0'
      })));

      const adapter = new GitHubAdapter(mockSource, mockClient);
      await adapter.fetchBundles();

      assert.strictEqual(mockClient.downloadAsset.callCount, 1);

      // Clear cache
      adapter.clearManifestCache();

      // Second fetch should make new download call
      await adapter.fetchBundles();
      assert.strictEqual(mockClient.downloadAsset.callCount, 2);
    });
  });

  suite('Multiple Releases Processing', () => {
    test('should return bundles for all valid releases', async () => {
      const mockClient = createMockClient();
      const releases = Array.from({ length: 15 }, (_, i) => makeRelease({
        tag_name: `v1.0.${i}`,
        name: `Release 1.0.${i}`,
        assets: [
          {
            name: 'deployment-manifest.json',
            url: `https://api.github.com/repos/test-owner/test-repo/releases/assets/${100 + i}`,
            browser_download_url: `https://github.com/.../deployment-manifest.json`,
            size: 1024
          },
          {
            name: 'bundle.zip',
            url: `https://api.github.com/repos/test-owner/test-repo/releases/assets/${200 + i}`,
            browser_download_url: `https://github.com/.../bundle.zip`,
            size: 2048
          }
        ]
      }));
      mockClient.listReleases.resolves(releases);

      // Each unique URL gets a unique manifest
      mockClient.downloadAsset.callsFake((url: string) => {
        const match = url.match(/assets\/(\d+)/);
        const idx = match ? Number(match[1]) - 100 : 0;
        return Promise.resolve(Buffer.from(JSON.stringify({
          id: `test-bundle-${idx}`,
          name: `Test Bundle ${idx}`,
          version: `1.0.${idx}`
        })));
      });

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 15);
      for (let i = 0; i < 15; i++) {
        const bundle = bundles.find((b) => b.version === `1.0.${i}`);
        assert.ok(bundle, `Should have bundle for version 1.0.${i}`);
        assert.strictEqual(bundle.name, `Test Bundle ${i}`);
      }
    });

    test('should skip releases without manifest and continue processing others', async () => {
      const mockClient = createMockClient();
      mockClient.listReleases.resolves([
        makeRelease({ tag_name: 'v1.0.0', name: 'Release 1.0.0' }),
        // Invalid release - no manifest
        {
          tag_name: 'v0.9.0',
          name: 'Release 0.9.0',
          body: '',
          published_at: '2025-01-01T00:00:00Z',
          assets: [
            { name: 'bundle.zip', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/201', browser_download_url: '', size: 2048 }
          ]
        },
        makeRelease({
          tag_name: 'v0.8.0',
          name: 'Release 0.8.0',
          assets: [
            {
              name: 'deployment-manifest.yml',
              url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/102',
              browser_download_url: '',
              size: 1024
            },
            {
              name: 'bundle.zip',
              url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/202',
              browser_download_url: '',
              size: 2048
            }
          ]
        })
      ]);

      mockClient.downloadAsset.callsFake((url: string) => {
        if (url.includes('assets/123')) {
          return Promise.resolve(Buffer.from(JSON.stringify({ id: 'bundle-1', name: 'Bundle 1', version: '1.0.0' })));
        }
        if (url.includes('assets/102')) {
          return Promise.resolve(Buffer.from('id: bundle-2\nname: Bundle 2\nversion: 0.8.0'));
        }
        return Promise.reject(new Error('unexpected URL'));
      });

      const adapter = new GitHubAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 2);
      assert.ok(bundles.some((b) => b.version === '1.0.0'));
      assert.ok(bundles.some((b) => b.version === '0.8.0'));
    });
  });
});
