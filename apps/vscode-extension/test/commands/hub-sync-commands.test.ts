/**
 * Test Suite: Hub Sync Commands
 *
 * Tests VS Code commands for manual profile synchronization.
 * Covers checkForUpdates, viewChanges, syncProfile commands.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HubSyncCommands,
} from '../../src/commands/hub-sync-commands';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubConfig,
} from '../../src/types/hub';

suite('Hub Sync Commands', () => {
  let storage: HubStorage;
  let hubManager: HubManager;
  let commands: HubSyncCommands;
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
        id: 'test-profile',
        name: 'Test Profile',
        description: 'Test profile',
        icon: '📦',
        bundles: [
          {
            id: 'bundle-1',
            version: '1.0.0',
            source: 'test-source',
            required: true
          }
        ],
        active: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });

  setup(() => {
    tempDir = path.join(__dirname, '../../test-temp-hub-sync-commands');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    storage = new HubStorage(tempDir);
    hubManager = new HubManager(storage, {} as any, process.cwd(), undefined, undefined);
    commands = new HubSyncCommands(hubManager);
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Check For Updates', () => {
    test('should check for updates on active profile', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update profile
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '1.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const result = await commands.checkForUpdates('test-hub', 'test-profile');
      assert.ok(result.hasUpdates);
      assert.ok(result.changes);
    });

    test('should return no updates when profile unchanged', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      const result = await commands.checkForUpdates('test-hub', 'test-profile');
      assert.strictEqual(result.hasUpdates, false);
    });

    test('should handle non-active profile', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      const result = await commands.checkForUpdates('test-hub', 'test-profile');
      assert.strictEqual(result.hasUpdates, false);
      assert.strictEqual(result.message, 'Profile is not active');
    });
  });

  suite('View Changes', () => {
    test('should display changes for active profile', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update profile
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '1.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const result = await commands.viewChanges('test-hub', 'test-profile');
      assert.ok(result);
      assert.ok(result.summary);
      assert.ok(result.summary.includes('bundle-2'));
      assert.ok(result.summary.includes('Added'));
    });

    test('should return null for profile with no changes', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      const result = await commands.viewChanges('test-hub', 'test-profile');
      assert.strictEqual(result, null);
    });
  });

  suite('Sync Profile', () => {
    test('should sync profile and update activation state', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update profile
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '1.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', updated.config, updated.reference);

      // Verify changes exist before sync
      const changesBefore = await hubManager.hasProfileChanges('test-hub', 'test-profile');
      assert.ok(changesBefore);

      // Sync
      await commands.syncProfile('test-hub', 'test-profile');

      // Verify changes are gone after sync
      const changesAfter = await hubManager.hasProfileChanges('test-hub', 'test-profile');
      assert.strictEqual(changesAfter, false);
    });

    test('should handle sync for non-active profile', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });

      await assert.rejects(
        async () => await commands.syncProfile('test-hub', 'test-profile'),
        /not active|not activated/i
      );
    });
  });

  suite('Review And Sync', () => {
    test('should provide review dialog for changes', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update profile
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '1.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const result = await commands.reviewAndSync('test-hub', 'test-profile');
      assert.ok(result);
      assert.ok(result.dialog);
      assert.ok(result.dialog.title);
      assert.ok(result.dialog.options);
      assert.strictEqual(result.dialog.options.length, 3); // Sync, Review, Cancel
    });

    test('should return null when no changes to review', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      const result = await commands.reviewAndSync('test-hub', 'test-profile');
      assert.strictEqual(result, null);
    });
  });
});
