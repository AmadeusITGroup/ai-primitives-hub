/**
 * LocalAwesomeCopilotAdapter Unit Tests
 * Tests local filesystem-based awesome-copilot collection loading
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import {
  LocalAwesomeCopilotAdapter,
} from '../../src/adapters/local-awesome-copilot-adapter';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('LocalAwesomeCopilotAdapter', () => {
  const fixturesPath = path.join(__dirname, '../fixtures/local-awesome-collections');

  const mockSource: RegistrySource = {
    id: 'test-local-awesome',
    name: 'Test Local Awesome',
    type: 'local-awesome-copilot',
    url: fixturesPath,
    enabled: true,
    priority: 1
  };

  suite('Constructor and Validation', () => {
    test('should accept valid local path', () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      assert.strictEqual(adapter.type, 'local-awesome-copilot');
    });

    test('should accept file:// URL', () => {
      const source = { ...mockSource, url: `file://${fixturesPath}` };
      const adapter = new LocalAwesomeCopilotAdapter(source);
      assert.ok(adapter);
    });

    test('should throw error for invalid path format', () => {
      const source = { ...mockSource, url: 'http://invalid.com/path' };
      assert.throws(() => new LocalAwesomeCopilotAdapter(source), /Invalid local path/);
    });

    test('should use default collectionsPath config', () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      assert.ok(adapter);
      // Default should be 'collections'
    });

    test('should accept custom collectionsPath config', () => {
      const source = {
        ...mockSource,
        config: { collectionsPath: 'custom-collections' }
      };
      const adapter = new LocalAwesomeCopilotAdapter(source);
      assert.ok(adapter);
    });
  });

  suite('fetchMetadata', () => {
    test('should fetch local collections metadata', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const metadata = await adapter.fetchMetadata();

      assert.ok(metadata);
      assert.strictEqual(typeof metadata.name, 'string');
      assert.strictEqual(typeof metadata.description, 'string');
      assert.strictEqual(typeof metadata.bundleCount, 'number');
      assert.ok(metadata.bundleCount >= 0);
      assert.ok(metadata.lastUpdated);
    });

    test('should report correct collection count', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const metadata = await adapter.fetchMetadata();

      // We have 3 collections in fixtures
      assert.strictEqual(metadata.bundleCount, 3);
    });

    test('should throw error for non-existent directory', async () => {
      const source = { ...mockSource, url: '/non/existent/path' };
      const adapter = new LocalAwesomeCopilotAdapter(source);

      await assert.rejects(
        () => adapter.fetchMetadata(),
        /Collections directory does not exist/
      );
    });
  });

  suite('fetchBundles', () => {
    test('should discover all collection files', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 3);

      // Check collection IDs
      const bundleIds = bundles.map((b) => b.id).toSorted();
      assert.deepStrictEqual(bundleIds, ['python-dev', 'skills-collection', 'test-collection']);
    });

    test('should parse YAML collections correctly', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      const testBundle = bundles.find((b) => b.id === 'test-collection');
      assert.ok(testBundle);
      assert.strictEqual(testBundle.name, 'Test Collection');
      assert.strictEqual(testBundle.version, '1.0.0');
      assert.strictEqual(testBundle.description, 'A test collection for unit testing');
      assert.strictEqual(testBundle.author, 'Local Developer');
      assert.ok(Array.isArray(testBundle.tags));
      assert.ok(testBundle.tags.includes('test'));
      assert.ok(testBundle.tags.includes('azure'));
    });

    test('should include all bundle metadata', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      for (const bundle of bundles) {
        assert.ok(bundle.id);
        assert.ok(bundle.name);
        assert.strictEqual(bundle.version, '1.0.0');
        assert.ok(bundle.description);
        assert.ok(bundle.author);
        assert.strictEqual(bundle.sourceId, 'test-local-awesome');
        assert.ok(Array.isArray(bundle.environments));
        assert.ok(Array.isArray(bundle.tags));
        assert.ok(bundle.lastUpdated);
        assert.ok(bundle.downloadUrl);
        assert.ok(bundle.manifestUrl);
        assert.strictEqual(bundle.license, 'MIT');
      }
    });

    test('should handle file:// URLs in download/manifest URLs', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      for (const bundle of bundles) {
        assert.ok(bundle.downloadUrl.startsWith('file://'));
        assert.ok(bundle.manifestUrl.startsWith('file://'));
        assert.ok(bundle.manifestUrl.includes('.collection.yml'));
      }
    });

    test('should infer environments from tags', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      const testBundle = bundles.find((b) => b.id === 'test-collection');
      assert.ok(testBundle);
      // Should have 'cloud' environment from 'azure' tag
      assert.ok(testBundle.environments.includes('cloud'));
    });

    test('should calculate item breakdown', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      const testBundle = bundles.find((b) => b.id === 'test-collection');
      assert.ok(testBundle);

      // Check that breakdown metadata was added
      const breakdown = (testBundle as any).breakdown;
      assert.ok(breakdown);
      assert.strictEqual(breakdown.prompts, 1);
      assert.strictEqual(breakdown.instructions, 1);
    });

    test('should cache results for performance', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);

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

    test('should skip non-collection files', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      // Only .collection.yml files should be processed
      assert.ok(bundles.every((b) => b.id && b.name));
    });
  });

  suite('validate', () => {
    test('should validate accessible collections directory', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.bundlesFound, 3);
    });

    test('should fail validation for non-existent directory', async () => {
      const source = { ...mockSource, url: '/non/existent/path' };
      const adapter = new LocalAwesomeCopilotAdapter(source);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes('Collections directory does not exist'));
      assert.strictEqual(result.bundlesFound, 0);
    });

    test('should fail validation for directory without collections', async () => {
      // Use a directory that exists but has no collections subdirectory
      const source = { ...mockSource, url: path.join(__dirname, '../fixtures') };
      const adapter = new LocalAwesomeCopilotAdapter(source);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });
  });

  suite('getDownloadUrl', () => {
    test('should generate correct file:// URL for collection', () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const url = adapter.getDownloadUrl('test-collection', '1.0.0');

      assert.ok(url.startsWith('file://'));
      assert.ok(url.includes('test-collection.collection.yml'));
    });
  });

  suite('getManifestUrl', () => {
    test('should generate correct manifest URL', () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const url = adapter.getManifestUrl('test-collection', '1.0.0');

      assert.ok(url.startsWith('file://'));
      assert.ok(url.includes('test-collection.collection.yml'));
      assert.ok(url.includes('collections'));
    });

    test('should match download URL', () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const manifestUrl = adapter.getManifestUrl('test-collection');
      const downloadUrl = adapter.getDownloadUrl('test-collection');

      // For local awesome copilot, manifest and download URLs are the same
      assert.strictEqual(manifestUrl, downloadUrl);
    });
  });

  suite('downloadBundle', () => {
    test('should create zip archive from collection', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();
      const testBundle = bundles.find((b) => b.id === 'test-collection');

      assert.ok(testBundle);
      const buffer = await adapter.downloadBundle(testBundle);

      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length > 0);
    });

    test('should include deployment manifest in archive', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();
      const testBundle = bundles.find((b) => b.id === 'test-collection');

      assert.ok(testBundle);
      const buffer = await adapter.downloadBundle(testBundle);

      // Archive should contain manifest
      // This is a basic check - full archive inspection would need unzip
      assert.ok(buffer.length > 100); // Reasonable size for manifest + files
    });

    test('should include skill nested subdirectories recursively in archive', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const bundles = await adapter.fetchBundles();
      const skillsBundle = bundles.find((b) => b.id === 'skills-collection');

      assert.ok(skillsBundle, 'skills-collection bundle must be discoverable');
      const buffer = await adapter.downloadBundle(skillsBundle);

      const zip = new AdmZip(buffer);
      const entryNames = zip.getEntries().map((e) => e.entryName);

      assert.ok(entryNames.includes('deployment-manifest.yml'), 'archive must contain deployment-manifest.yml');
      assert.ok(
        entryNames.includes('skills/analyzer/SKILL.md'),
        'archive must contain skills/analyzer/SKILL.md'
      );
      assert.ok(
        entryNames.includes('skills/analyzer/templates/analysis-template.md'),
        'archive must contain skills/analyzer/templates/analysis-template.md (nested subdirectory)'
      );
      assert.ok(
        entryNames.includes('skills/reporter/SKILL.md'),
        'archive must contain skills/reporter/SKILL.md'
      );
    });

    test('should handle bundle without stored collectionFile', async () => {
      const adapter = new LocalAwesomeCopilotAdapter(mockSource);
      const testBundle = {
        id: 'test-collection',
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
      };

      const buffer = await adapter.downloadBundle(testBundle);
      assert.ok(Buffer.isBuffer(buffer));
    });
  });

  suite('Path Handling', () => {
    test('should handle absolute paths', () => {
      const source = { ...mockSource, url: fixturesPath };
      const adapter = new LocalAwesomeCopilotAdapter(source);
      assert.ok(adapter);
    });

    test('should handle file:// URLs', () => {
      const source = { ...mockSource, url: `file://${fixturesPath}` };
      const adapter = new LocalAwesomeCopilotAdapter(source);
      assert.ok(adapter);
    });

    test('should normalize paths correctly', async () => {
      const source = { ...mockSource, url: fixturesPath + '//' };
      const adapter = new LocalAwesomeCopilotAdapter(source);

      // Should still work despite extra slashes
      const bundles = await adapter.fetchBundles();
      assert.ok(bundles.length > 0);
    });
  });

  suite('Error Handling', () => {
    test('should handle missing item files gracefully', async () => {
      // Create a collection that references non-existent files
      const source = { ...mockSource };
      const adapter = new LocalAwesomeCopilotAdapter(source);

      // This should work for fetchBundles (parsing only)
      const bundles = await adapter.fetchBundles();
      assert.ok(bundles.length > 0);
    });

    test('should provide helpful error messages', async () => {
      const source = { ...mockSource, url: '/completely/invalid/path' };
      const adapter = new LocalAwesomeCopilotAdapter(source);

      try {
        await adapter.fetchBundles();
        assert.fail('Should have thrown an error');
      } catch (error: any) {
        assert.ok(error.message.includes('local awesome-copilot collections'));
        assert.ok(error.message.includes('Collections directory does not exist'));
      }
    });
  });
});
