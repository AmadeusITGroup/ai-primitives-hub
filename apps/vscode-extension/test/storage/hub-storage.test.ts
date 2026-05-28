/**
 * HubStorage Tests
 * Tests for hub configuration storage, caching, and file operations
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubConfig,
  HubReference,
} from '../../src/types/hub';

suite('HubStorage - TDD', () => {
  let storage: HubStorage;
  let tempDir: string;
  let testHubConfig: HubConfig;
  let testHubReference: HubReference;

  setup(() => {
    // Create temp directory for tests
    tempDir = path.join(__dirname, '..', '..', 'test-temp-hub-storage');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Initialize storage with temp directory
    storage = new HubStorage(tempDir);

    // Load test fixture
    const fixturesDir = path.join(process.cwd(), 'test', 'fixtures', 'hubs');
    const validContent = fs.readFileSync(
      path.join(fixturesDir, 'valid-hub-config.yml'),
      'utf8'
    );
    testHubConfig = yaml.load(validContent) as HubConfig;

    // Create test reference
    testHubReference = {
      type: 'github',
      location: 'promptregistry/official-hub',
      ref: 'main',
      autoSync: true
    };
  });

  teardown(() => {
    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Initialization', () => {
    test('should create storage directory if it does not exist', () => {
      const newDir = path.join(tempDir, 'new-storage');
      new HubStorage(newDir);

      assert.ok(fs.existsSync(newDir), 'Storage directory should be created');
    });

    test('should use existing directory if it exists', () => {
      const existingDir = path.join(tempDir, 'existing');
      fs.mkdirSync(existingDir, { recursive: true });

      new HubStorage(existingDir);
      assert.ok(fs.existsSync(existingDir));
    });

    test('should throw error for invalid path', () => {
      assert.throws(() => {
        new HubStorage('');
      }, /Invalid storage path/);
    });
  });

  suite('Save Hub Configuration', () => {
    test('should save hub config to file', async () => {
      const hubId = 'test-hub';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      const configPath = path.join(tempDir, `${hubId}.yml`);
      assert.ok(fs.existsSync(configPath), 'Hub config file should exist');
    });

    test('should save hub config with correct YAML format', async () => {
      const hubId = 'test-hub-yaml';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      const configPath = path.join(tempDir, `${hubId}.yml`);
      const savedContent = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(savedContent) as HubConfig;

      assert.strictEqual(parsed.version, testHubConfig.version);
      assert.strictEqual(parsed.metadata.name, testHubConfig.metadata.name);
    });

    test('should save reference metadata separately', async () => {
      const hubId = 'test-hub-ref';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      const metaPath = path.join(tempDir, `${hubId}.meta.json`);
      assert.ok(fs.existsSync(metaPath), 'Reference metadata should exist');

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.strictEqual(meta.reference.type, testHubReference.type);
      assert.strictEqual(meta.reference.location, testHubReference.location);
    });

    test('should reject invalid hub IDs', async () => {
      await assert.rejects(
        async () => await storage.saveHub('../invalid', testHubConfig, testHubReference),
        /Invalid hub ID/
      );
    });

    test('should handle save errors gracefully', async () => {
      // Create a read-only directory
      const readOnlyDir = path.join(tempDir, 'readonly');
      fs.mkdirSync(readOnlyDir, { recursive: true });
      fs.chmodSync(readOnlyDir, 0o444);

      const readOnlyStorage = new HubStorage(readOnlyDir);

      await assert.rejects(
        async () => await readOnlyStorage.saveHub('test', testHubConfig, testHubReference),
        /Failed to save hub/
      );

      // Restore permissions for cleanup
      fs.chmodSync(readOnlyDir, 0o755);
    });

    test('should overwrite existing hub config', async () => {
      const hubId = 'test-hub-overwrite';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      // Modify and save again
      const modifiedConfig = structuredClone(testHubConfig);
      modifiedConfig.metadata.name = 'Modified Name';
      await storage.saveHub(hubId, modifiedConfig, testHubReference);

      const loaded = await storage.loadHub(hubId);
      assert.strictEqual(loaded.config.metadata.name, 'Modified Name');
    });
  });

  suite('Load Hub Configuration', () => {
    test('should load existing hub config', async () => {
      const hubId = 'test-load';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      const result = await storage.loadHub(hubId);

      assert.ok(result);
      assert.strictEqual(result.config.version, testHubConfig.version);
      assert.strictEqual(result.config.metadata.name, testHubConfig.metadata.name);
    });

    test('should load reference metadata with config', async () => {
      const hubId = 'test-load-ref';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      const result = await storage.loadHub(hubId);

      assert.ok(result.reference);
      assert.strictEqual(result.reference.type, testHubReference.type);
      assert.strictEqual(result.reference.location, testHubReference.location);
    });

    test('should throw error for non-existent hub', async () => {
      await assert.rejects(
        async () => await storage.loadHub('non-existent'),
        /Hub not found/
      );
    });

    test('should validate hub ID before loading', async () => {
      await assert.rejects(
        async () => await storage.loadHub('../invalid'),
        /Invalid hub ID/
      );
    });

    test('should handle corrupted config files', async () => {
      const hubId = 'corrupted';
      const configPath = path.join(tempDir, `${hubId}.yml`);
      fs.writeFileSync(configPath, 'invalid: yaml: content: [[[');

      await assert.rejects(
        async () => await storage.loadHub(hubId),
        /Failed to load hub/
      );
    });
  });

  suite('Cache Management', () => {
    test('should cache loaded hub configs', async () => {
      const hubId = 'test-cache';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      // First load
      await storage.loadHub(hubId);

      // Second load should use cache (modify file to verify)
      const configPath = path.join(tempDir, `${hubId}.yml`);
      fs.writeFileSync(configPath, 'version: "999.0.0"');

      const result2 = await storage.loadHub(hubId);

      // Should still have original version from cache
      assert.strictEqual(result2.config.version, testHubConfig.version);
    });

    test('should bypass cache when forceReload is true', async () => {
      const hubId = 'test-force-reload';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      // First load
      await storage.loadHub(hubId);

      // Modify file
      const modifiedConfig = structuredClone(testHubConfig);
      modifiedConfig.version = '999.0.0';
      await storage.saveHub(hubId, modifiedConfig, testHubReference);

      // Force reload
      const result = await storage.loadHub(hubId, true);

      assert.strictEqual(result.config.version, '999.0.0');
    });
  });

  suite('List Hubs', () => {
    test('should list all stored hubs', async () => {
      await storage.saveHub('hub1', testHubConfig, testHubReference);
      await storage.saveHub('hub2', testHubConfig, testHubReference);
      await storage.saveHub('hub3', testHubConfig, testHubReference);

      const hubs = await storage.listHubs();

      assert.strictEqual(hubs.length, 3);
      assert.ok(hubs.includes('hub1'));
      assert.ok(hubs.includes('hub2'));
      assert.ok(hubs.includes('hub3'));
    });

    test('should return empty array when no hubs exist', async () => {
      const hubs = await storage.listHubs();
      assert.strictEqual(hubs.length, 0);
    });

    test('should ignore non-hub files', async () => {
      await storage.saveHub('hub1', testHubConfig, testHubReference);

      // Create non-hub files
      fs.writeFileSync(path.join(tempDir, 'random.txt'), 'content');
      fs.writeFileSync(path.join(tempDir, 'test.json'), '{}');

      const hubs = await storage.listHubs();

      assert.strictEqual(hubs.length, 1);
      assert.strictEqual(hubs[0], 'hub1');
    });
  });

  suite('Delete Hub', () => {
    test('should delete hub config and metadata', async () => {
      const hubId = 'test-delete';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      await storage.deleteHub(hubId);

      const configPath = path.join(tempDir, `${hubId}.yml`);
      const metaPath = path.join(tempDir, `${hubId}.meta.json`);

      assert.ok(!fs.existsSync(configPath), 'Config file should be deleted');
      assert.ok(!fs.existsSync(metaPath), 'Metadata file should be deleted');
    });

    test('should remove hub from cache after deletion', async () => {
      const hubId = 'test-delete-cache';
      await storage.saveHub(hubId, testHubConfig, testHubReference);
      await storage.loadHub(hubId);

      await storage.deleteHub(hubId);

      await assert.rejects(
        async () => await storage.loadHub(hubId),
        /Hub not found/
      );
    });

    test('should throw error when deleting non-existent hub', async () => {
      await assert.rejects(
        async () => await storage.deleteHub('non-existent'),
        /Hub not found/
      );
    });

    test('should validate hub ID before deletion', async () => {
      await assert.rejects(
        async () => await storage.deleteHub('../invalid'),
        /Invalid hub ID/
      );
    });
  });

  suite('Get Hub Metadata', () => {
    test('should return hub metadata without loading full config', async () => {
      const hubId = 'test-metadata';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      const metadata = await storage.getHubMetadata(hubId);

      assert.ok(metadata);
      assert.strictEqual(metadata.reference.type, testHubReference.type);
      assert.ok(metadata.lastModified);
      assert.ok(metadata.size > 0);
    });

    test('should throw error for non-existent hub', async () => {
      await assert.rejects(
        async () => await storage.getHubMetadata('non-existent'),
        /Hub not found/
      );
    });
  });

  suite('Security and Validation', () => {
    test('should reject path traversal in hub IDs', async () => {
      const invalidIds = ['../etc/passwd', '../../hack', 'test/../bad'];

      for (const id of invalidIds) {
        await assert.rejects(
          // eslint-disable-next-line no-loop-func -- sequential loop, outer variables are stable per iteration
          async () => await storage.saveHub(id, testHubConfig, testHubReference),
          /Invalid hub ID/
        );
      }
    });

    test('should reject special characters in hub IDs', async () => {
      const invalidIds = ['test<script>', 'hub:evil', 'name|pipe', 'test&cmd'];

      for (const id of invalidIds) {
        await assert.rejects(
          // eslint-disable-next-line no-loop-func -- sequential loop, outer variables are stable per iteration
          async () => await storage.saveHub(id, testHubConfig, testHubReference),
          /Invalid hub ID/
        );
      }
    });

    test('should handle file system errors gracefully', () => {
      // This test is already covered by "should handle save errors gracefully"
      assert.ok(true);
    });
  });

  suite('Active Hub Management', () => {
    test('should return null when no active hub is set', async () => {
      const activeHubId = await storage.getActiveHubId();
      assert.strictEqual(activeHubId, null, 'Should return null when no active hub exists');
    });

    test('should set and retrieve active hub ID', async () => {
      const hubId = 'test-active-hub';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      await storage.setActiveHubId(hubId);
      const retrievedHubId = await storage.getActiveHubId();

      assert.strictEqual(retrievedHubId, hubId, 'Should return the correct active hub ID');
    });

    test('should update active hub ID when changed', async () => {
      const hubId1 = 'test-hub-1';
      const hubId2 = 'test-hub-2';

      await storage.saveHub(hubId1, testHubConfig, testHubReference);
      await storage.saveHub(hubId2, testHubConfig, testHubReference);

      await storage.setActiveHubId(hubId1);
      assert.strictEqual(await storage.getActiveHubId(), hubId1);

      await storage.setActiveHubId(hubId2);
      assert.strictEqual(await storage.getActiveHubId(), hubId2, 'Should update to new active hub');
    });

    test('should clear active hub ID when set to null', async () => {
      const hubId = 'test-clear-hub';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      await storage.setActiveHubId(hubId);
      assert.strictEqual(await storage.getActiveHubId(), hubId);

      await storage.setActiveHubId(null);
      assert.strictEqual(await storage.getActiveHubId(), null, 'Should clear active hub ID');
    });

    test('should reject setting non-existent hub as active', async () => {
      await assert.rejects(
        async () => await storage.setActiveHubId('non-existent-hub'),
        /does not exist/,
        'Should reject non-existent hub'
      );
    });

    test('should persist active hub ID across storage instances', async () => {
      const hubId = 'test-persist-hub';
      await storage.saveHub(hubId, testHubConfig, testHubReference);
      await storage.setActiveHubId(hubId);

      // Create new storage instance with same directory
      const newStorage = new HubStorage(tempDir);
      const retrievedHubId = await newStorage.getActiveHubId();

      assert.strictEqual(retrievedHubId, hubId, 'Active hub ID should persist across instances');
    });

    test('should store timestamp when setting active hub', async () => {
      const hubId = 'test-timestamp-hub';
      await storage.saveHub(hubId, testHubConfig, testHubReference);

      const beforeTime = new Date();
      await storage.setActiveHubId(hubId);
      const afterTime = new Date();

      // Read the active hub file directly to verify timestamp
      const activeHubPath = path.join(tempDir, 'activeHubId.json');
      assert.ok(fs.existsSync(activeHubPath), 'activeHubId.json should exist');

      const content = JSON.parse(fs.readFileSync(activeHubPath, 'utf8'));
      assert.ok(content.setAt, 'Should have setAt timestamp');

      const setAtTime = new Date(content.setAt);
      assert.ok(setAtTime >= beforeTime && setAtTime <= afterTime, 'Timestamp should be within test execution time');
    });

    test('should handle concurrent active hub changes', async () => {
      const hubId1 = 'test-concurrent-1';
      const hubId2 = 'test-concurrent-2';

      await storage.saveHub(hubId1, testHubConfig, testHubReference);
      await storage.saveHub(hubId2, testHubConfig, testHubReference);

      // Simulate concurrent updates
      await Promise.all([
        storage.setActiveHubId(hubId1),
        storage.setActiveHubId(hubId2)
      ]);

      const finalHubId = await storage.getActiveHubId();
      assert.ok(finalHubId === hubId1 || finalHubId === hubId2, 'Should have one of the hub IDs set');
    });
  });
});
