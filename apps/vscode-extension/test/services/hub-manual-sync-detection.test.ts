/**
 * Hub Manual Sync Detection Tests
 * Tests for detecting profile changes and conflicts
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

suite('Hub Manual Sync Detection', () => {
  let storage: HubStorage;
  let hubManager: HubManager;
  let tempDir: string;

  const createTestHub = (): HubConfig => ({
    version: '1.0.0',
    metadata: {
      name: 'Test Hub',
      description: 'Test hub',
      maintainer: 'Test',
      updatedAt: new Date().toISOString()
    },
    sources: [
      {
        id: 'test-source',
        name: 'Test Source',
        type: 'github',
        url: 'github:test/repo',
        enabled: true,
        priority: 1,
        metadata: {
          description: 'Test source'
        }
      }
    ],
    profiles: [
      {
        id: 'profile-1',
        name: 'Profile 1',
        description: 'First profile',
        bundles: [
          {
            id: 'bundle-1',
            version: '1.0.0',
            source: 'test-source',
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
    tempDir = path.join(__dirname, '../../test-temp-hub-manual-sync');
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

  suite('Profile Change Detection', () => {
    test('should detect when active profile has changed in hub', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Modify the hub's profile
      // Add small delay to ensure updatedAt > activatedAt (timestamp precision issue)
      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].description = 'Updated description';
      updated.config.profiles[0].updatedAt = new Date(Date.now() + 1000).toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const hasChanges = await hubManager.hasProfileChanges('test-hub', 'profile-1');
      assert.strictEqual(hasChanges, true);
    });

    test('should return false when profile has not changed', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      const hasChanges = await hubManager.hasProfileChanges('test-hub', 'profile-1');
      assert.strictEqual(hasChanges, false);
    });

    test('should detect bundle additions', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Add a bundle
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '1.0.0',
        source: 'test-source',
        required: false
      });
      updated.config.profiles[0].updatedAt = new Date(Date.now() + 1000).toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      assert.ok(changes);
      assert.ok(changes.bundlesAdded);
      assert.strictEqual(changes.bundlesAdded.length, 1);
      assert.strictEqual(changes.bundlesAdded[0].id, 'bundle-2');
    });

    test('should detect bundle removals', async () => {
      const hub = createTestHub();
      hub.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '1.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Remove a bundle
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles = updated.config.profiles[0].bundles.filter((b) => b.id !== 'bundle-2');
      updated.config.profiles[0].updatedAt = new Date(Date.now() + 1000).toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      assert.ok(changes);
      assert.ok(changes.bundlesRemoved);
      assert.strictEqual(changes.bundlesRemoved.length, 1);
      assert.strictEqual(changes.bundlesRemoved[0], 'bundle-2');
    });

    test('should detect bundle version changes', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Update bundle version
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles[0].version = '2.0.0';
      updated.config.profiles[0].updatedAt = new Date(Date.now() + 1000).toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      assert.ok(changes);
      assert.ok(changes.bundlesUpdated);
      assert.strictEqual(changes.bundlesUpdated.length, 1);
      assert.strictEqual(changes.bundlesUpdated[0].id, 'bundle-1');
      assert.strictEqual(changes.bundlesUpdated[0].oldVersion, '1.0.0');
      assert.strictEqual(changes.bundlesUpdated[0].newVersion, '2.0.0');
    });

    test('should detect metadata changes', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update metadata
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].name = 'Updated Name';
      updated.config.profiles[0].description = 'Updated Description';
      updated.config.profiles[0].updatedAt = new Date(Date.now() + 1000).toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      assert.ok(changes);
      assert.ok(changes.metadataChanged);
      assert.strictEqual(changes.metadataChanged.name, true);
      assert.strictEqual(changes.metadataChanged.description, true);
    });
  });

  suite('Last Sync Tracking', () => {
    test('should track last sync timestamp', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const beforeSync = Date.now();
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });
      const afterSync = Date.now();

      const state = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.ok(state);
      const syncTime = new Date(state.activatedAt).getTime();
      assert.ok(syncTime >= beforeSync && syncTime <= afterSync);
    });

    test('should update last sync on profile sync', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      const state1 = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.ok(state1);
      const firstSync = new Date(state1.activatedAt).getTime();

      // Wait a bit and sync again
      await new Promise((resolve) => setTimeout(resolve, 10));
      await hubManager.syncProfile('test-hub', 'profile-1');

      const state2 = await storage.getProfileActivationState('test-hub', 'profile-1');
      assert.ok(state2);
      const secondSync = new Date(state2.activatedAt).getTime();

      assert.ok(secondSync > firstSync);
    });
  });

  suite('Change Summary', () => {
    test('should provide comprehensive change summary', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Make multiple changes
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].name = 'Updated Name';
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '1.0.0',
        source: 'test-source',
        required: false
      });
      updated.config.profiles[0].bundles[0].version = '2.0.0';
      updated.config.profiles[0].updatedAt = new Date(Date.now() + 1000).toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      assert.ok(changes);
      assert.ok(changes.metadataChanged?.name);
      assert.strictEqual(changes.bundlesAdded?.length, 1);
      assert.strictEqual(changes.bundlesUpdated?.length, 1);
    });

    test('should return null when profile is not activated', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      assert.strictEqual(changes, null);
    });
  });
});
