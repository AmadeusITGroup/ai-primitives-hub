/**
 * Hub Bundle Resolution Tests
 * Tests for resolving bundle references to downloadable sources
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubConfig,
} from '../../src/types/hub';

suite('Hub Bundle Resolution', () => {
  let storage: HubStorage;
  let hubManager: HubManager;
  let tempDir: string;

  const createHubWithSources = (): HubConfig => ({
    version: '1.0.0',
    metadata: {
      name: 'Test Hub',
      description: 'Test hub with sources',
      maintainer: 'Test',
      updatedAt: new Date().toISOString()
    },
    sources: [
      {
        id: 'github-source',
        name: 'GitHub Source',
        type: 'github',
        url: 'github:test/repo',
        enabled: true,
        priority: 1,
        metadata: {
          description: 'GitHub bundle source'
        }
      },
      {
        id: 'url-source',
        name: 'URL Source',
        type: 'local',
        url: '/path/to/bundles',
        enabled: true,
        priority: 2,
        metadata: {
          description: 'Local directory source'
        }
      }
    ],
    profiles: [
      {
        id: 'test-profile',
        name: 'Test Profile',
        description: 'Profile with bundles',
        bundles: [
          {
            id: 'bundle-1',
            version: '1.0.0',
            source: 'github-source',
            required: true
          },
          {
            id: 'bundle-2',
            version: '2.0.0',
            source: 'url-source',
            required: false
          },
          {
            id: 'bundle-3',
            version: 'latest',
            source: 'github-source',
            required: true
          }
        ],
        icon: '📦',
        active: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });

  setup(() => {
    tempDir = path.join(__dirname, '../../test-temp-hub-bundle-resolution');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    storage = new HubStorage(tempDir);
    hubManager = new HubManager(storage, {} as any, process.cwd(), undefined, undefined);
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Profile Bundle Resolution', () => {
    test('should resolve all bundles in profile', async () => {
      const hub = createHubWithSources();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/hub' });

      const resolved = await hubManager.resolveProfileBundles('test-hub', 'test-profile');

      assert.strictEqual(resolved.length, 3);
      // URL is no longer populated by resolveProfileBundles
      assert.ok(resolved.every((b) => b.bundle));
    });

    test('should include bundle metadata in resolution', async () => {
      const hub = createHubWithSources();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/hub' });

      const resolved = await hubManager.resolveProfileBundles('test-hub', 'test-profile');

      const bundle1 = resolved.find((r) => r.bundle.id === 'bundle-1');
      assert.ok(bundle1);
      assert.strictEqual(bundle1.bundle.version, '1.0.0');
      assert.strictEqual(bundle1.bundle.required, true);
      assert.strictEqual(bundle1.bundle.source, 'github-source');
    });

    test('should handle profile with no bundles', async () => {
      const hub = createHubWithSources();
      hub.profiles[0].bundles = [];
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/hub' });

      const resolved = await hubManager.resolveProfileBundles('test-hub', 'test-profile');

      assert.strictEqual(resolved.length, 0);
    });

    test('should throw error for non-existent profile', async () => {
      const hub = createHubWithSources();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/hub' });

      await assert.rejects(
        async () => await hubManager.resolveProfileBundles('test-hub', 'non-existent'),
        (err: Error) => {
          assert.ok(err.message.includes('Profile not found'));
          return true;
        }
      );
    });
  });

  suite('Required vs Optional Bundles', () => {
    test('should identify required bundles', async () => {
      const hub = createHubWithSources();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/hub' });

      const resolved = await hubManager.resolveProfileBundles('test-hub', 'test-profile');
      const required = resolved.filter((r) => r.bundle.required);

      assert.strictEqual(required.length, 2);
      assert.ok(required.some((r) => r.bundle.id === 'bundle-1'));
      assert.ok(required.some((r) => r.bundle.id === 'bundle-3'));
    });

    test('should identify optional bundles', async () => {
      const hub = createHubWithSources();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/hub' });

      const resolved = await hubManager.resolveProfileBundles('test-hub', 'test-profile');
      const optional = resolved.filter((r) => !r.bundle.required);

      assert.strictEqual(optional.length, 1);
      assert.strictEqual(optional[0].bundle.id, 'bundle-2');
    });
  });
});
