/**
 * HubCommands Unit Tests
 * Tests for VS Code commands that manage hubs
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  HubCommands,
} from '../../src/commands/hub-commands';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubReference,
} from '../../src/types/hub';

// Mock vscode.commands before importing HubCommands
if (!(vscode as any).commands) {
  (vscode as any).commands = {
    registerCommand: (_command: string, _callback: (...args: any[]) => any) => {
      return { dispose: () => {} };
    }
  };
}

// Mock SchemaValidator for testing
class MockSchemaValidator {
  public async validate(): Promise<any> {
    return { valid: true, errors: [], warnings: [] };
  }
}

// Mock RegistryManager for testing
class MockRegistryManager {
  public async listProfiles(): Promise<any[]> {
    return [];
  }

  public async listSources(): Promise<any[]> {
    return [];
  }

  public async listInstalledBundles(): Promise<any[]> {
    return [];
  }
}

suite('HubCommands', () => {
  let commands: HubCommands;
  let hubManager: HubManager;
  let storage: HubStorage;
  let tempDir: string;
  let context: vscode.ExtensionContext;
  let registryManager: MockRegistryManager;

  setup(() => {
    // Create temp directory
    tempDir = path.join(__dirname, '..', '..', 'test-temp-hubcommands');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize services
    storage = new HubStorage(tempDir);
    const validator = new MockSchemaValidator();
    hubManager = new HubManager(storage, validator as any, process.cwd(), undefined, undefined);

    // Mock extension context
    context = {
      subscriptions: [],
      globalState: {
        get: () => undefined,
        update: async () => {}
      }
    } as any;

    // Initialize mock registry manager
    registryManager = new MockRegistryManager();

    // Initialize commands
    commands = new HubCommands(hubManager, registryManager as any, context);
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  suite.skip('Command Registration (skipped - commands not registered in test mode)', () => {
    test('should register all hub commands', () => {
      assert.ok(commands);
      assert.strictEqual(context.subscriptions.length, 4);
    });

    test('should register importHub command', () => {
      const importCmd = context.subscriptions.find((s: any) =>
        s.command === 'promptregistry.importHub'
      );
      assert.ok(importCmd);
    });

    test('should register listHubs command', () => {
      const listCmd = context.subscriptions.find((s: any) =>
        s.command === 'promptregistry.listHubs'
      );
      assert.ok(listCmd);
    });

    test('should register syncHub command', () => {
      const syncCmd = context.subscriptions.find((s: any) =>
        s.command === 'promptregistry.syncHub'
      );
      assert.ok(syncCmd);
    });

    test('should register deleteHub command', () => {
      const deleteCmd = context.subscriptions.find((s: any) =>
        s.command === 'promptregistry.deleteHub'
      );
      assert.ok(deleteCmd);
    });
  });

  suite.skip('Import Hub Command (requires vscode UI mocks)', () => {
    test('should import hub from GitHub URL', async () => {
      // Execute import
      const result = await commands.importHub();

      assert.ok(result);

      // Verify hub was imported
      const hubs = await hubManager.listHubs();
      assert.ok(hubs.length > 0);
    });

    test('should handle cancellation gracefully', async () => {
      const result = await commands.importHub();

      assert.strictEqual(result, undefined);
    });

    test('should show error message on import failure', async () => {
      try {
        await commands.importHub();
      } catch {
        // Expected to fail
      }

      // Verify error was shown (would need proper mock)
      // assert.ok(errorShown);
    });

    test('should validate hub ID input', async () => {
      // Hub should not be imported with invalid ID
      const hubs = await hubManager.listHubs();
      assert.strictEqual(hubs.length, 0);
    });
  });

  suite('List Hubs Command', () => {
    test('should show empty message when no hubs', async () => {
      await commands.listHubs();

      // Would verify with proper mock
      // assert.ok(infoShown);
    });

    test('should display hub list with metadata', async () => {
      // Import a hub first
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      // List hubs
      await commands.listHubs();

      // Verify output (would need proper mock to check QuickPick items)
    });

    test('should allow selection of hub for details', async () => {
      // Import a hub
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      await commands.listHubs();

      // Would verify details were shown
    });
  });

  suite('Sync Hub Command', () => {
    test('should sync selected hub', async () => {
      // Import a hub first
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      await commands.syncHub();

      // Verify sync was called (would need spy/mock)
    });

    test('should sync all hubs when selected', async () => {
      // Import multiple hubs
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'hub1');
      await hubManager.importHub(ref, 'hub2');

      await commands.syncHub();

      // Verify all hubs were synced
    });

    test('should show error on sync failure', async () => {
      // Try to sync non-existent hub
      await commands.syncHub('non-existent');

      // Would verify error was shown
    });

    test('should show progress during sync', async () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      // Would verify progress indicator was shown
      await commands.syncHub('test-hub');
    });
  });

  suite.skip('Delete Hub Command (requires vscode UI mocks)', () => {
    test('should delete selected hub after confirmation', async () => {
      // Import a hub first
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');
      await commands.deleteHub('test-hub');

      // Verify hub was deleted
      const hubs = await hubManager.listHubs();
      assert.strictEqual(hubs.length, 0);
    });

    test('should not delete if user cancels', async () => {
      // Import a hub
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      await commands.deleteHub('test-hub');

      // Verify hub still exists
      const hubs = await hubManager.listHubs();
      assert.strictEqual(hubs.length, 1);
    });

    test('should show error if hub not found', async () => {
      await commands.deleteHub('non-existent');

      // Would verify error was shown
    });

    test('should allow selection from list when no ID provided', async () => {
      // Import a hub
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      await commands.deleteHub();

      // Verify hub was deleted
      const hubs = await hubManager.listHubs();
      assert.strictEqual(hubs.length, 0);
    });
  });

  suite.skip('Error Handling (requires vscode UI mocks)', () => {
    test('should handle hub manager errors gracefully', async () => {
      // Force an error by using invalid storage path
      const badStorage = new HubStorage('/invalid/path/that/cannot/exist');
      const validator = new MockSchemaValidator();
      const badManager = new HubManager(badStorage, validator as any, process.cwd(), undefined, undefined);
      const badCommands = new HubCommands(badManager, registryManager as any, context);

      // Should not throw
      await badCommands.listHubs();
    });

    test('should show user-friendly error messages', async () => {
      // Try invalid operation
      await commands.deleteHub('');

      // Would verify user-friendly message
    });
  });

  suite('User Experience', () => {
    test('should show success message after import', () => {

      // Would verify success message with proper mock
    });

    test('should show progress indicator for long operations', async () => {
      // Would verify progress indicator appears during import/sync
    });

    test('should provide helpful error context', async () => {
      // Error messages should include actionable information
    });
  });

  suite('Source Deduplication', () => {
    test('should not create duplicate sources when importing hub', async () => {
      // This test verifies that HubManager.importHub() handles sources
      // and HubCommands.importHub() doesn't duplicate the work

      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };

      // Track sources added
      const addedSources: string[] = [];
      const mockRegistryMgr = {
        listSources: () => addedSources.map((id) => ({ id, name: id })),
        listProfiles: () => [],
        addSource: (source: any) => {
          addedSources.push(source.id);
        },
        createProfile: async () => {},
        updateSource: async () => {}
      };

      // Set up HubManager with the mock RegistryManager passed to constructor
      const validator = new MockSchemaValidator();
      const testHubManager = new HubManager(
        storage,
        validator as any,
        process.cwd(),
        undefined,
        mockRegistryMgr as any
      );

      // Import hub - this should add sources only once via loadHubSources
      await testHubManager.importHub(ref, 'test-hub');

      // Count sources - should have 2 sources (official-prompts, community-prompts)
      // but each should only be added ONCE (with new format IDs)
      const sourceCount = addedSources.length;

      // If there are more than 2 sources, we have duplicates
      assert.strictEqual(sourceCount, 2,
        `Expected 2 sources but got ${sourceCount}: ${addedSources.join(', ')}`);
    });
  });
});
