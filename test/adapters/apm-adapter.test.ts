/**
 * ApmAdapter Unit Tests
 * Tests remote APM package adapter (GitHub-based) using GitHubClient mocks
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import {
  ApmAdapter,
} from '../../src/adapters/apm-adapter';
import {
  ApmRuntimeManager,
} from '../../src/services/apm-runtime-manager';
import {
  GitHubClient,
} from '../../src/services/github-client';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('ApmAdapter', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRuntime: sinon.SinonStubbedInstance<ApmRuntimeManager>;
  let mockClient: sinon.SinonStubbedInstance<GitHubClient>;

  const mockSource: RegistrySource = {
    id: 'test-apm',
    name: 'Test APM',
    type: 'apm',
    url: 'https://github.com/test-owner/test-repo',
    enabled: true,
    priority: 1
  };

  setup(() => {
    sandbox = sinon.createSandbox();

    // Mock runtime manager
    ApmRuntimeManager.resetInstance();
    mockRuntime = sandbox.createStubInstance(ApmRuntimeManager);
    mockRuntime.getStatus.resolves({ installed: true, version: '1.0.0' });
    sandbox.stub(ApmRuntimeManager, 'getInstance').returns(mockRuntime);

    // Mock GitHubClient
    mockClient = sandbox.createStubInstance(GitHubClient);
    Object.defineProperty(mockClient, 'owner', { value: 'test-owner', configurable: true });
    Object.defineProperty(mockClient, 'repo', { value: 'test-repo', configurable: true });

    // Default: empty tree
    mockClient.getTree.resolves([]);
  });

  teardown(() => {
    sandbox.restore();
    ApmRuntimeManager.resetInstance();
  });

  suite('Constructor and Validation', () => {
    test('should accept valid GitHub URL', () => {
      const adapter = new ApmAdapter(mockSource, mockClient);
      assert.strictEqual(adapter.type, 'apm');
    });

    test('should accept GitHub URL with .git suffix', () => {
      const source = { ...mockSource, url: 'https://github.com/owner/repo.git' };
      const adapter = new ApmAdapter(source, mockClient);
      assert.ok(adapter);
    });

    test('should throw error for invalid URL', () => {
      const source = { ...mockSource, url: 'not-a-url' };
      assert.throws(() => new ApmAdapter(source, mockClient), /Invalid|URL/i);
    });

    test('should throw error for non-GitHub URL', () => {
      const source = { ...mockSource, url: 'https://example.com/owner/repo' };
      assert.throws(() => new ApmAdapter(source, mockClient), /GitHub/i);
    });

    test('should create default GitHubClient when none provided', () => {
      // This just verifies construction succeeds without passing client
      const adapter = new ApmAdapter(mockSource);
      assert.ok(adapter);
    });
  });

  suite('fetchBundles', () => {
    test('should throw error when runtime not installed and setup fails', async () => {
      mockRuntime.getStatus.resolves({ installed: false, uvxAvailable: false });
      mockRuntime.setupRuntime.resolves(false);

      const adapter = new ApmAdapter(mockSource, mockClient);

      await assert.rejects(
        () => adapter.fetchBundles(),
        /APM runtime is not available/
      );

      assert.ok(mockRuntime.setupRuntime.called);
    });

    test('should proceed when runtime setup succeeds', async () => {
      mockRuntime.getStatus.resolves({ installed: false, uvxAvailable: false });
      mockRuntime.setupRuntime.resolves(true);

      const adapter = new ApmAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.ok(mockRuntime.setupRuntime.called);
      assert.ok(Array.isArray(bundles));
    });

    test('should return empty array when tree fetch fails', async () => {
      mockClient.getTree.rejects(new Error('Network error'));

      const adapter = new ApmAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 0);
    });

    test('should fetch bundles using git tree API', async () => {
      // Mock tree response
      mockClient.getTree.withArgs('main', true).resolves([
        { path: 'apm.yml', type: 'blob', sha: 'abc123' },
        { path: 'sub-package/apm.yml', type: 'blob', sha: 'def456' },
        { path: 'node_modules/apm.yml', type: 'blob', sha: 'ghi789' } // Should be ignored
      ]);

      // Mock file content for root manifest
      mockClient.getFileContent.withArgs('apm.yml', 'main').resolves(
        Buffer.from('name: root-pkg\nversion: 1.0.0')
      );

      // Mock file content for sub-package manifest
      mockClient.getFileContent.withArgs('sub-package/apm.yml', 'main').resolves(
        Buffer.from('name: sub-pkg\nversion: 1.0.0')
      );

      const adapter = new ApmAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 2);
      assert.strictEqual(bundles[0].name, 'root-pkg');
      assert.strictEqual(bundles[1].name, 'sub-pkg');
    });

    test('should skip manifests in deep nested directories', async () => {
      mockClient.getTree.withArgs('main', true).resolves([
        { path: 'apm.yml', type: 'blob', sha: 'abc' },
        { path: 'a/b/apm.yml', type: 'blob', sha: 'deep' } // depth > 1, ignored
      ]);

      mockClient.getFileContent.withArgs('apm.yml', 'main').resolves(
        Buffer.from('name: root-pkg\nversion: 1.0.0')
      );

      const adapter = new ApmAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'root-pkg');
    });

    test('should handle manifest fetch failure gracefully', async () => {
      mockClient.getTree.withArgs('main', true).resolves([
        { path: 'apm.yml', type: 'blob', sha: 'abc' }
      ]);

      mockClient.getFileContent.rejects(new Error('Not found'));

      const adapter = new ApmAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 0);
    });

    test('should cache results', async () => {
      mockClient.getTree.withArgs('main', true).resolves([
        { path: 'apm.yml', type: 'blob', sha: 'abc' }
      ]);
      mockClient.getFileContent.withArgs('apm.yml', 'main').resolves(
        Buffer.from('name: cached-pkg\nversion: 1.0.0')
      );

      const adapter = new ApmAdapter(mockSource, mockClient);

      // First call
      const bundles1 = await adapter.fetchBundles();
      // Second call should use cache
      const bundles2 = await adapter.fetchBundles();

      assert.deepStrictEqual(bundles1, bundles2);
      // getTree should only be called once (cache hit on second call)
      assert.strictEqual(mockClient.getTree.callCount, 1);
    });
  });

  suite('validate', () => {
    test('should return invalid when runtime not installed', async () => {
      mockRuntime.getStatus.resolves({ installed: false });

      const adapter = new ApmAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes('APM CLI'));
    });

    test('should return valid with bundle count', async () => {
      mockRuntime.getStatus.resolves({ installed: true, version: '2.0.0' });
      mockClient.getTree.withArgs('main', true).resolves([
        { path: 'apm.yml', type: 'blob', sha: 'abc' }
      ]);
      mockClient.getFileContent.withArgs('apm.yml', 'main').resolves(
        Buffer.from('name: test-pkg\nversion: 1.0.0')
      );

      const adapter = new ApmAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.bundlesFound, 1);
    });

    test('should warn when no packages found', async () => {
      mockRuntime.getStatus.resolves({ installed: true, version: '2.0.0' });

      const adapter = new ApmAdapter(mockSource, mockClient);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.length > 0);
      assert.ok(result.warnings[0].includes('No APM packages'));
    });
  });

  suite('getManifestUrl', () => {
    test('should generate correct raw GitHub URL', () => {
      const adapter = new ApmAdapter(mockSource, mockClient);
      const url = adapter.getManifestUrl('some-bundle');

      assert.ok(url.includes('raw.githubusercontent.com'));
      assert.ok(url.includes('test-owner/test-repo'));
      assert.ok(url.includes('apm.yml'));
    });
  });

  suite('getDownloadUrl', () => {
    test('should return manifest URL (APM has no pre-built downloads)', () => {
      const adapter = new ApmAdapter(mockSource, mockClient);
      const downloadUrl = adapter.getDownloadUrl('some-bundle');
      const manifestUrl = adapter.getManifestUrl('some-bundle');

      assert.strictEqual(downloadUrl, manifestUrl);
    });
  });

  suite('requiresAuthentication', () => {
    test('should return false for public repos by default', () => {
      const adapter = new ApmAdapter(mockSource, mockClient);

      assert.strictEqual(adapter.requiresAuthentication(), false);
    });

    test('should return true when source is marked private', () => {
      const source = { ...mockSource, private: true };
      const adapter = new ApmAdapter(source, mockClient);

      assert.strictEqual(adapter.requiresAuthentication(), true);
    });
  });

  suite('Configuration', () => {
    test('should accept custom branch config', () => {
      const source = {
        ...mockSource,
        config: { branch: 'develop' }
      };
      const adapter = new ApmAdapter(source, mockClient);

      assert.ok(adapter);
    });

    test('should use custom branch in tree API call', async () => {
      const source = {
        ...mockSource,
        config: { branch: 'develop' }
      };
      mockClient.getTree.withArgs('develop', true).resolves([]);

      const adapter = new ApmAdapter(source, mockClient);
      await adapter.fetchBundles();

      assert.ok(mockClient.getTree.calledWith('develop', true));
    });

    test('should accept custom cache TTL config', () => {
      const source = {
        ...mockSource,
        config: { cacheTtl: 60_000 }
      };
      const adapter = new ApmAdapter(source, mockClient);

      assert.ok(adapter);
    });
  });

  suite('Security', () => {
    test('should validate GitHub URL format strictly', () => {
      const maliciousUrls = [
        'https://github.com/owner/repo;rm -rf /',
        'https://github.com/owner/repo|cat /etc/passwd',
        'javascript:alert(1)',
        'file:///etc/passwd'
      ];

      for (const url of maliciousUrls) {
        const client = mockClient;
        const source = { ...mockSource, url };
        assert.throws(
          () => new ApmAdapter(source, client),
          /Invalid|URL|GitHub/i,
          `Should reject: ${url}`
        );
      }
    });

    test('should not execute arbitrary code from manifest', async () => {
      // Verify adapter only parses YAML data, not executes scripts
      mockClient.getTree.withArgs('main', true).resolves([
        { path: 'apm.yml', type: 'blob', sha: 'abc' }
      ]);
      mockClient.getFileContent.withArgs('apm.yml', 'main').resolves(
        Buffer.from('name: evil-pkg\nversion: 1.0.0\nscripts:\n  postinstall: "rm -rf /"')
      );

      const adapter = new ApmAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      // Should return bundle without executing any scripts
      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'evil-pkg');
    });
  });

  suite('Error Handling', () => {
    test('should handle network errors gracefully', async () => {
      mockClient.getTree.rejects(new Error('ECONNREFUSED'));

      const adapter = new ApmAdapter(mockSource, mockClient);
      const bundles = await adapter.fetchBundles();

      // Should return empty array on failure
      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 0);
    });

    test('should provide helpful error messages when runtime not installed', async () => {
      mockRuntime.getStatus.resolves({ installed: false });

      const adapter = new ApmAdapter(mockSource, mockClient);

      try {
        await adapter.fetchBundles();
        assert.fail('Should have thrown');
      } catch (error: any) {
        assert.ok(error.message.includes('APM') || error.message.includes('install'));
      }
    });
  });

  suite('fetchMetadata', () => {
    test('should return source metadata', async () => {
      mockClient.getTree.withArgs('main', true).resolves([
        { path: 'apm.yml', type: 'blob', sha: 'abc' }
      ]);
      mockClient.getFileContent.withArgs('apm.yml', 'main').resolves(
        Buffer.from('name: test-pkg\nversion: 1.0.0')
      );

      const adapter = new ApmAdapter(mockSource, mockClient);
      const metadata = await adapter.fetchMetadata();

      assert.strictEqual(metadata.name, 'test-owner/test-repo');
      assert.ok(metadata.description.includes(mockSource.url));
      assert.strictEqual(metadata.bundleCount, 1);
      assert.strictEqual(metadata.version, '1.0.0');
    });
  });
});
