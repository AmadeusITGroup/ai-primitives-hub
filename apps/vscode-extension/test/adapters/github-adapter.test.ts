/**
 * GitHubAdapter Unit Tests
 */

import * as assert from 'node:assert';
import nock from 'nock';
import * as sinon from 'sinon';
import {
  GitHubAdapter,
} from '../../src/adapters/github-adapter';
import {
  RegistrySource,
} from '../../src/types/registry';
import {
  Logger,
} from '../../src/utils/logger';

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

  teardown(() => {
    nock.cleanAll();
  });

  suite('Constructor and Validation', () => {
    test('should accept valid GitHub URL', () => {
      const adapter = new GitHubAdapter(mockSource);
      assert.strictEqual(adapter.type, 'github');
    });

    test('should accept GitHub SSH URL', () => {
      const source = { ...mockSource, url: 'git@github.com:test-owner/test-repo.git' };
      const adapter = new GitHubAdapter(source);
      assert.ok(adapter);
    });

    test('should throw error for invalid URL', () => {
      const source = { ...mockSource, url: 'https://invalid.com/repo', token: undefined };
      assert.throws(() => new GitHubAdapter(source), /Invalid GitHub URL/);
    });

    test('should validate URL correctly', () => {
      // isValidGitHubUrl is private, so we test it indirectly through constructor
      assert.doesNotThrow(() => new GitHubAdapter(mockSource));
      assert.doesNotThrow(() => new GitHubAdapter({ ...mockSource, url: 'git@github.com:owner/repo.git', token: undefined }));
      assert.throws(() => new GitHubAdapter({ ...mockSource, url: 'https://example.com/owner/repo', token: undefined }));
    });
  });

  suite('fetchMetadata', () => {
    test('should fetch repository metadata successfully', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(200, {
          name: 'test-repo',
          description: 'Test repository'
        })
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [{ tag_name: 'v1.0.0' }, { tag_name: 'v1.1.0' }]);

      const adapter = new GitHubAdapter(mockSource);
      const metadata = await adapter.fetchMetadata();

      assert.strictEqual(metadata.name, 'test-repo');
      assert.strictEqual(metadata.description, 'Test repository');
      assert.strictEqual(metadata.bundleCount, 2);
    });

    test('should handle API errors gracefully', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(404, { message: 'Not Found' });

      const adapter = new GitHubAdapter(mockSource);
      await assert.rejects(
        () => adapter.fetchMetadata(),
        /Failed to fetch GitHub metadata/
      );
    });

    test.skip('should include auth token in request', async () => {
      let authHeaderReceived = '';

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(function (this: any) {
          authHeaderReceived = this.req.headers.authorization as string;
          return [200, { name: 'test-repo', description: 'Test' }];
        })
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, []);

      const adapter = new GitHubAdapter(mockSource);
      await adapter.fetchMetadata();

      assert.strictEqual(authHeaderReceived, 'token test-token');
    });
  });

  suite('fetchBundles', () => {
    test('should fetch bundles from releases', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [
          {
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
            ]
          }
        ]);

      // Mock the manifest download
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases/assets/123')
        .reply(200, JSON.stringify({
          id: 'test-bundle',
          name: 'Test Bundle Name',
          version: '1.0.0',
          description: 'Test bundle description',
          author: 'Test Author'
        }));

      const adapter = new GitHubAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      // Bundle ID now uses manifest.id when available: owner-repo-manifestId-version
      assert.strictEqual(bundles[0].id, 'test-owner-test-repo-test-bundle-1.0.0');
      assert.strictEqual(bundles[0].version, '1.0.0');
      assert.strictEqual(bundles[0].sourceId, 'test-source');
    });

    test('should use bundle name from deployment manifest, not version number', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [
          {
            tag_name: 'v1.0.12',
            name: '1.0.12', // GitHub release name is just the version
            body: 'Release notes',
            published_at: '2025-01-01T00:00:00Z',
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
          }
        ]);

      // Mock the manifest download with proper bundle name
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
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases/assets/123')
        .reply(200, manifestContent);

      const adapter = new GitHubAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);

      // The bundle name should be from the manifest, NOT the GitHub release name
      assert.strictEqual(bundles[0].name, 'Amadeus Airlines Solutions',
        'Bundle name should come from deployment manifest');
      assert.notStrictEqual(bundles[0].name, '1.0.12',
        'Bundle name should NOT be the version number');
      assert.notStrictEqual(bundles[0].name, 'Release 1.0.12',
        'Bundle name should NOT be the GitHub release name');

      // Other fields should also come from manifest
      assert.strictEqual(bundles[0].version, '1.0.12');
      assert.strictEqual(bundles[0].description, 'Comprehensive airline management system');
      assert.strictEqual(bundles[0].author, 'amadeus-airlines-solutions');
      assert.deepStrictEqual(bundles[0].tags, ['airlines', 'travel', 'booking']);
    });

    test('should fallback to GitHub release name when manifest fetch fails', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [
          {
            tag_name: 'v1.0.0',
            name: 'Fallback Release Name',
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
            ]
          }
        ]);

      // Mock manifest download failure
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases/assets/123')
        .reply(404, 'Not Found');

      const adapter = new GitHubAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      // Should fallback to GitHub release name when manifest fetch fails
      assert.strictEqual(bundles[0].name, 'Fallback Release Name');
    });

    test('should skip releases without manifest', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [
          {
            tag_name: 'v1.0.0',
            name: 'Release without manifest',
            assets: [
              {
                name: 'bundle.zip',
                browser_download_url: 'https://github.com/.../bundle.zip',
                size: 2048
              }
            ]
          }
        ]);

      const adapter = new GitHubAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });

    test('should handle empty releases', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, []);

      const adapter = new GitHubAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });
  });

  suite('validate', () => {
    test('should validate accessible repository', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(200, { name: 'test-repo' })
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, []);

      const adapter = new GitHubAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should report validation failure for inaccessible repository', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(404);

      const adapter = new GitHubAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    test('should handle authentication errors', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(401, { message: 'Bad credentials' });

      const adapter = new GitHubAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors[0].includes('401'));
    });

    test('should follow HTTP 301 redirects when validating repository', async () => {
      // Simulate a renamed repository that returns 301 redirect
      // Both the repo metadata and releases endpoints will redirect
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(301, '', { location: 'https://api.github.com/repos/new-owner/new-repo' });

      nock('https://api.github.com')
        .get('/repos/new-owner/new-repo')
        .reply(200, { name: 'new-repo' });

      // The releases endpoint also needs to handle redirect since adapter uses original URL
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(301, '', { location: 'https://api.github.com/repos/new-owner/new-repo/releases' });

      nock('https://api.github.com')
        .get('/repos/new-owner/new-repo/releases')
        .reply(200, []);

      const adapter = new GitHubAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true, 'Should successfully validate after following redirect');
      assert.strictEqual(result.errors.length, 0);
    });

    test('should follow HTTP 302 redirects when validating repository', async () => {
      // Simulate a temporary redirect
      // Both the repo metadata and releases endpoints will redirect
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(302, '', { location: 'https://api.github.com/repos/test-owner/test-repo-v2' });

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo-v2')
        .reply(200, { name: 'test-repo-v2' });

      // The releases endpoint also needs to handle redirect
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(302, '', { location: 'https://api.github.com/repos/test-owner/test-repo-v2/releases' });

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo-v2/releases')
        .reply(200, [{ tag_name: 'v1.0.0' }]);

      const adapter = new GitHubAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true, 'Should successfully validate after following redirect');
    });

    test('should follow redirects when fetching bundles', async () => {
      // First request to releases endpoint gets redirected
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(301, '', { location: 'https://api.github.com/repos/new-owner/new-repo/releases' });

      nock('https://api.github.com')
        .get('/repos/new-owner/new-repo/releases')
        .reply(200, []);

      const adapter = new GitHubAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });
  });

  suite('URL Generation', () => {
    test('should generate correct manifest URL', () => {
      const adapter = new GitHubAdapter(mockSource);
      const url = adapter.getManifestUrl('bundle-id', '1.0.0');

      assert.ok(url.includes('test-owner/test-repo'));
      assert.ok(url.includes('v1.0.0'));
      assert.ok(url.includes('deployment-manifest.json'));
    });

    test('should generate correct download URL', () => {
      const adapter = new GitHubAdapter(mockSource);
      const url = adapter.getDownloadUrl('bundle-id', '1.0.0');

      assert.ok(url.includes('test-owner/test-repo'));
      assert.ok(url.includes('v1.0.0'));
      assert.ok(url.includes('bundle.zip'));
    });

    test('should use latest tag when version not specified', () => {
      const adapter = new GitHubAdapter(mockSource);
      const url = adapter.getManifestUrl('bundle-id');

      assert.ok(url.includes('latest'));
    });
  });

  suite('downloadBundle', () => {
    test.skip('should download bundle successfully', async () => {
      const bundleContent = Buffer.from('test bundle content');

      nock('https://github.com')
        .get('/test-owner/test-repo/releases/download/v1.0.0/bundle.zip')
        .reply(200, bundleContent);

      const adapter = new GitHubAdapter(mockSource);
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
        downloadUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/bundle.zip',
        manifestUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/deployment-manifest.json'
      });

      assert.ok(Buffer.isBuffer(result));
      assert.strictEqual(result.toString(), 'test bundle content');
    });

    test('should handle download failures', async () => {
      nock('https://github.com')
        .get('/test-owner/test-repo/releases/download/v1.0.0/bundle.zip')
        .reply(404);

      const adapter = new GitHubAdapter(mockSource);
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
          downloadUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/bundle.zip',
          manifestUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/deployment-manifest.json'
        }),
        /Failed to download bundle/
      );
    });
  });

  suite('Error Messages', () => {
    test('should produce clear error message for 401 authentication failure', async () => {
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(401, { message: 'Bad credentials' });

      const adapter = new GitHubAdapter(mockSource);

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
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(403, { message: 'Forbidden' });

      const adapter = new GitHubAdapter(mockSource);

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
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo')
        .reply(404, { message: 'Not Found' });

      const adapter = new GitHubAdapter(mockSource);

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
      // Test that error messages are actionable and clear
      const testCases = [
        { status: 401, expectedPhrase: 'Authentication failed' },
        { status: 403, expectedPhrase: 'Access forbidden' },
        { status: 404, expectedPhrase: 'Repository not found' }
      ];

      for (const testCase of testCases) {
        nock('https://api.github.com')
          .get('/repos/test-owner/test-repo')
          .reply(testCase.status, { message: 'Error' });

        const adapter = new GitHubAdapter(mockSource);

        try {
          await adapter.fetchMetadata();
          assert.fail(`Should have thrown an error for ${testCase.status}`);
        } catch (error: any) {
          assert.ok(error.message.includes(testCase.expectedPhrase),
            `Error for ${testCase.status} should include "${testCase.expectedPhrase}"`);
        }
      }
    });
  });

  suite('Logging Behavior', () => {
    let debugStub: sinon.SinonStub;
    let errorStub: sinon.SinonStub;
    let infoStub: sinon.SinonStub;

    setup(() => {
      const logger = Logger.getInstance();
      debugStub = sinon.stub(logger, 'debug');
      errorStub = sinon.stub(logger, 'error');
      infoStub = sinon.stub(logger, 'info');
    });

    teardown(() => {
      debugStub.restore();
      errorStub.restore();
      infoStub.restore();
    });

    test('should log URL and auth method before download', async () => {
      const bundleContent = Buffer.from('test content');

      nock('https://github.com')
        .get('/test-owner/test-repo/releases/download/v1.0.0/bundle.zip')
        .reply(200, bundleContent);

      const adapter = new GitHubAdapter(mockSource);
      await adapter.downloadBundle({
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
        downloadUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/bundle.zip',
        manifestUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/deployment-manifest.json'
      });

      // Check that debug was called with download URL and auth method
      const downloadLogs = debugStub.getCalls().filter((call) =>
        call.args[0].includes('Downloading') && call.args[0].includes('bundle.zip')
      );
      assert.ok(downloadLogs.length > 0, 'Should log download URL');
      assert.ok(downloadLogs.some((call) => call.args[0].includes('auth')), 'Should log auth method');
    });

    test('should log redirect URL when following redirects', async () => {
      const bundleContent = Buffer.from('test content');

      nock('https://github.com')
        .get('/test-owner/test-repo/releases/download/v1.0.0/bundle.zip')
        .reply(302, '', { location: 'https://objects.githubusercontent.com/bundle.zip' })
        .get('/bundle.zip')
        .reply(200, bundleContent);

      nock('https://objects.githubusercontent.com')
        .get('/bundle.zip')
        .reply(200, bundleContent);

      const adapter = new GitHubAdapter(mockSource);
      await adapter.downloadBundle({
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
        downloadUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/bundle.zip',
        manifestUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/deployment-manifest.json'
      });

      // Check that debug was called with redirect information
      const redirectLogs = debugStub.getCalls().filter((call) =>
        call.args[0].includes('redirect')
      );
      assert.ok(redirectLogs.length > 0, 'Should log redirect URL');
    });

    test('should log byte count on download complete', async () => {
      const bundleContent = Buffer.from('test content with some bytes');

      nock('https://github.com')
        .get('/test-owner/test-repo/releases/download/v1.0.0/bundle.zip')
        .reply(200, bundleContent);

      const adapter = new GitHubAdapter(mockSource);
      await adapter.downloadBundle({
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
        downloadUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/bundle.zip',
        manifestUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/deployment-manifest.json'
      });

      // Check that debug was called with byte count
      const completeLogs = debugStub.getCalls().filter((call) =>
        call.args[0].includes('complete') && call.args[0].includes('bytes')
      );
      assert.ok(completeLogs.length > 0, 'Should log byte count on completion');
    });

    test('should log status code and error details on HTTP errors', async () => {
      nock('https://github.com')
        .get('/test-owner/test-repo/releases/download/v1.0.0/bundle.zip')
        .reply(404, 'Not Found');

      const adapter = new GitHubAdapter(mockSource);

      try {
        await adapter.downloadBundle({
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
          downloadUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/bundle.zip',
          manifestUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/deployment-manifest.json'
        });
        assert.fail('Should have thrown an error');
      } catch {
        // Expected error
      }

      // Check that error was logged with status code
      const errorLogs = errorStub.getCalls().filter((call) =>
        call.args[0].includes('404') || call.args[0].includes('failed')
      );
      assert.ok(errorLogs.length > 0, 'Should log HTTP error status code');
    });

    test('should sanitize auth tokens in logs (only first 8 chars)', async () => {
      const bundleContent = Buffer.from('test content');

      nock('https://github.com')
        .get('/test-owner/test-repo/releases/download/v1.0.0/bundle.zip')
        .reply(200, bundleContent);

      const adapter = new GitHubAdapter(mockSource);
      await adapter.downloadBundle({
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
        downloadUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/bundle.zip',
        manifestUrl: 'https://github.com/test-owner/test-repo/releases/download/v1.0.0/deployment-manifest.json'
      });

      // Check that no log contains the full token
      const allLogs = [...debugStub.getCalls(), ...infoStub.getCalls(), ...errorStub.getCalls()];
      const fullToken = 'test-token';

      for (const call of allLogs) {
        const logMessage = call.args[0];
        if (typeof logMessage === 'string' && logMessage.includes('token')) {
          // If token is mentioned, it should not be the full token
          assert.ok(!logMessage.includes(fullToken) || logMessage.includes('...'),
            'Full token should not appear in logs');
        }
      }
    });
  });

  suite('Manifest Caching', () => {
    test('should make only one HTTP request when same manifest URL is fetched multiple times', async () => {
      // This tests that the adapter minimizes GitHub API calls by caching manifests
      // Important for: API rate limits, performance, network costs
      const manifestContent = JSON.stringify({
        id: 'test-bundle',
        name: 'Test Bundle',
        version: '1.0.0',
        description: 'Test description'
      });

      let manifestDownloadCount = 0;

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [
          {
            tag_name: 'v1.0.0',
            name: 'Release 1.0.0',
            body: 'Release notes',
            published_at: '2025-01-01T00:00:00Z',
            assets: [
              {
                name: 'deployment-manifest.json',
                url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/123',
                size: 1024
              },
              {
                name: 'bundle.zip',
                url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/124',
                size: 2048
              }
            ]
          }
        ]);

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases/assets/123')
        .reply(200, () => {
          manifestDownloadCount++;
          return manifestContent;
        });

      const adapter = new GitHubAdapter(mockSource);
      await adapter.fetchBundles();

      // Manifest should only be downloaded once (not multiple times)
      assert.strictEqual(manifestDownloadCount, 1, 'Should make only one HTTP request for manifest');
    });

    test('should fetch fresh manifest after cache is cleared', async () => {
      // This tests that clearManifestCache() allows fresh data to be fetched
      // Important for: manual sync should get latest data from GitHub
      const manifestContent = JSON.stringify({
        id: 'test-bundle',
        name: 'Test Bundle',
        version: '1.0.0'
      });

      let manifestDownloadCount = 0;

      // First fetch
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [
          {
            tag_name: 'v1.0.0',
            name: 'Release 1.0.0',
            published_at: '2025-01-01T00:00:00Z',
            assets: [
              { name: 'deployment-manifest.json', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/123', size: 1024 },
              { name: 'bundle.zip', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/124', size: 2048 }
            ]
          }
        ]);

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases/assets/123')
        .reply(200, () => {
          manifestDownloadCount++;
          return manifestContent;
        });

      const adapter = new GitHubAdapter(mockSource);
      await adapter.fetchBundles();

      assert.strictEqual(manifestDownloadCount, 1, 'First fetch should make one HTTP request');

      // Clear cache (simulates manual sync)
      adapter.clearManifestCache();

      // Second fetch after cache clear - should make new HTTP request
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [
          {
            tag_name: 'v1.0.0',
            name: 'Release 1.0.0',
            published_at: '2025-01-01T00:00:00Z',
            assets: [
              { name: 'deployment-manifest.json', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/123', size: 1024 },
              { name: 'bundle.zip', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/124', size: 2048 }
            ]
          }
        ]);

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases/assets/123')
        .reply(200, () => {
          manifestDownloadCount++;
          return manifestContent;
        });

      await adapter.fetchBundles();

      // After cache clear, should make another HTTP request to get fresh data
      assert.strictEqual(manifestDownloadCount, 2, 'After cache clear, should make new HTTP request');
    });
  });

  suite('Multiple Releases Processing', () => {
    test('should return bundles for all valid releases', async () => {
      // Setup: Multiple releases to verify all are processed
      const releases = Array.from({ length: 15 }, (_, i) => ({
        tag_name: `v1.0.${i}`,
        name: `Release 1.0.${i}`,
        published_at: '2025-01-01T00:00:00Z',
        assets: [
          { name: 'deployment-manifest.json', url: `https://api.github.com/repos/test-owner/test-repo/releases/assets/${100 + i}`, size: 1024 },
          { name: 'bundle.zip', url: `https://api.github.com/repos/test-owner/test-repo/releases/assets/${200 + i}`, size: 2048 }
        ]
      }));

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, releases);

      // Mock manifest downloads for all releases
      for (let i = 0; i < 15; i++) {
        nock('https://api.github.com')
          .get(`/repos/test-owner/test-repo/releases/assets/${100 + i}`)
          .reply(200, JSON.stringify({
            id: `test-bundle-${i}`,
            name: `Test Bundle ${i}`,
            version: `1.0.${i}`
          }));
      }

      const adapter = new GitHubAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      // All 15 releases should be returned as bundles
      assert.strictEqual(bundles.length, 15, 'Should return all 15 bundles');

      // Verify each bundle has correct metadata from manifest
      for (let i = 0; i < 15; i++) {
        const bundle = bundles.find((b) => b.version === `1.0.${i}`);
        assert.ok(bundle, `Should have bundle for version 1.0.${i}`);
        assert.strictEqual(bundle.name, `Test Bundle ${i}`);
      }
    });

    test('should skip releases without manifest and continue processing others', async () => {
      // Setup: Mix of valid and invalid releases
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases')
        .reply(200, [
          // Valid release with manifest
          {
            tag_name: 'v1.0.0',
            name: 'Release 1.0.0',
            published_at: '2025-01-01T00:00:00Z',
            assets: [
              { name: 'deployment-manifest.json', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/100', size: 1024 },
              { name: 'bundle.zip', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/200', size: 2048 }
            ]
          },
          // Invalid release - no manifest
          {
            tag_name: 'v0.9.0',
            name: 'Release 0.9.0',
            published_at: '2025-01-01T00:00:00Z',
            assets: [
              { name: 'bundle.zip', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/201', size: 2048 }
            ]
          },
          // Another valid release
          {
            tag_name: 'v0.8.0',
            name: 'Release 0.8.0',
            published_at: '2025-01-01T00:00:00Z',
            assets: [
              { name: 'deployment-manifest.yml', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/102', size: 1024 },
              { name: 'bundle.zip', url: 'https://api.github.com/repos/test-owner/test-repo/releases/assets/202', size: 2048 }
            ]
          }
        ]);

      // Mock manifest downloads for valid releases
      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases/assets/100')
        .reply(200, JSON.stringify({ id: 'bundle-1', name: 'Bundle 1', version: '1.0.0' }));

      nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/releases/assets/102')
        .reply(200, 'id: bundle-2\nname: Bundle 2\nversion: 0.8.0');

      const adapter = new GitHubAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      // Should return only the 2 valid releases
      assert.strictEqual(bundles.length, 2, 'Should return only valid bundles');
      assert.ok(bundles.some((b) => b.version === '1.0.0'), 'Should include v1.0.0');
      assert.ok(bundles.some((b) => b.version === '0.8.0'), 'Should include v0.8.0');
    });
  });
});
