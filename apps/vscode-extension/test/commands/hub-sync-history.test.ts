import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  HubSyncHistory,
  SyncHistoryEntry,
} from '../../src/commands/hub-sync-history';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  HubStorage,
} from '../../src/storage/hub-storage';

suite('Hub Sync History', () => {
  let storage: HubStorage;
  let hubManager: HubManager;
  let syncHistory: HubSyncHistory;
  let testDir: string;

  setup(() => {
    const globalStorageUri = vscode.Uri.file(path.join(__dirname, '../../test-workspace', '.test-storage'));
    testDir = globalStorageUri.fsPath;

    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    storage = new HubStorage(testDir);
    hubManager = new HubManager(storage, {} as any, process.cwd(), undefined, undefined);
    syncHistory = new HubSyncHistory(hubManager);
  });

  teardown(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const createTestHub = async (hubId: string) => {
    const hubConfig = {
      version: '1.0.0',
      metadata: {
        name: 'Test Hub',
        description: 'Test hub for sync history',
        maintainer: 'test@example.com',
        updatedAt: new Date().toISOString()
      },
      sources: [
        {
          id: 'test-source',
          name: 'Test Source',
          type: 'github' as const,
          url: 'github:test/repo',
          enabled: true,
          priority: 1,
          metadata: { description: 'Test source' }
        }
      ],
      profiles: [
        {
          id: 'test-profile',
          name: 'Test Profile',
          description: 'Test profile',
          icon: 'test-icon',
          active: false,
          createdAt: new Date().toISOString(),
          bundles: [
            {
              id: 'bundle-1',
              version: '1.0.0',
              source: 'test-source',
              required: false
            }
          ],
          updatedAt: new Date().toISOString()
        }
      ]
    };

    const reference = {
      type: 'github' as const,
      location: 'github:test/hub-repo',
      branch: 'main'
    };

    await storage.saveHub(hubId, hubConfig, reference);
  };

  suite('Record Sync Operation', () => {
    test('should record successful sync operation', async () => {
      const changes = {
        added: [],
        updated: [],
        removed: [],
        metadataChanged: false
      };
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      await syncHistory.recordSync('test-hub', 'test-profile', changes, previousState, 'success');

      const history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].hubId, 'test-hub');
      assert.strictEqual(history[0].profileId, 'test-profile');
      assert.strictEqual(history[0].status, 'success');
      assert.strictEqual(history[0].changes.added.length, 0);
      assert.strictEqual(history[0].changes.updated.length, 0);
      assert.strictEqual(history[0].changes.removed.length, 0);
    });

    test('should record sync with bundle additions', async () => {
      const changes = {
        added: [{ id: 'bundle-2', version: '1.0.0', source: 'test-source', required: false }],
        updated: [],
        removed: [],
        metadataChanged: false
      };
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      await syncHistory.recordSync('test-hub', 'test-profile', changes, previousState, 'success');

      const history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].changes.added.length, 1);
      assert.strictEqual(history[0].changes.added[0].id, 'bundle-2');
      assert.strictEqual(history[0].changes.added[0].version, '1.0.0');
    });

    test('should record sync with bundle updates', async () => {
      const changes = {
        added: [],
        updated: [{ id: 'bundle-1', oldVersion: '1.0.0', newVersion: '2.0.0' }],
        removed: [],
        metadataChanged: false
      };
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      await syncHistory.recordSync('test-hub', 'test-profile', changes, previousState, 'success');

      const history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].changes.updated.length, 1);
      assert.strictEqual(history[0].changes.updated[0].id, 'bundle-1');
      assert.strictEqual(history[0].changes.updated[0].oldVersion, '1.0.0');
      assert.strictEqual(history[0].changes.updated[0].newVersion, '2.0.0');
    });

    test('should record sync with bundle removals', async () => {
      const changes = {
        added: [],
        updated: [],
        removed: ['bundle-1'],
        metadataChanged: false
      };
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      await syncHistory.recordSync('test-hub', 'test-profile', changes, previousState, 'success');

      const history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].changes.removed.length, 1);
      assert.strictEqual(history[0].changes.removed[0], 'bundle-1');
    });

    test('should record metadata changes in sync', async () => {
      const changes = {
        added: [],
        updated: [],
        removed: [],
        metadataChanged: true
      };
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      await syncHistory.recordSync('test-hub', 'test-profile', changes, previousState, 'success');

      const history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].changes.metadataChanged, true);
    });
  });

  suite('Get Sync History', () => {
    test('should return empty array for profile with no sync history', async () => {
      const history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 0);
    });

    test('should return sync history in chronological order', async () => {
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      // First sync
      await syncHistory.recordSync(
        'test-hub',
        'test-profile',
        {
          added: [{ id: 'bundle-2', version: '1.0.0', source: 'test-source', required: false }],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState,
        'success'
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second sync
      await syncHistory.recordSync(
        'test-hub',
        'test-profile',
        {
          added: [{ id: 'bundle-3', version: '1.0.0', source: 'test-source', required: false }],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState,
        'success'
      );

      const history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 2);
      // Most recent first
      assert.ok(new Date(history[0].timestamp) >= new Date(history[1].timestamp));
      assert.strictEqual(history[0].changes.added[0].id, 'bundle-3');
      assert.strictEqual(history[1].changes.added[0].id, 'bundle-2');
    });

    test('should limit history to specified count', async () => {
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      // Create 5 sync operations
      for (let i = 0; i < 5; i++) {
        await syncHistory.recordSync(
          'test-hub',
          'test-profile',
          {
            added: [{ id: `bundle-${i + 2}`, version: '1.0.0', source: 'test-source', required: false }],
            updated: [],
            removed: [],
            metadataChanged: false
          },
          previousState,
          'success'
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const history = await syncHistory.getHistory('test-hub', 'test-profile', 3);
      assert.strictEqual(history.length, 3);
    });
  });

  suite('Format History Entry', () => {
    test('should format history entry with all change types', () => {
      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [{ id: 'bundle-2', version: '1.0.0', source: 'test-source', required: false }],
          updated: [{ id: 'bundle-1', oldVersion: '1.0.0', newVersion: '2.0.0' }],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [],
          activatedAt: new Date().toISOString()
        }
      };

      const formatted = syncHistory.formatHistoryEntry(entry);

      assert.ok(formatted.includes('bundle-1 — Updated (1.0.0 → 2.0.0)'));
      assert.ok(formatted.includes('bundle-2 (1.0.0) — Added [NEW]'));
    });

    test('should format history entry with timestamp', () => {
      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [],
          activatedAt: new Date().toISOString()
        }
      };

      const formatted = syncHistory.formatHistoryEntry(entry);

      assert.ok(formatted.includes('Synced at:'));
      assert.ok(formatted.includes(new Date(entry.timestamp).toLocaleString()));
    });

    test('should format history entry with status', () => {
      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [],
          activatedAt: new Date().toISOString()
        }
      };

      const formatted = syncHistory.formatHistoryEntry(entry);

      assert.ok(formatted.includes('Status: success'));
    });
  });

  suite('Create History QuickPick Items', () => {
    test('should create QuickPick items for history entries', () => {
      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [{ id: 'bundle-2', version: '1.0.0', source: 'test-source', required: false }],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [],
          activatedAt: new Date().toISOString()
        }
      };

      const items = syncHistory.createHistoryQuickPickItems([entry]);

      assert.strictEqual(items.length, 1);
      assert.ok(items[0].label.includes('1 change'));
      assert.strictEqual(items[0].entry, entry);
    });

    test('should include change summary in QuickPick description', () => {
      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [{ id: 'bundle-2', version: '1.0.0', source: 'test-source', required: false }],
          updated: [{ id: 'bundle-1', oldVersion: '1.0.0', newVersion: '2.0.0' }],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [],
          activatedAt: new Date().toISOString()
        }
      };

      const items = syncHistory.createHistoryQuickPickItems([entry]);

      assert.ok(items[0].description?.includes('1 added'));
      assert.ok(items[0].description?.includes('1 updated'));
    });

    test('should format timestamps in QuickPick items', () => {
      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [],
          activatedAt: new Date().toISOString()
        }
      };

      const items = syncHistory.createHistoryQuickPickItems([entry]);

      // Should include formatted date
      assert.ok(items[0].label.match(/\d{4}-\d{2}-\d{2}/));
    });
  });

  suite('Rollback to History Entry', () => {
    test('should rollback profile to previous state', async () => {
      await createTestHub('test-hub');
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [
            { id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false },
            { id: 'bundle-2', version: '1.0.0', source: 'test-source', required: false }
          ],
          activatedAt: new Date().toISOString()
        }
      };

      await syncHistory.rollbackToEntry('test-hub', 'test-profile', entry, { installBundles: false });

      const state = await storage.getProfileActivationState('test-hub', 'test-profile');
      assert.ok(state);
      assert.strictEqual(state.syncedBundles.length, 2);
      assert.ok(state.syncedBundles.includes('bundle-1'));
      assert.ok(state.syncedBundles.includes('bundle-2'));
    });

    test('should record rollback as new history entry', async () => {
      await createTestHub('test-hub');
      await hubManager.activateProfile('test-hub', 'test-profile', { installBundles: false });

      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
          activatedAt: new Date().toISOString()
        }
      };

      const historyBefore = await syncHistory.getHistory('test-hub', 'test-profile');
      await syncHistory.rollbackToEntry('test-hub', 'test-profile', entry, { installBundles: false });

      const historyAfter = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(historyAfter.length, historyBefore.length + 1);
      assert.strictEqual(historyAfter[0].status, 'rollback');
    });

    test('should throw error when rolling back non-active profile', async () => {
      await createTestHub('test-hub');

      const entry: SyncHistoryEntry = {
        hubId: 'test-hub',
        profileId: 'test-profile',
        timestamp: new Date().toISOString(),
        status: 'success',
        changes: {
          added: [],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState: {
          bundles: [],
          activatedAt: new Date().toISOString()
        }
      };

      await assert.rejects(
        async () => await syncHistory.rollbackToEntry('test-hub', 'test-profile', entry, { installBundles: false }),
        /Profile test-profile is not active in hub test-hub/
      );
    });
  });

  suite('Clear History', () => {
    test('should clear all history for a profile', async () => {
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      // Create some history
      for (let i = 0; i < 3; i++) {
        await syncHistory.recordSync(
          'test-hub',
          'test-profile',
          {
            added: [{ id: `bundle-${i + 2}`, version: '1.0.0', source: 'test-source', required: false }],
            updated: [],
            removed: [],
            metadataChanged: false
          },
          previousState,
          'success'
        );
      }

      let history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 3);

      await syncHistory.clearHistory('test-hub', 'test-profile');

      history = await syncHistory.getHistory('test-hub', 'test-profile');
      assert.strictEqual(history.length, 0);
    });

    test('should clear history only for specified profile', async () => {
      const previousState = {
        bundles: [{ id: 'bundle-1', version: '1.0.0', source: 'test-source', required: false }],
        activatedAt: new Date().toISOString()
      };

      // Create history for profile 1
      await syncHistory.recordSync(
        'test-hub',
        'test-profile',
        {
          added: [{ id: 'bundle-2', version: '1.0.0', source: 'test-source', required: false }],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState,
        'success'
      );

      // Create history for profile 2
      await syncHistory.recordSync(
        'test-hub',
        'test-profile-2',
        {
          added: [{ id: 'bundle-3', version: '1.0.0', source: 'test-source', required: false }],
          updated: [],
          removed: [],
          metadataChanged: false
        },
        previousState,
        'success'
      );

      // Clear history for first profile only
      await syncHistory.clearHistory('test-hub', 'test-profile');

      const history1 = await syncHistory.getHistory('test-hub', 'test-profile');
      const history2 = await syncHistory.getHistory('test-hub', 'test-profile-2');

      assert.strictEqual(history1.length, 0);
      assert.strictEqual(history2.length, 1);
    });
  });
});
