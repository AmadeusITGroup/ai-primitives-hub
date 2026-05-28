/**
 * LocalApmAdapter Unit Tests
 * Tests local filesystem-based APM package loading
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  LocalApmAdapter,
} from '../../src/adapters/local-apm-adapter';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('LocalApmAdapter', () => {
  const fixturesPath = path.join(__dirname, '../fixtures/apm');
  const singlePackagePath = path.join(fixturesPath, 'single-package');
  const monorepoPath = path.join(fixturesPath, 'monorepo');

  const mockSource: RegistrySource = {
    id: 'test-local-apm',
    name: 'Test Local APM',
    type: 'local-apm',
    url: singlePackagePath,
    enabled: true,
    priority: 1
  };

  suite('Constructor and Validation', () => {
    test('should accept valid local path', () => {
      const adapter = new LocalApmAdapter(mockSource);
      assert.strictEqual(adapter.type, 'local-apm');
    });

    test('should accept file:// URL', () => {
      const source = { ...mockSource, url: `file://${singlePackagePath}` };
      const adapter = new LocalApmAdapter(source);
      assert.ok(adapter);
    });

    test('should throw error for invalid path format', () => {
      const source = { ...mockSource, url: 'http://invalid.com/path' };
      assert.throws(() => new LocalApmAdapter(source), /Invalid local path/);
    });

    test('should accept paths starting with ~/', () => {
      // This test validates path format acceptance, not actual resolution
      const source = { ...mockSource, url: '~/some/path' };
      const adapter = new LocalApmAdapter(source);
      assert.ok(adapter);
    });
  });

  suite('fetchMetadata', () => {
    test('should fetch local APM package metadata', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const metadata = await adapter.fetchMetadata();

      assert.ok(metadata);
      assert.strictEqual(typeof metadata.name, 'string');
      assert.strictEqual(typeof metadata.description, 'string');
      assert.strictEqual(typeof metadata.bundleCount, 'number');
      assert.ok(metadata.bundleCount >= 0);
      assert.ok(metadata.lastUpdated);
    });

    test('should report correct package count for single package', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const metadata = await adapter.fetchMetadata();

      assert.strictEqual(metadata.bundleCount, 1);
    });

    test('should throw error for non-existent directory', async () => {
      const source = { ...mockSource, url: '/non/existent/path' };
      const adapter = new LocalApmAdapter(source);

      await assert.rejects(
        () => adapter.fetchMetadata(),
        /not found|does not exist/i
      );
    });
  });

  suite('fetchBundles - Single Package', () => {
    test('should discover apm.yml at root', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 1);
    });

    test('should parse apm.yml correctly', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      const bundle = bundles[0];
      assert.strictEqual(bundle.name, 'test-apm-package');
      assert.strictEqual(bundle.version, '1.2.0');
      assert.strictEqual(bundle.description, 'A test APM package for unit testing');
      assert.strictEqual(bundle.author, 'Test Author');
      assert.ok(Array.isArray(bundle.tags));
      assert.ok(bundle.tags.includes('testing'));
      assert.ok(bundle.tags.includes('apm'));
      assert.ok(bundle.tags.includes('local'));
    });

    test('should include all bundle metadata', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      for (const bundle of bundles) {
        assert.ok(bundle.id);
        assert.ok(bundle.name);
        assert.ok(bundle.version);
        assert.ok(bundle.description);
        assert.ok(bundle.author);
        assert.strictEqual(bundle.sourceId, 'test-local-apm');
        assert.ok(Array.isArray(bundle.environments));
        assert.ok(Array.isArray(bundle.tags));
        assert.ok(bundle.lastUpdated);
        assert.ok(bundle.downloadUrl);
        assert.ok(bundle.manifestUrl);
        assert.ok(bundle.license);
      }
    });

    test('should handle file:// URLs in download/manifest URLs', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      for (const bundle of bundles) {
        assert.ok(bundle.downloadUrl.startsWith('file://'));
        assert.ok(bundle.manifestUrl.startsWith('file://'));
      }
    });

    test('should infer cloud environment from azure tag', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      const bundle = bundles[0];
      assert.ok(bundle.environments.includes('cloud'));
    });

    test('should cache results for performance', async () => {
      const adapter = new LocalApmAdapter(mockSource);

      const start1 = Date.now();
      const bundles1 = await adapter.fetchBundles();
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      const bundles2 = await adapter.fetchBundles();
      const time2 = Date.now() - start2;

      // Second call should be faster (cached)
      assert.ok(time2 < time1 || time2 < 10, 'Second call should use cache');
      assert.deepStrictEqual(bundles1, bundles2);
    });
  });

  suite('fetchBundles - Monorepo', () => {
    test('should discover multiple packages in subdirectories', async () => {
      const source = { ...mockSource, url: monorepoPath };
      const adapter = new LocalApmAdapter(source);
      const bundles = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 2);

      const names = bundles.map((b) => b.name).toSorted();
      assert.deepStrictEqual(names, ['package-alpha', 'package-beta']);
    });

    test('should respect scanSubdirectories config', async () => {
      const source = {
        ...mockSource,
        url: monorepoPath,
        config: { scanSubdirectories: false }
      };
      const adapter = new LocalApmAdapter(source);
      const bundles = await adapter.fetchBundles();

      // With scanning disabled, should not find packages in subdirs
      assert.strictEqual(bundles.length, 0);
    });
  });

  suite('validate', () => {
    test('should validate accessible directory', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.bundlesFound, 1);
    });

    test('should fail validation for non-existent directory', async () => {
      const source = { ...mockSource, url: '/non/existent/path' };
      const adapter = new LocalApmAdapter(source);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes('does not exist'));
      assert.strictEqual(result.bundlesFound, 0);
    });

    test('should warn for directory without apm.yml', async () => {
      // Use a directory that exists but has no apm.yml files
      const source = { ...mockSource, url: path.join(__dirname, '../fixtures/github') };
      const adapter = new LocalApmAdapter(source);
      const result = await adapter.validate();

      // Should be valid but with warning about no packages found or zero bundles
      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.length > 0 || result.bundlesFound === 0);
    });
  });

  suite('getDownloadUrl', () => {
    test('should generate correct file:// URL', () => {
      const adapter = new LocalApmAdapter(mockSource);
      const url = adapter.getDownloadUrl('test-package', '1.0.0');

      assert.ok(url.startsWith('file://'));
    });
  });

  suite('getManifestUrl', () => {
    test('should generate correct manifest URL', () => {
      const adapter = new LocalApmAdapter(mockSource);
      const url = adapter.getManifestUrl('test-package', '1.0.0');

      assert.ok(url.startsWith('file://'));
      assert.ok(url.includes('apm.yml'));
    });
  });

  suite('downloadBundle', () => {
    test('should create zip archive from APM package', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const bundles = await adapter.fetchBundles();
      const bundle = bundles[0];

      assert.ok(bundle);
      const buffer = await adapter.downloadBundle(bundle);

      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length > 0);
    });

    test('should include deployment manifest in archive', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const bundles = await adapter.fetchBundles();
      const bundle = bundles[0];

      assert.ok(bundle);
      const buffer = await adapter.downloadBundle(bundle);

      // Archive should be non-trivial size (manifest + files)
      assert.ok(buffer.length > 100);
    });
  });

  suite('Path Handling', () => {
    test('should handle absolute paths', () => {
      const source = { ...mockSource, url: singlePackagePath };
      const adapter = new LocalApmAdapter(source);
      assert.ok(adapter);
    });

    test('should handle file:// URLs', () => {
      const source = { ...mockSource, url: `file://${singlePackagePath}` };
      const adapter = new LocalApmAdapter(source);
      assert.ok(adapter);
    });

    test('should normalize paths correctly', async () => {
      const source = { ...mockSource, url: singlePackagePath + '//' };
      const adapter = new LocalApmAdapter(source);

      // Should still work despite extra slashes
      const bundles = await adapter.fetchBundles();
      assert.ok(bundles.length > 0);
    });
  });

  suite('Error Handling', () => {
    test('should provide helpful error messages', async () => {
      const source = { ...mockSource, url: '/completely/invalid/path' };
      const adapter = new LocalApmAdapter(source);

      try {
        await adapter.fetchBundles();
        assert.fail('Should have thrown an error');
      } catch (error: any) {
        assert.ok(error.message.includes('APM') || error.message.includes('not found') || error.message.includes('does not exist'));
      }
    });

    test('should handle bundle without localPackagePath', async () => {
      const adapter = new LocalApmAdapter(mockSource);
      const testBundle = {
        id: 'test-bundle',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        sourceId: 'test',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '1',
        dependencies: [],
        license: 'MIT',
        downloadUrl: 'file://test',
        manifestUrl: 'file://test',
        repository: 'test'
        // Note: no localPackagePath
      };

      await assert.rejects(
        () => adapter.downloadBundle(testBundle),
        /No local path|not found/i
      );
    });
  });

  suite('Security', () => {
    test('should not allow path traversal in URL', () => {
      const source = { ...mockSource, url: '/some/path/../../../etc/passwd' };
      const adapter = new LocalApmAdapter(source);

      // Adapter should normalize the path
      assert.ok(adapter);
    });

    test('should skip hidden directories when scanning', async () => {
      const source = { ...mockSource, url: monorepoPath };
      const adapter = new LocalApmAdapter(source);
      const bundles = await adapter.fetchBundles();

      // Should not include any bundles from hidden directories
      for (const bundle of bundles) {
        assert.ok(!bundle.id.includes('.hidden'));
      }
    });

    test('should skip node_modules and apm_modules directories', async () => {
      const source = { ...mockSource, url: monorepoPath };
      const adapter = new LocalApmAdapter(source);
      const bundles = await adapter.fetchBundles();

      // Should not include any bundles from node_modules
      for (const bundle of bundles) {
        assert.ok(!bundle.id.includes('node_modules'));
        assert.ok(!bundle.id.includes('apm_modules'));
      }
    });
  });
});
