/**
 * ApmPackageMapper Unit Tests
 * Tests mapping of APM manifest format to Prompt Registry Bundle format
 */

import * as assert from 'node:assert';
import {
  ApmManifest,
  ApmPackageMapper,
  PackageContext,
} from '../../src/adapters/apm-package-mapper';

suite('ApmPackageMapper', () => {
  let mapper: ApmPackageMapper;

  const baseContext: PackageContext = {
    sourceId: 'test-source',
    owner: 'test-owner',
    repo: 'test-repo',
    path: ''
  };

  setup(() => {
    mapper = new ApmPackageMapper();
  });

  suite('toBundle', () => {
    test('should map basic manifest to bundle', () => {
      const manifest: ApmManifest = {
        name: 'Test Package',
        version: '1.0.0',
        description: 'A test package'
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.id, 'test-owner-test-package');
      assert.strictEqual(bundle.name, 'Test Package');
      assert.strictEqual(bundle.version, '1.0.0');
      assert.strictEqual(bundle.description, 'A test package');
      assert.strictEqual(bundle.sourceId, 'test-source');
      assert.ok(bundle.tags.includes('apm'));
    });

    test('should use default version 1.0.0 if not provided', () => {
      const manifest: ApmManifest = {
        name: 'Test Package'
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.version, '1.0.0');
    });

    test('should use owner as default author', () => {
      const manifest: ApmManifest = {
        name: 'Test'
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.author, 'test-owner');
    });

    test('should use manifest author if provided', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        author: 'Custom Author'
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.author, 'Custom Author');
    });

    test('should include all manifest tags plus apm tag', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        tags: ['azure', 'testing']
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.tags.includes('azure'));
      assert.ok(bundle.tags.includes('testing'));
      assert.ok(bundle.tags.includes('apm'));
    });

    test('should infer cloud environment from azure tag', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        tags: ['azure']
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.environments.includes('cloud'));
    });

    test('should infer cloud environment from aws tag', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        tags: ['aws']
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.environments.includes('cloud'));
    });

    test('should infer infrastructure environment from devops tag', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        tags: ['devops']
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.environments.includes('infrastructure'));
    });

    test('should infer web environment from frontend tag', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        tags: ['frontend']
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.environments.includes('web'));
    });

    test('should default to general environment if no tags match', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        tags: ['random-tag']
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.environments.includes('general'));
    });

    test('should map APM dependencies correctly', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        dependencies: {
          apm: ['owner/dep1', 'owner/dep2']
        }
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.dependencies.length, 2);
      assert.strictEqual(bundle.dependencies[0].bundleId, 'owner/dep1');
      assert.strictEqual(bundle.dependencies[0].versionRange, '*');
      assert.strictEqual(bundle.dependencies[0].optional, false);
    });

    test('should handle empty dependencies', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        dependencies: {
          apm: []
        }
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.dependencies.length, 0);
    });

    test('should include apmPackageRef for root package', () => {
      const manifest: ApmManifest = { name: 'Test' };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual((bundle as any).apmPackageRef, 'test-owner/test-repo');
    });

    test('should include apmPackageRef for subpath package', () => {
      const manifest: ApmManifest = { name: 'Test' };
      const context = { ...baseContext, path: 'packages/my-pkg' };

      const bundle = mapper.toBundle(manifest, context);

      assert.strictEqual((bundle as any).apmPackageRef, 'test-owner/test-repo/packages/my-pkg');
    });

    test('should generate correct manifest URL', () => {
      const manifest: ApmManifest = { name: 'Test' };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.manifestUrl.includes('raw.githubusercontent.com'));
      assert.ok(bundle.manifestUrl.includes('test-owner/test-repo'));
      assert.ok(bundle.manifestUrl.includes('apm.yml'));
    });

    test('should generate correct manifest URL for subpath', () => {
      const manifest: ApmManifest = { name: 'Test' };
      const context = { ...baseContext, path: 'packages/my-pkg' };

      const bundle = mapper.toBundle(manifest, context);

      assert.ok(bundle.manifestUrl.includes('packages/my-pkg/apm.yml'));
    });

    test('should set license to MIT by default', () => {
      const manifest: ApmManifest = { name: 'Test' };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.license, 'MIT');
    });

    test('should use manifest license if provided', () => {
      const manifest: ApmManifest = { name: 'Test', license: 'Apache-2.0' };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.license, 'Apache-2.0');
    });

    test('should include lastUpdated timestamp', () => {
      const manifest: ApmManifest = { name: 'Test' };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.lastUpdated);
      // Should be a valid ISO date string
      assert.ok(!Number.isNaN(Date.parse(bundle.lastUpdated)));
    });

    test('should sanitize bundle ID by converting to lowercase and replacing spaces', () => {
      const manifest: ApmManifest = { name: 'My Test Package' };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.id, 'test-owner-my-test-package');
      assert.ok(!bundle.id.includes(' '));
      assert.strictEqual(bundle.id, bundle.id.toLowerCase());
    });

    test('should generate description from package ref if not provided', () => {
      const manifest: ApmManifest = { name: 'Test' };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(bundle.description.includes('test-owner/test-repo'));
    });

    test('should set repository URL', () => {
      const manifest: ApmManifest = { name: 'Test' };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.strictEqual(bundle.repository, 'https://github.com/test-owner/test-repo');
    });
  });

  suite('Security', () => {
    test('should sanitize name with special characters', () => {
      const manifest: ApmManifest = { name: 'Test<script>alert(1)</script>' };

      const bundle = mapper.toBundle(manifest, baseContext);

      // ID should be sanitized
      assert.ok(!bundle.id.includes('<'));
      assert.ok(!bundle.id.includes('>'));
    });

    test('should handle very long names gracefully', () => {
      const longName = 'A'.repeat(1000);
      const manifest: ApmManifest = { name: longName };

      const bundle = mapper.toBundle(manifest, baseContext);

      // Should not throw and should have reasonable ID length
      assert.ok(bundle.id.length < 500);
    });

    test('should handle null/undefined tags gracefully', () => {
      const manifest: ApmManifest = {
        name: 'Test',
        tags: undefined
      };

      const bundle = mapper.toBundle(manifest, baseContext);

      assert.ok(Array.isArray(bundle.tags));
      assert.ok(bundle.tags.includes('apm'));
    });
  });
});
