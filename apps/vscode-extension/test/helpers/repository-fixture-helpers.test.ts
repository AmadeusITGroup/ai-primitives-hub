/**
 * Tests for Repository Fixture Helpers
 *
 * Validates that the repository fixture helpers properly:
 * - Create valid deployment manifests
 * - Create valid bundle ZIP files
 * - Configure nock mocks for GitHub releases API
 *
 * Requirements covered:
 * - 1.1: setupReleaseMocks() for GitHub releases API
 * - 1.2: createBundleZip() for valid bundle ZIP files
 * - 1.3: createDeploymentManifest() for deployment manifests
 * - 1.5: createBundleZip() returns valid ZIP with manifest and prompts
 * - 1.6: RepositoryTestConfig interface for test configuration
 */

import * as assert from 'node:assert';
import AdmZip from 'adm-zip';
import nock from 'nock';
import {
  cleanupReleaseMocks,
  computeBundleId,
  createBundleZip,
  createDeploymentManifest,
  createMockGitHubSource,
  createTestConfig,
  ReleaseConfig,
  RepositoryTestConfig,
  setupReleaseMocks,
  setupSourceWithCustomConfig,
  SourceSetupDependencies,
} from './repository-fixture-helpers';

suite('Repository Fixture Helpers', () => {
  teardown(() => {
    cleanupReleaseMocks();
  });

  suite('createDeploymentManifest', () => {
    test('should create manifest with all required fields (Requirement 1.3)', () => {
      const config: RepositoryTestConfig = {
        owner: 'test-owner',
        repo: 'test-repo',
        manifestId: 'test-bundle'
      };

      const manifest = createDeploymentManifest(config, '1.0.0', 'initial');

      // Verify all required fields are present and non-empty
      assert.strictEqual(manifest.id, 'test-bundle');
      assert.ok(manifest.name.length > 0, 'name should be non-empty');
      assert.strictEqual(manifest.version, '1.0.0');
      assert.ok(manifest.description.length > 0, 'description should be non-empty');
      assert.strictEqual(manifest.author, 'test-owner');
      assert.ok(Array.isArray(manifest.tags) && manifest.tags.length > 0, 'tags should be non-empty array');
      assert.ok(Array.isArray(manifest.environments) && manifest.environments.length > 0, 'environments should be non-empty array');
      assert.ok(Array.isArray(manifest.dependencies), 'dependencies should be array');
      assert.ok(manifest.license.length > 0, 'license should be non-empty');
    });

    test('should include content identifier in name and description', () => {
      const config = createTestConfig();
      const manifest = createDeploymentManifest(config, '2.0.0', 'custom-content');

      assert.ok(manifest.name.includes('custom-content'), 'name should include content identifier');
      assert.ok(manifest.description.includes('custom-content'), 'description should include content identifier');
    });

    test('should use default content when not specified', () => {
      const config = createTestConfig();
      const manifest = createDeploymentManifest(config, '1.0.0');

      assert.ok(manifest.name.includes('initial'), 'name should include default content');
    });
  });

  suite('createBundleZip', () => {
    test('should create valid ZIP buffer (Requirement 1.2)', () => {
      const config = createTestConfig();
      const zipBuffer = createBundleZip(config, '1.0.0', 'test');

      assert.ok(Buffer.isBuffer(zipBuffer), 'should return a Buffer');
      assert.ok(zipBuffer.length > 0, 'buffer should not be empty');
    });

    test('should contain deployment-manifest.yml (Requirement 1.5)', () => {
      const config = createTestConfig();
      const zipBuffer = createBundleZip(config, '1.0.0', 'test');

      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      const manifestEntry = entries.find((e) => e.entryName === 'deployment-manifest.yml');

      assert.ok(manifestEntry, 'ZIP should contain deployment-manifest.yml');

      const manifestContent = manifestEntry.getData().toString('utf8');
      assert.ok(manifestContent.includes('id: test-bundle'), 'manifest should contain id');
      assert.ok(manifestContent.includes('version: 1.0.0'), 'manifest should contain version');
    });

    test('should contain prompts/test.prompt.md (Requirement 1.5)', () => {
      const config = createTestConfig();
      const zipBuffer = createBundleZip(config, '1.0.0', 'test');

      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      const promptEntry = entries.find((e) => e.entryName === 'prompts/test.prompt.md');

      assert.ok(promptEntry, 'ZIP should contain prompts/test.prompt.md');

      const promptContent = promptEntry.getData().toString('utf8');
      assert.ok(promptContent.includes('# Test Prompt'), 'prompt should have header');
      assert.ok(promptContent.includes('Content: test'), 'prompt should include content identifier');
    });

    test('should create ZIP that can be extracted and re-read (round-trip)', () => {
      const config: RepositoryTestConfig = {
        owner: 'round-trip-owner',
        repo: 'round-trip-repo',
        manifestId: 'round-trip-bundle'
      };
      const version = '2.5.0';
      const content = 'round-trip-test';

      // Create ZIP
      const zipBuffer = createBundleZip(config, version, content);

      // Extract and verify
      const zip = new AdmZip(zipBuffer);
      const manifestEntry = zip.getEntry('deployment-manifest.yml');
      assert.ok(manifestEntry, 'should find manifest');

      const manifestContent = manifestEntry.getData().toString('utf8');
      assert.ok(manifestContent.includes(`id: ${config.manifestId}`), 'manifest id should match');
      assert.ok(manifestContent.includes(`version: ${version}`), 'manifest version should match');
      assert.ok(manifestContent.includes(`author: ${config.owner}`), 'manifest author should match');
    });
  });

  suite('setupReleaseMocks', () => {
    test('should configure releases endpoint (Requirement 1.1)', async () => {
      const config = createTestConfig();
      const releases: ReleaseConfig[] = [
        { tag: 'v1.0.0', version: '1.0.0', content: 'initial' }
      ];

      setupReleaseMocks(config, releases);

      // Verify releases endpoint is mocked
      const axios = require('axios');
      const response = await axios.get(
        `https://api.github.com/repos/${config.owner}/${config.repo}/releases`
      );

      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(response.data));
      assert.strictEqual(response.data.length, 1);
      assert.strictEqual(response.data[0].tag_name, 'v1.0.0');
    });

    test('should configure repository metadata endpoint (Requirement 1.4)', async () => {
      const config = createTestConfig();
      setupReleaseMocks(config, [{ tag: 'v1.0.0', version: '1.0.0', content: 'test' }]);

      const axios = require('axios');
      const response = await axios.get(
        `https://api.github.com/repos/${config.owner}/${config.repo}`
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.data.name, config.repo);
    });

    test('should configure manifest asset endpoint (Requirement 1.4)', async () => {
      const config = createTestConfig();
      setupReleaseMocks(config, [{ tag: 'v1.0.0', version: '1.0.0', content: 'test' }]);

      const axios = require('axios');
      const response = await axios.get(
        `https://api.github.com/repos/${config.owner}/${config.repo}/releases/assets/1000`
      );

      assert.strictEqual(response.status, 200);
      // axios auto-parses JSON, so response.data is already an object
      const manifest = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      assert.strictEqual(manifest.id, config.manifestId);
      assert.strictEqual(manifest.version, '1.0.0');
    });

    test('should configure bundle download with redirect (Requirement 1.4)', async () => {
      const config = createTestConfig();
      setupReleaseMocks(config, [{ tag: 'v1.0.0', version: '1.0.0', content: 'test' }]);

      const axios = require('axios');

      // First request gets redirect
      const redirectResponse = await axios.get(
        `https://api.github.com/repos/${config.owner}/${config.repo}/releases/assets/2000`,
        { maxRedirects: 0, validateStatus: (status: number) => status === 302 }
      );

      assert.strictEqual(redirectResponse.status, 302);
      assert.ok(redirectResponse.headers.location.includes('objects.githubusercontent.com'));

      // Follow redirect to get actual bundle
      const bundleResponse = await axios.get(redirectResponse.headers.location, {
        responseType: 'arraybuffer'
      });

      assert.strictEqual(bundleResponse.status, 200);
      assert.ok(bundleResponse.data.length > 0, 'bundle should have content');
    });

    test('should support multiple releases', async () => {
      const config = createTestConfig();
      const releases: ReleaseConfig[] = [
        { tag: 'v2.0.0', version: '2.0.0', content: 'latest' },
        { tag: 'v1.0.0', version: '1.0.0', content: 'initial' }
      ];

      setupReleaseMocks(config, releases);

      const axios = require('axios');
      const response = await axios.get(
        `https://api.github.com/repos/${config.owner}/${config.repo}/releases`
      );

      assert.strictEqual(response.data.length, 2);
      assert.strictEqual(response.data[0].tag_name, 'v2.0.0');
      assert.strictEqual(response.data[1].tag_name, 'v1.0.0');
    });
  });

  suite('createMockGitHubSource', () => {
    test('should create valid RegistrySource (Requirement 1.6)', () => {
      const config = createTestConfig();
      const source = createMockGitHubSource('test-source', config);

      assert.strictEqual(source.id, 'test-source');
      assert.strictEqual(source.type, 'github');
      assert.strictEqual(source.url, `https://github.com/${config.owner}/${config.repo}`);
      assert.strictEqual(source.enabled, true);
      assert.ok(source.priority >= 0);
    });
  });

  suite('cleanupReleaseMocks', () => {
    test('should clear all nock mocks', () => {
      const config = createTestConfig();
      setupReleaseMocks(config, [{ tag: 'v1.0.0', version: '1.0.0', content: 'test' }]);

      // Verify mocks are active
      assert.ok(nock.pendingMocks().length > 0, 'should have pending mocks');

      cleanupReleaseMocks();

      // Verify mocks are cleared
      assert.strictEqual(nock.pendingMocks().length, 0, 'should have no pending mocks');
    });
  });

  suite('computeBundleId', () => {
    test('should compute correct bundle ID format', () => {
      const config: RepositoryTestConfig = {
        owner: 'my-owner',
        repo: 'my-repo',
        manifestId: 'my-bundle'
      };

      const bundleId = computeBundleId(config, '1.2.3');

      assert.strictEqual(bundleId, 'my-owner-my-repo-my-bundle-1.2.3');
    });
  });

  suite('createTestConfig', () => {
    test('should create config with defaults', () => {
      const config = createTestConfig();

      assert.strictEqual(config.owner, 'test-owner');
      assert.strictEqual(config.repo, 'test-repo');
      assert.strictEqual(config.manifestId, 'test-bundle');
      assert.strictEqual(config.baseVersion, '1.0.0');
    });

    test('should allow overrides', () => {
      const config = createTestConfig({
        owner: 'custom-owner',
        manifestId: 'custom-bundle'
      });

      assert.strictEqual(config.owner, 'custom-owner');
      assert.strictEqual(config.repo, 'test-repo'); // default
      assert.strictEqual(config.manifestId, 'custom-bundle');
    });
  });

  suite('MochaTestContext', () => {
    test('should be compatible with Mocha test context', function () {
      // This test verifies that MochaTestContext is properly typed
      // by using it with actual Mocha context methods

      // Verify skip() method exists (don't actually call it)
      assert.strictEqual(typeof this.skip, 'function', 'skip should be a function');

      // Verify timeout() method exists
      assert.strictEqual(typeof this.timeout, 'function', 'timeout should be a function');

      // Verify retries() method exists
      assert.strictEqual(typeof this.retries, 'function', 'retries should be a function');
    });
  });

  suite('setupSourceWithCustomConfig', () => {
    test('should set up mocks and return bundle when found', async () => {
      const config = createTestConfig({ manifestId: 'custom-bundle' });
      const expectedBundleId = computeBundleId(config, '1.0.0');

      // Create mock dependencies
      let addedSource: any = null;
      let syncedSourceId: string | null = null;

      const mockDeps: SourceSetupDependencies = {
        registryManager: {
          addSource: (source) => {
            addedSource = source;
            return Promise.resolve();
          },
          syncSource: (sourceId) => {
            syncedSourceId = sourceId;
            return Promise.resolve();
          }
        },
        storage: {
          getCachedSourceBundles: (_sourceId) => Promise.resolve([
            { id: expectedBundleId, name: 'Test Bundle' }
          ])
        }
      };

      const result = await setupSourceWithCustomConfig(
        mockDeps,
        'test-id',
        'suffix',
        config,
        'test-content'
      );

      // Verify source was added
      assert.ok(addedSource, 'Source should be added');
      assert.strictEqual(addedSource.id, 'test-id-suffix');
      assert.strictEqual(addedSource.type, 'github');

      // Verify source was synced
      assert.strictEqual(syncedSourceId, 'test-id-suffix');

      // Verify result
      assert.strictEqual(result.sourceId, 'test-id-suffix');
      assert.strictEqual(result.bundle.id, expectedBundleId);
    });

    test('should throw error when bundle not found', async () => {
      const config = createTestConfig({ manifestId: 'missing-bundle' });

      const mockDeps: SourceSetupDependencies = {
        registryManager: {
          addSource: async () => {},
          syncSource: async () => {}
        },
        storage: {
          getCachedSourceBundles: () => Promise.resolve([
            { id: 'other-bundle-1.0.0', name: 'Other Bundle' }
          ])
        }
      };

      await assert.rejects(
        () => setupSourceWithCustomConfig(mockDeps, 'test-id', 'suffix', config, 'content'),
        /Should find bundle containing 'missing-bundle'/,
        'Should throw descriptive error when bundle not found'
      );
    });

    test('should configure nock mocks for GitHub API', async () => {
      const config = createTestConfig();
      const expectedBundleId = computeBundleId(config, '1.0.0');

      const mockDeps: SourceSetupDependencies = {
        registryManager: {
          addSource: async () => {},
          syncSource: async () => {}
        },
        storage: {
          getCachedSourceBundles: () => Promise.resolve([{ id: expectedBundleId }])
        }
      };

      await setupSourceWithCustomConfig(mockDeps, 'test-id', 'suffix', config, 'content');

      // Verify nock mocks were configured by making a request
      const axios = require('axios');
      const response = await axios.get(
        `https://api.github.com/repos/${config.owner}/${config.repo}/releases`
      );

      assert.strictEqual(response.status, 200);
      assert.ok(Array.isArray(response.data));
    });
  });
});
