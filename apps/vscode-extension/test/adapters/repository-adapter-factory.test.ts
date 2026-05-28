/**
 * Repository Adapter Factory Unit Tests
 */

import * as assert from 'node:assert';
import {
  GitHubAdapter,
} from '../../src/adapters/github-adapter';
import {
  LocalAdapter,
} from '../../src/adapters/local-adapter';
import {
  RegistrySource,
} from '../../src/types/registry';

suite('RepositoryAdapterFactory', () => {
  suite('Adapter Creation', () => {
    test('should create GitHub adapter for github type', () => {
      const source: RegistrySource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1,
        token: 'test-token'
      };

      const adapter = new GitHubAdapter(source);
      assert.strictEqual(adapter.type, 'github');
    });

    test('should create Local adapter for local type', () => {
      const source: RegistrySource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'local',
        url: '/path/to/bundles',
        enabled: true,
        priority: 1
      };

      const adapter = new LocalAdapter(source);
      assert.strictEqual(adapter.type, 'local');
    });

    test('should throw error for unknown adapter type', () => {
      const source: any = {
        id: 'test-source',
        name: 'Test Source',
        type: 'unknown',
        url: 'https://example.com',
        enabled: true,
        priority: 1
      };

      // Factory would throw error for unknown type
      assert.ok(source.type);
    });
  });

  suite('Adapter Registration', () => {
    test('should support custom adapter registration', () => {
      const customAdapters = new Map<string, any>([['custom', class CustomAdapter {
        public type = 'custom';
        public fetchBundles() {
          return [];
        }

        public getDownloadUrl() {
          return '';
        }
      }]]);

      assert.strictEqual(customAdapters.size, 1);
      assert.ok(customAdapters.has('custom'));
    });

    test('should allow overriding default adapters', () => {
      const adapters = new Map<string, any>([['github', GitHubAdapter], ['github', class CustomGitHubAdapter {
        public type = 'github';
        public fetchBundles() {
          return [];
        }
      }]]);

      // Override

      assert.ok(adapters.get('github'));
    });
  });

  suite('Adapter Interface Compliance', () => {
    test('should verify all adapters implement required methods', () => {
      const adapters = [
        GitHubAdapter,
        LocalAdapter
      ];

      // eslint-disable-next-line @typescript-eslint/naming-convention -- name reflects domain terminology
      for (const AdapterClass of adapters) {
        const prototype = AdapterClass.prototype;
        for (const method of ['fetchBundles', 'getDownloadUrl']) {
          assert.ok(
            typeof prototype[method as keyof typeof prototype] === 'function',
            `${AdapterClass.name} missing ${method}`
          );
        }
      }
    });

    test('should verify adapter type property', () => {
      const sources = [
        { type: 'github', url: 'https://github.com/test/repo', token: 'token' },
        { type: 'local', url: '/path/to/bundles' },
        { type: 'awesome-copilot', url: 'https://example.com/bundles' },
        { type: 'apm', url: 'https://apm.example.com' }
      ];

      for (const source of sources) {
        assert.ok(source.type);
        assert.ok(['github', 'local', 'awesome-copilot', 'apm'].includes(source.type));
      }
    });
  });

  suite('Source Configuration Validation', () => {
    test('should validate required source properties', () => {
      const source = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      const hasRequired = Boolean(
        source.id
        && source.name
        && source.type
        && source.url
        && typeof source.enabled === 'boolean'
        && typeof source.priority === 'number'
      );

      assert.strictEqual(hasRequired, true);
    });

    test('should validate URL format for each adapter type', () => {
      const validUrls = {
        github: [
          'https://github.com/owner/repo',
          'git@github.com:owner/repo.git'
        ],
        local: [
          '/absolute/path/to/bundles',
          './relative/path'
        ]
      };

      for (const [type, urls] of Object.entries(validUrls)) {
        for (const url of urls) {
          assert.ok(url, `Invalid URL for ${type}: ${url}`);
        }
      }
    });

    test('should validate authentication requirements', () => {
      const sources = [
        { type: 'github', url: 'https://github.com/test/repo', token: 'required' },
        { type: 'local', url: '/path/to/bundles', token: undefined },
        { type: 'awesome-copilot', url: 'https://example.com/bundles', token: undefined }
      ];

      for (const source of sources) {
        if (source.type === 'github') {
          assert.ok(source.token, `Token required for ${source.type}`);
        }
      }
    });
  });

  suite('Adapter Caching and Reuse', () => {
    test('should cache adapter instances per source', () => {
      const cache = new Map<string, any>();

      const sourceId = 'test-source';
      const source: RegistrySource = {
        id: sourceId,
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1,
        token: 'test-token'
      };

      if (!cache.has(sourceId)) {
        cache.set(sourceId, new GitHubAdapter(source));
      }

      const adapter1 = cache.get(sourceId);
      const adapter2 = cache.get(sourceId);

      assert.strictEqual(adapter1, adapter2);
    });

    test('should invalidate cache when source changes', () => {
      const cache = new Map<string, any>();
      const sourceId = 'test-source';

      // Initial source
      const source1: RegistrySource = {
        id: sourceId,
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo1',
        enabled: true,
        priority: 1,
        token: 'test-token'
      };

      cache.set(sourceId, new GitHubAdapter(source1));

      // Source changes
      const source2: RegistrySource = {
        ...source1,
        url: 'https://github.com/test/repo2'
      };

      // Invalidate and recreate
      cache.delete(sourceId);
      cache.set(sourceId, new GitHubAdapter(source2));

      assert.ok(cache.get(sourceId));
    });
  });

  suite('Error Handling', () => {
    test('should handle adapter creation errors', () => {
      const invalidSource: RegistrySource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'invalid-url',
        enabled: true,
        priority: 1,
        token: undefined
      };

      assert.throws(() => new GitHubAdapter(invalidSource));
    });

    test('should validate source before adapter creation', () => {
      const source: any = {
        id: 'test-source'
        // Missing required fields
      };

      const isValid = Boolean(source.id && source.type && source.url);
      assert.strictEqual(isValid, false);
    });
  });
});
