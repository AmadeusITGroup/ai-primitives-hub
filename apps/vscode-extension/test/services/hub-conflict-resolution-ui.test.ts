/**
 * Test Suite: Hub Conflict Resolution UI
 *
 * Tests UI formatting and interaction for profile change conflicts.
 * Covers change display, conflict resolution dialogs, and user choice handling.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

suite('Hub Conflict Resolution UI', () => {
  let storage: HubStorage;
  let hubManager: HubManager;
  let tempDir: string;

  const createTestHub = (): HubConfig => {
    return {
      version: '1.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub for conflict resolution',
        maintainer: 'test@example.com',
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
          name: 'Test Profile',
          description: 'Test profile',
          icon: 'test-icon',
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
    };
  };

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-conflict-ui-test-'));
    storage = new HubStorage(tempDir);
    hubManager = new HubManager(storage, {} as any, process.cwd(), undefined, undefined);
    (hubManager as any).storage = storage;
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Change Summary Formatting', () => {
    test('should format bundle additions', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Add bundle
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '2.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      const summary = hubManager.formatChangeSummary(changes!);

      assert.ok(summary.includes('bundle-2'));
      assert.ok(summary.includes('Added'));
      assert.ok(summary.includes('2.0.0'));
    });

    test('should format bundle removals', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Remove bundle
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles = [];
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      const summary = hubManager.formatChangeSummary(changes!);

      assert.ok(summary.includes('bundle-1'));
      assert.ok(summary.includes('Removed'));
    });

    test('should format bundle updates', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update bundle
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles[0].version = '2.0.0';
      updated.config.profiles[0].updatedAt = new Date().toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      const summary = hubManager.formatChangeSummary(changes!);

      assert.ok(summary.includes('bundle-1'));
      assert.ok(summary.includes('Updated'));
      assert.ok(summary.includes('2.0.0'));
    });

    test('should format metadata changes', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update metadata
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].name = 'Updated Name';
      updated.config.profiles[0].updatedAt = new Date().toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      const summary = hubManager.formatChangeSummary(changes!);

      assert.ok(summary.includes('Metadata'));
      assert.ok(summary.includes('name'));
    });

    test('should format comprehensive changes', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

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
      updated.config.profiles[0].updatedAt = new Date().toISOString();
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      const summary = hubManager.formatChangeSummary(changes!);

      // Should include all change types
      assert.ok(summary.includes('Added'));
      assert.ok(summary.includes('Updated'));
      assert.ok(summary.includes('Metadata'));
    });
  });

  suite('Conflict Resolution Dialog', () => {
    test('should create conflict resolution dialog', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Add bundle
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '2.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      const dialog = hubManager.createConflictResolutionDialog(changes!);

      assert.ok(dialog);
      assert.ok(dialog.title);
      assert.ok(dialog.options);
      assert.ok(dialog.options.length >= 2); // Accept All, Reject All
    });

    test('should include sync action option', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Add bundle
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '2.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      const dialog = hubManager.createConflictResolutionDialog(changes!);

      const syncOption = dialog.options.find((opt) => opt.label.includes('Sync'));
      assert.ok(syncOption);
    });

    test('should include review option', async () => {
      const hub = createTestHub();
      await storage.saveHub('test-hub', hub, { type: 'github', location: 'test/repo' });
      await hubManager.activateProfile('test-hub', 'profile-1', { installBundles: false });

      // Add bundle
      const updated = await storage.loadHub('test-hub');
      updated.config.profiles[0].bundles.push({
        id: 'bundle-2',
        version: '2.0.0',
        source: 'test-source',
        required: false
      });
      await storage.saveHub('test-hub', updated.config, updated.reference);

      const changes = await hubManager.getProfileChanges('test-hub', 'profile-1');
      const dialog = hubManager.createConflictResolutionDialog(changes!);

      const reviewOption = dialog.options.find((opt) => opt.label.includes('Review'));
      assert.ok(reviewOption);
    });
  });
});
