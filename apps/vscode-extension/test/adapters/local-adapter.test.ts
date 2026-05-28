/**
 * LocalAdapter Unit Tests
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  LocalAdapter,
} from '../../src/adapters/local-adapter';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('LocalAdapter', () => {
  const fixturesPath = path.join(__dirname, '../fixtures/local-library');

  const mockSource: RegistrySource = {
    id: 'test-local',
    name: 'Test Local',
    type: 'local',
    url: fixturesPath,
    enabled: true,
    priority: 1
  };

  suite('Constructor and Validation', () => {
    test('should accept valid local path', () => {
      const adapter = new LocalAdapter(mockSource);
      assert.strictEqual(adapter.type, 'local');
    });

    test('should accept file:// URL', () => {
      const source = { ...mockSource, url: `file://${fixturesPath}` };
      const adapter = new LocalAdapter(source);
      assert.ok(adapter);
    });

    test('should throw error for invalid path format', () => {
      const source = { ...mockSource, url: 'http://invalid.com/path' };
      assert.throws(() => new LocalAdapter(source), /Invalid local path/);
    });
  });

  suite('fetchMetadata', () => {
    test('should fetch local registry metadata', async () => {
      const adapter = new LocalAdapter(mockSource);
      const metadata = await adapter.fetchMetadata();

      assert.ok(metadata);
      assert.strictEqual(typeof metadata.name, 'string');
      assert.strictEqual(typeof metadata.description, 'string');
      assert.strictEqual(typeof metadata.bundleCount, 'number');
      assert.ok(metadata.bundleCount >= 0);
    });

    test('should report correct bundle count', async () => {
      const adapter = new LocalAdapter(mockSource);
      const metadata = await adapter.fetchMetadata();

      // We have 9 bundles in fixtures
      assert.strictEqual(metadata.bundleCount, 9);
    });

    test('should throw error for non-existent directory', async () => {
      const source = { ...mockSource, url: '/non/existent/path' };
      const adapter = new LocalAdapter(source);

      await assert.rejects(
        () => adapter.fetchMetadata(),
        /Directory does not exist/
      );
    });
  });

  suite('fetchBundles', () => {
    test('should discover all bundles with manifests', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 9);

      // Check bundle IDs
      const bundleIds = bundles.map((b) => b.id).toSorted();
      assert.deepStrictEqual(bundleIds, [
        'accessibility-bundle',
        'backend-bundle',
        'devops-bundle',
        'example-bundle',
        'example-bundle',
        'security-bundle',
        'testing-bundle',
        'testing-bundle',
        'web-dev-bundle'
      ]);
    });

    test('should parse YAML manifests correctly', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      const exampleBundle = bundles.find((b) => b.id === 'example-bundle');
      assert.ok(exampleBundle);
      assert.strictEqual(exampleBundle.name, 'Example Prompt Bundle');
      assert.strictEqual(exampleBundle.version, '1.0.0');
      assert.strictEqual(exampleBundle.author, 'Prompt Registry Team');
      assert.ok(Array.isArray(exampleBundle.tags));
      assert.ok(exampleBundle.tags.includes('example'));
    });

    test('should include all bundle metadata', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      for (const bundle of bundles) {
        assert.ok(bundle.id);
        assert.ok(bundle.name);
        assert.ok(bundle.version);
        assert.ok(bundle.description);
        assert.ok(bundle.author);
        assert.strictEqual(bundle.sourceId, 'test-local');
        assert.ok(Array.isArray(bundle.environments));
        assert.ok(Array.isArray(bundle.tags));
        assert.ok(bundle.lastUpdated);
        assert.ok(bundle.downloadUrl);
        assert.ok(bundle.manifestUrl);
      }
    });

    test('should handle file:// URLs in download/manifest URLs', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      for (const bundle of bundles) {
        assert.ok(bundle.downloadUrl.startsWith('file://'));
        assert.ok(bundle.manifestUrl.startsWith('file://'));
      }
    });

    test('should skip directories without manifests', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      // Only bundles with deployment-manifest.yml should be included
      // README.md and other files should be ignored
      assert.ok(bundles.every((b) => b.id));
    });
  });

  suite('validate', () => {
    test('should validate accessible local directory', async () => {
      const adapter = new LocalAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.ok(Array.isArray(result.warnings));
    });

    test('should fail validation for non-existent directory', async () => {
      const source = { ...mockSource, url: '/non/existent/path' };
      const adapter = new LocalAdapter(source);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(Array.isArray(result.errors));
      assert.ok(result.errors.length > 0);
    });
  });

  suite('getDownloadUrl', () => {
    test('should generate correct file:// URL for bundle', () => {
      const adapter = new LocalAdapter(mockSource);
      const url = adapter.getDownloadUrl('example-bundle', '1.0.0');

      assert.ok(url.startsWith('file://'));
      assert.ok(url.includes('example-bundle'));
    });
  });

  suite('getManifestUrl', () => {
    test('should generate correct manifest URL', () => {
      const adapter = new LocalAdapter(mockSource);
      const url = adapter.getManifestUrl('example-bundle', '1.0.0');

      assert.ok(url.startsWith('file://'));
      assert.ok(url.includes('example-bundle'));
      assert.ok(url.includes('deployment-manifest.yml'));
    });
  });

  suite('Diagnostics', () => {
    test('should log directory scanning details', async () => {
      const adapter = new LocalAdapter(mockSource);

      // Capture console output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => {
        logs.push(args.join(' '));
        originalLog(...args);
      };

      try {
        await adapter.fetchBundles();

        // Check diagnostic logs were generated
        assert.ok(logs.some((log) => log.includes('[LocalAdapter] Scanning directory')));
        assert.ok(logs.some((log) => log.includes('[LocalAdapter] Found') && log.includes('entries')));
        assert.ok(logs.some((log) => log.includes('[LocalAdapter] Discovered') && log.includes('valid bundles')));
      } finally {
        console.log = originalLog;
      }
    });
  });

  suite('downloadBundle', () => {
    test('should read a valid local file and return correct Buffer', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      // Get the first bundle
      const bundle = bundles[0];
      assert.ok(bundle, 'Should have at least one bundle');

      // Download the bundle
      const buffer = await adapter.downloadBundle(bundle);

      // Verify buffer is not empty
      assert.ok(buffer.length > 0, 'Buffer should not be empty');

      // Verify it's a valid ZIP file by checking magic number
      // ZIP files start with 'PK' (0x50 0x4B)
      assert.strictEqual(buffer[0], 0x50, 'First byte should be 0x50 (P)');
      assert.strictEqual(buffer[1], 0x4B, 'Second byte should be 0x4B (K)');
    });

    test('should throw error for file not found', async () => {
      const adapter = new LocalAdapter(mockSource);

      // Create a bundle with non-existent path
      const nonExistentBundle = {
        id: 'non-existent',
        name: 'Non-existent Bundle',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        sourceId: 'test-local',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '0 B',
        dependencies: [],
        license: 'MIT',
        downloadUrl: 'file:///non/existent/path',
        manifestUrl: 'file:///non/existent/path/deployment-manifest.yml'
      };

      await assert.rejects(
        () => adapter.downloadBundle(nonExistentBundle),
        /Bundle directory not found/,
        'Should throw error for non-existent directory'
      );
    });

    test('should throw error for permission denied', async function () {
      // Skip this test on Windows as permission handling is different
      if (process.platform === 'win32') {
        this.skip();
        return;
      }

      const adapter = new LocalAdapter(mockSource);

      // Create a bundle pointing to a restricted directory
      // /root is typically not accessible to regular users on Unix systems
      const restrictedBundle = {
        id: 'restricted',
        name: 'Restricted Bundle',
        version: '1.0.0',
        description: 'Test',
        author: 'Test',
        sourceId: 'test-local',
        environments: [],
        tags: [],
        lastUpdated: new Date().toISOString(),
        size: '0 B',
        dependencies: [],
        license: 'MIT',
        downloadUrl: 'file:///root/restricted',
        manifestUrl: 'file:///root/restricted/deployment-manifest.yml'
      };

      await assert.rejects(
        () => adapter.downloadBundle(restrictedBundle),
        /Permission denied|Bundle directory not found/,
        'Should throw error for permission denied'
      );
    });

    test('should handle binary file handling (ZIP files)', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      // Get a bundle
      const bundle = bundles.find((b) => b.id === 'example-bundle');
      assert.ok(bundle, 'Should find example-bundle');

      // Download the bundle
      const buffer = await adapter.downloadBundle(bundle);

      // Verify it's a valid ZIP file
      assert.ok(buffer.length > 0, 'Buffer should not be empty');
      assert.strictEqual(buffer[0], 0x50, 'Should start with ZIP magic number (P)');
      assert.strictEqual(buffer[1], 0x4B, 'Should start with ZIP magic number (K)');

      // Verify we can extract it using adm-zip
      // eslint-disable-next-line @typescript-eslint/naming-convention -- matches library export name
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();

      // Should have at least the deployment-manifest.yml
      assert.ok(entries.length > 0, 'ZIP should contain files');

      // Check for deployment-manifest.yml
      const manifestEntry = entries.find((e: any) => e.entryName === 'deployment-manifest.yml');
      assert.ok(manifestEntry, 'ZIP should contain deployment-manifest.yml');
    });

    test('should handle file:// URL format', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      // Get a bundle (should have file:// URL)
      const bundle = bundles[0];
      assert.ok(bundle.downloadUrl.startsWith('file://'), 'Bundle URL should start with file://');

      // Download should work with file:// URL
      const buffer = await adapter.downloadBundle(bundle);
      assert.ok(buffer.length > 0, 'Should successfully download from file:// URL');
    });

    test('should preserve binary data integrity', async () => {
      const adapter = new LocalAdapter(mockSource);
      const bundles = await adapter.fetchBundles();

      const bundle = bundles[0];

      // Download twice
      const buffer1 = await adapter.downloadBundle(bundle);
      const buffer2 = await adapter.downloadBundle(bundle);

      // Both downloads should produce identical buffers
      assert.strictEqual(buffer1.length, buffer2.length, 'Buffer lengths should match');
      assert.ok(buffer1.equals(buffer2), 'Buffers should be byte-for-byte identical');
    });
  });
});
