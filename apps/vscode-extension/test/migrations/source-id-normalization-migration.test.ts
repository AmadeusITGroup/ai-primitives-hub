/**
 * Unit tests for sourceId normalization migration
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  MIGRATION_NAME,
  runSourceIdNormalizationMigration,
} from '../../src/migrations/source-id-normalization-migration';
import {
  MigrationRegistry,
} from '../../src/services/migration-registry';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';
import {
  generateHubSourceId,
  generateLegacyHubSourceId,
} from '../../src/utils/source-id-utils';

suite('sourceIdNormalizationMigration', () => {
  let sandbox: sinon.SinonSandbox;
  let mockContext: vscode.ExtensionContext;
  let globalStateData: Map<string, any>;
  let storage: RegistryStorage;
  let migrationRegistry: MigrationRegistry;

  // Temp directory for storage (unique per run to avoid collisions)
  let tmpDir: string;

  setup(async () => {
    sandbox = sinon.createSandbox();
    globalStateData = new Map();

    // Use a unique temp directory per test to avoid cross-test contamination
    tmpDir = path.join(__dirname, '..', '..', `.test-tmp-migration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    // Always start clean
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    mockContext = {
      globalState: {
        get: (key: string, defaultValue?: any) => globalStateData.get(key) ?? defaultValue,
        update: (key: string, value: any) => {
          globalStateData.set(key, value);
        },
        keys: () => Array.from(globalStateData.keys()),
        setKeysForSync: sandbox.stub()
      } as any,
      globalStorageUri: vscode.Uri.file(tmpDir),
      extensionPath: '/mock/extension',
      extensionUri: vscode.Uri.file('/mock/extension'),
      subscriptions: [],
      extensionMode: 1 as any
    } as any as vscode.ExtensionContext;

    MigrationRegistry.resetInstance();
    migrationRegistry = MigrationRegistry.getInstance(mockContext);

    storage = new RegistryStorage(mockContext);
    await storage.initialize();
  });

  teardown(() => {
    sandbox.restore();
    MigrationRegistry.resetInstance();

    // Clean up temp directory
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('should skip migration if already completed', async () => {
    await migrationRegistry.markMigrationComplete(MIGRATION_NAME);

    // Should not throw even if storage has no sources
    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    const state = await migrationRegistry.getMigrationState();
    assert.strictEqual(state[MIGRATION_NAME]?.status, 'completed');
  });

  test('should complete migration with no sources needing update', async () => {
    // Config starts with empty sources
    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    const state2 = await migrationRegistry.getMigrationState();
    assert.strictEqual(state2[MIGRATION_NAME]?.status, 'completed');
  });

  test('should migrate a source with legacy ID to new ID', async () => {
    // Create a source with a mixed-case URL
    const url = 'https://github.com/Owner/Repo';
    const sourceType = 'github';

    // The legacy ID was computed with host-only lowercase normalization
    const legacyId = generateLegacyHubSourceId(sourceType, url);
    assert.ok(legacyId, 'Legacy ID should differ for mixed-case URL');

    const newId = generateHubSourceId(sourceType, url);
    assert.notStrictEqual(legacyId, newId, 'Legacy and new IDs should differ');

    // Add a source with the legacy ID to config
    const config = await storage.loadConfig();
    config.sources.push({
      id: legacyId,
      name: 'Test Source',
      type: sourceType,
      url: url,
      enabled: true,
      priority: 1
    });
    await storage.saveConfig(config);

    // Run migration
    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    // Verify the source ID was updated
    const sources = await storage.getSources();
    const migratedSource = sources.find((s) => s.name === 'Test Source');
    assert.ok(migratedSource, 'Source should still exist');
    assert.strictEqual(migratedSource.id, newId, 'Source ID should be updated to new format');
  });

  test('should not migrate sources that already have new-format IDs', async () => {
    const url = 'https://github.com/owner/repo'; // all lowercase
    const sourceType = 'github';
    const currentId = generateHubSourceId(sourceType, url);

    const config = await storage.loadConfig();
    config.sources.push({
      id: currentId,
      name: 'Already Migrated',
      type: sourceType,
      url: url,
      enabled: true,
      priority: 1
    });
    await storage.saveConfig(config);

    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    const sources = await storage.getSources();
    const source = sources.find((s) => s.name === 'Already Migrated');
    assert.strictEqual(source!.id, currentId, 'ID should remain unchanged');
  });

  test('should not migrate non-hub source IDs', async () => {
    const config = await storage.loadConfig();
    config.sources.push({
      id: 'my-custom-source', // not hub-generated format
      name: 'Custom Source',
      type: 'local',
      url: 'file:///path/to/source',
      enabled: true,
      priority: 1
    });
    await storage.saveConfig(config);

    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    const sources = await storage.getSources();
    const source = sources.find((s) => s.name === 'Custom Source');
    assert.strictEqual(source!.id, 'my-custom-source', 'Non-hub ID should remain unchanged');
  });

  test('should rename source cache files during migration', async () => {
    const url = 'https://github.com/Owner/Repo';
    const sourceType = 'github';
    const legacyId = generateLegacyHubSourceId(sourceType, url)!;
    const newId = generateHubSourceId(sourceType, url);

    // Add source with legacy ID
    const config = await storage.loadConfig();
    config.sources.push({
      id: legacyId,
      name: 'Cache Test',
      type: sourceType,
      url: url,
      enabled: true,
      priority: 1
    });
    await storage.saveConfig(config);

    // Create a cache file with the legacy ID
    const paths = storage.getPaths();
    const legacyCacheFile = path.join(paths.sourcesCache, `${legacyId}.json`);
    fs.writeFileSync(legacyCacheFile, JSON.stringify([{ id: 'bundle-1' }]));

    // Run migration
    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    // Old cache file should be gone, new one should exist
    const newCacheFile = path.join(paths.sourcesCache, `${newId}.json`);
    assert.strictEqual(fs.existsSync(legacyCacheFile), false, 'Legacy cache file should be removed');
    assert.strictEqual(fs.existsSync(newCacheFile), true, 'New cache file should exist');
  });

  test('should update installation records referencing old sourceId', async () => {
    const url = 'https://github.com/Owner/Repo';
    const sourceType = 'github';
    const legacyId = generateLegacyHubSourceId(sourceType, url)!;
    const newId = generateHubSourceId(sourceType, url);

    // Add source with legacy ID
    const config = await storage.loadConfig();
    config.sources.push({
      id: legacyId,
      name: 'Install Test',
      type: sourceType,
      url: url,
      enabled: true,
      priority: 1
    });
    await storage.saveConfig(config);

    // Create an installation record referencing the legacy sourceId
    const paths = storage.getPaths();
    const installFile = path.join(paths.userInstalled, 'test-bundle.json');
    fs.writeFileSync(installFile, JSON.stringify({
      bundleId: 'test-bundle',
      sourceId: legacyId,
      version: '1.0.0'
    }));

    // Run migration
    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    // Installation record should reference the new sourceId
    const updatedRecord = JSON.parse(fs.readFileSync(installFile, 'utf8'));
    assert.strictEqual(updatedRecord.sourceId, newId, 'Installation record sourceId should be updated');
  });

  test('should be idempotent - second run is a no-op', async () => {
    const url = 'https://github.com/Owner/Repo';
    const sourceType = 'github';
    const legacyId = generateLegacyHubSourceId(sourceType, url)!;
    const newId = generateHubSourceId(sourceType, url);

    const config = await storage.loadConfig();
    config.sources.push({
      id: legacyId,
      name: 'Idempotent Test',
      type: sourceType,
      url: url,
      enabled: true,
      priority: 1
    });
    await storage.saveConfig(config);

    // First run
    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    const sourcesAfterFirst = await storage.getSources();
    const migratedFirst = sourcesAfterFirst.find((s) => s.name === 'Idempotent Test');
    assert.ok(migratedFirst, 'Source should exist after first run');
    assert.strictEqual(migratedFirst.id, newId);

    // Second run (should be skipped via MigrationRegistry)
    await runSourceIdNormalizationMigration(storage, migrationRegistry);

    const sourcesAfterSecond = await storage.getSources();
    const migratedSecond = sourcesAfterSecond.find((s) => s.name === 'Idempotent Test');
    assert.ok(migratedSecond, 'Source should exist after second run');
    assert.strictEqual(migratedSecond.id, newId, 'ID should still be new format after second run');
  });
});
