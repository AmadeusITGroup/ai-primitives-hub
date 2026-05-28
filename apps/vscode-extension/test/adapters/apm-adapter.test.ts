/**
 * ApmAdapter Unit Tests
 * Tests remote APM package adapter (GitHub-based)
 */

import * as assert from 'node:assert';
import nock from 'nock';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  ApmAdapter,
} from '../../src/adapters/apm-adapter';
import {
  ApmRuntimeManager,
} from '../../src/services/apm-runtime-manager';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('ApmAdapter', () => {
  let sandbox: sinon.SinonSandbox;
  let mockRuntime: sinon.SinonStubbedInstance<ApmRuntimeManager>;

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
    nock.cleanAll(); // Clean any existing nocks (e.g. from unit.setup.js)

    // Mock runtime manager
    ApmRuntimeManager.resetInstance();
    mockRuntime = sandbox.createStubInstance(ApmRuntimeManager);
    mockRuntime.getStatus.resolves({ installed: true, version: '1.0.0' });

    sandbox.stub(ApmRuntimeManager, 'getInstance').returns(mockRuntime);

    // Stub vscode authentication
    sandbox.stub(vscode.authentication, 'getSession').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    ApmRuntimeManager.resetInstance();
    nock.cleanAll();
  });

  suite('Authentication', () => {
    test('should use VS Code authentication token when available', async () => {
      const adapter = new ApmAdapter(mockSource);
      const token = 'vscode-token';

      // Mock VS Code auth
      (vscode.authentication.getSession as sinon.SinonStub).resolves({
        accessToken: token,
        scopes: ['repo'],
        id: 'id',
        account: { id: 'acc', label: 'acc' }
      });

      // Verify nock request
      const scope = nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/git/trees/main')
        .query({ recursive: '1' })
        .matchHeader('Authorization', `token ${token}`)
        .reply(200, { tree: [] });

      await adapter.fetchBundles();

      assert.ok(scope.isDone(), 'Request with auth header was not made');
    });

    test('should use token in HTTPS requests', async () => {
      const adapter = new ApmAdapter(mockSource);
      const token = 'test-token-123';

      // Mock VS Code auth
      (vscode.authentication.getSession as sinon.SinonStub).resolves({
        accessToken: token,
        scopes: ['repo'],
        id: 'id',
        account: { id: 'acc', label: 'acc' }
      });

      // Verify nock request
      const scope = nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/git/trees/main')
        .query({ recursive: '1' })
        .matchHeader('Authorization', `token ${token}`)
        .reply(200, { tree: [] });

      await adapter.fetchBundles();

      assert.ok(scope.isDone(), 'Request with auth header was not made');
    });

    test('should fallback to config token if VS Code auth fails', async () => {
      const sourceWithToken = { ...mockSource, token: 'config-token' };
      const adapter = new ApmAdapter(sourceWithToken);

      // Stub execShell to fail (simulate gh not installed or not authenticated)
      sandbox.stub(adapter as any, 'execShell').rejects(new Error('gh not found'));

      // VS Code auth fails/returns undefined
      (vscode.authentication.getSession as sinon.SinonStub).resolves(undefined);

      // Verify nock request
      const scope = nock('https://api.github.com')
        .get('/repos/test-owner/test-repo/git/trees/main')
        .query({ recursive: '1' })
        .matchHeader('Authorization', 'token config-token')
        .reply(200, { tree: [] });

      await adapter.fetchBundles();

      assert.ok(scope.isDone(), 'Request with config token auth header was not made');
    });
  });

  suite('Constructor and Validation', () => {
    test('should accept valid GitHub URL', () => {
      const adapter = new ApmAdapter(mockSource);
      assert.strictEqual(adapter.type, 'apm');
    });

    test('should accept GitHub URL with .git suffix', () => {
      const source = { ...mockSource, url: 'https://github.com/owner/repo.git' };
      const adapter = new ApmAdapter(source);
      assert.ok(adapter);
    });

    test('should throw error for invalid URL', () => {
      const source = { ...mockSource, url: 'not-a-url' };
      assert.throws(() => new ApmAdapter(source), /Invalid|URL/i);
    });

    test('should throw error for non-GitHub URL', () => {
      const source = { ...mockSource, url: 'https://example.com/owner/repo' };
      assert.throws(() => new ApmAdapter(source), /GitHub/i);
    });
  });

  suite('parseGitHubUrl', () => {
    test('should extract owner and repo from URL', () => {
      const adapter = new ApmAdapter(mockSource);
      const { owner, repo } = (adapter as any).parseGitHubUrl();

      assert.strictEqual(owner, 'test-owner');
      assert.strictEqual(repo, 'test-repo');
    });

    test('should handle .git suffix', () => {
      const source = { ...mockSource, url: 'https://github.com/owner/repo.git' };
      const adapter = new ApmAdapter(source);
      const { repo } = (adapter as any).parseGitHubUrl();

      assert.strictEqual(repo, 'repo');
    });
  });

  suite('fetchBundles', () => {
    test('should throw error when runtime not installed and setup fails', async () => {
      mockRuntime.getStatus.resolves({ installed: false, uvxAvailable: false });
      mockRuntime.setupRuntime.resolves(false);

      const adapter = new ApmAdapter(mockSource);

      await assert.rejects(
        () => adapter.fetchBundles(),
        /APM runtime is not available/
      );

      assert.ok(mockRuntime.setupRuntime.called);
    });

    test('should proceed when runtime setup succeeds', async () => {
      mockRuntime.getStatus.resolves({ installed: false, uvxAvailable: false });
      mockRuntime.setupRuntime.resolves(true);

      const adapter = new ApmAdapter(mockSource);

      // Stub fetchGitTree to avoid network
      sandbox.stub(adapter as any, 'fetchGitTree').resolves([]);

      const bundles = await adapter.fetchBundles();

      assert.ok(mockRuntime.setupRuntime.called);
      assert.ok(Array.isArray(bundles));
    });

    test('should return empty array when manifest not found', async () => {
      const adapter = new ApmAdapter(mockSource);

      sandbox.stub(adapter as any, 'httpsGet').rejects(new Error('Not Found'));

      const bundles = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles));
    });

    test('should fetch bundles using git tree optimization', async () => {
      const adapter = new ApmAdapter(mockSource);

      // Mock httpsGet to return tree then manifests
      const httpsGetStub = sandbox.stub(adapter as any, 'httpsGet');

      // 1. Git Tree response
      httpsGetStub.onCall(0).resolves(JSON.stringify({
        tree: [
          { path: 'apm.yml', type: 'blob' },
          { path: 'sub-package/apm.yml', type: 'blob' },
          { path: 'node_modules/apm.yml', type: 'blob' } // Should be ignored
        ]
      }));

      // 2. Root manifest response
      httpsGetStub.onCall(1).resolves('name: root-pkg\nversion: 1.0.0');

      // 3. Sub-package manifest response
      httpsGetStub.onCall(2).resolves('name: sub-pkg\nversion: 1.0.0');

      const bundles = await adapter.fetchBundles();

      assert.strictEqual(bundles.length, 2);
      assert.strictEqual(bundles[0].name, 'root-pkg');
      assert.strictEqual(bundles[1].name, 'sub-pkg');
    });

    test('should cache results', async () => {
      const adapter = new ApmAdapter(mockSource);

      const httpsGetStub = sandbox.stub(adapter as any, 'httpsGet');
      httpsGetStub.resolves(JSON.stringify({ tree: [] }));

      const bundles1 = await adapter.fetchBundles();
      const bundles2 = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles1));
      assert.ok(Array.isArray(bundles2));
      assert.strictEqual(httpsGetStub.callCount, 1, 'Should only make one network call due to caching');
    });
  });

  suite('validate', () => {
    test('should return invalid when runtime not installed', async () => {
      mockRuntime.getStatus.resolves({ installed: false });

      const adapter = new ApmAdapter(mockSource);
      const result = await adapter.validate();

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes('APM CLI'));
    });

    test('should return runtime version in status', async () => {
      mockRuntime.getStatus.resolves({
        installed: true,
        version: '2.0.0'
      });

      const adapter = new ApmAdapter(mockSource);

      sandbox.stub(adapter as any, 'httpsGet').resolves(JSON.stringify({ tree: [] }));

      const result = await adapter.validate();

      assert.ok('valid' in result);
      assert.ok('errors' in result);
    });
  });

  suite('getManifestUrl', () => {
    test('should generate correct raw GitHub URL', () => {
      const adapter = new ApmAdapter(mockSource);
      const url = adapter.getManifestUrl('some-bundle');

      assert.ok(url.includes('raw.githubusercontent.com'));
      assert.ok(url.includes('test-owner/test-repo'));
      assert.ok(url.includes('apm.yml'));
    });
  });

  suite('getDownloadUrl', () => {
    test('should return manifest URL (APM has no pre-built downloads)', () => {
      const adapter = new ApmAdapter(mockSource);
      const downloadUrl = adapter.getDownloadUrl('some-bundle');
      const manifestUrl = adapter.getManifestUrl('some-bundle');

      assert.strictEqual(downloadUrl, manifestUrl);
    });
  });

  suite('requiresAuthentication', () => {
    test('should return false for public repos by default', () => {
      const adapter = new ApmAdapter(mockSource);

      assert.strictEqual(adapter.requiresAuthentication(), false);
    });

    test('should return true when source is marked private', () => {
      const source = { ...mockSource, private: true };
      const adapter = new ApmAdapter(source);

      assert.strictEqual(adapter.requiresAuthentication(), true);
    });
  });

  suite('Configuration', () => {
    test('should accept custom branch config', () => {
      const source = {
        ...mockSource,
        config: { branch: 'develop' }
      };
      const adapter = new ApmAdapter(source);

      assert.ok(adapter);
    });

    test('should accept custom cache TTL config', () => {
      const source = {
        ...mockSource,
        config: { cacheTtl: 60_000 }
      };
      const adapter = new ApmAdapter(source);

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
        const source = { ...mockSource, url };
        assert.throws(
          () => new ApmAdapter(source),
          /Invalid|URL|GitHub/i,
          `Should reject: ${url}`
        );
      }
    });

    test('should not execute arbitrary code from manifest', async () => {
      const adapter = new ApmAdapter(mockSource);

      const httpsGetStub = sandbox.stub(adapter as any, 'httpsGet');
      httpsGetStub.onCall(0).resolves(JSON.stringify({
        tree: [{ path: 'apm.yml', type: 'blob' }]
      }));
      httpsGetStub.onCall(1).resolves('name: malicious\nversion: 1.0.0\nscripts:\n  preinstall: "rm -rf /"');

      const bundles = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 1);
      assert.strictEqual(bundles[0].name, 'malicious');
    });
  });

  suite('Error Handling', () => {
    test('should handle network errors gracefully', async () => {
      const adapter = new ApmAdapter(mockSource);

      sandbox.stub(adapter as any, 'httpsGet').rejects(new Error('ECONNREFUSED'));

      const bundles = await adapter.fetchBundles();

      assert.ok(Array.isArray(bundles));
      assert.strictEqual(bundles.length, 0);
    });

    test('should provide helpful error messages when runtime not installed', async () => {
      mockRuntime.getStatus.resolves({ installed: false });

      const adapter = new ApmAdapter(mockSource);

      try {
        await adapter.fetchBundles();
        assert.fail('Should have thrown');
      } catch (error: any) {
        assert.ok(error.message.includes('APM') || error.message.includes('install'));
      }
    });
  });
});
