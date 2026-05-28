/**
 * Hub Source Loading Tests
 * Tests for loading hub sources into RegistryManager and duplicate detection
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  ValidationResult,
} from '../../src/services/schema-validator';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubConfig,
  HubReference,
} from '../../src/types/hub';
import {
  RegistrySource,
} from '../../src/types/registry';
import {
  generateHubSourceId,
} from '../../src/utils/source-id-utils';

// Mock SchemaValidator for unit tests
class MockSchemaValidator {
  public async validate(_data: any, _schemaPath: string): Promise<ValidationResult> {
    return {
      valid: true,
      errors: [],
      warnings: []
    };
  }
}

// Mock RegistryManager for tracking source operations
class MockRegistryManager {
  private sources: RegistrySource[] = [];
  public addSourceCalls: RegistrySource[] = [];
  public updateSourceCalls: { id: string; updates: Partial<RegistrySource> }[] = [];

  public async listSources(): Promise<RegistrySource[]> {
    return [...this.sources];
  }

  public async addSource(source: RegistrySource): Promise<void> {
    this.sources.push(source);
    this.addSourceCalls.push(source);
  }

  public async updateSource(id: string, updates: Partial<RegistrySource>): Promise<void> {
    const index = this.sources.findIndex((s) => s.id === id);
    if (index !== -1) {
      this.sources[index] = { ...this.sources[index], ...updates };
      this.updateSourceCalls.push({ id, updates });
    }
  }

  public reset(): void {
    this.sources = [];
    this.addSourceCalls = [];
    this.updateSourceCalls = [];
  }

  public getSourceCount(): number {
    return this.sources.length;
  }

  public hasSource(id: string): boolean {
    return this.sources.some((s) => s.id === id);
  }
}

suite('Hub Source Loading', () => {
  let hubManager: HubManager;
  let storage: HubStorage;
  let mockValidator: MockSchemaValidator;
  let mockRegistry: MockRegistryManager;
  let tempDir: string;

  setup(() => {
    // Create temp directory
    tempDir = path.join(__dirname, '..', '..', 'test-temp-hub-source-loading');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize services
    storage = new HubStorage(tempDir);
    mockValidator = new MockSchemaValidator();
    mockRegistry = new MockRegistryManager();
    hubManager = new HubManager(
      storage,
      mockValidator as any,
      process.cwd(),
      undefined,
      mockRegistry as any
    );
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  suite('Source Loading Basics', () => {
    test('should load enabled sources from hub into registry', async () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
      const ref: HubReference = {
        type: 'local',
        location: fixturePath
      };

      await hubManager.importHub(ref, 'test-hub');

      // Verify sources were loaded
      const sources = await mockRegistry.listSources();
      assert.strictEqual(sources.length, 2, 'Should have 2 sources loaded');

      // Compute expected sourceIds using the new format
      const expectedSource1Id = generateHubSourceId('awesome-copilot', 'https://github.com/github/awesome-copilot');
      const expectedSource2Id = generateHubSourceId('awesome-copilot', 'https://github.com/org/other-repo');

      // Check source IDs use new format (type-hash)
      assert.ok(sources.some((s) => s.id === expectedSource1Id), `Should have source with id ${expectedSource1Id}`);
      assert.ok(sources.some((s) => s.id === expectedSource2Id), `Should have source with id ${expectedSource2Id}`);

      // Verify source properties
      const source1 = sources.find((s) => s.id === expectedSource1Id);
      assert.ok(source1, 'Source 1 should exist');
      assert.strictEqual(source1.name, 'Source 1');
      assert.strictEqual(source1.type, 'awesome-copilot');
      assert.strictEqual(source1.url, 'https://github.com/github/awesome-copilot');
      assert.strictEqual(source1.hubId, 'test-hub');
    });

    test('should skip disabled sources', async () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-disabled-source.yml');
      const ref: HubReference = {
        type: 'local',
        location: fixturePath
      };

      await hubManager.importHub(ref, 'test-hub-disabled');

      // Verify only enabled source was loaded
      const sources = await mockRegistry.listSources();
      assert.strictEqual(sources.length, 1, 'Should have only 1 enabled source loaded');

      // Compute expected sourceIds using the new format
      const expectedEnabledSourceId = generateHubSourceId('awesome-copilot', 'https://github.com/github/awesome-copilot');
      const expectedDisabledSourceId = generateHubSourceId('awesome-copilot', 'https://github.com/disabled/repo');

      // Check correct source was loaded
      assert.ok(mockRegistry.hasSource(expectedEnabledSourceId), 'Should have enabled source');
      assert.ok(!mockRegistry.hasSource(expectedDisabledSourceId), 'Should not have disabled source');
    });

    test('should update existing hub sources on re-import', async () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
      const ref: HubReference = {
        type: 'local',
        location: fixturePath
      };

      // First import
      await hubManager.importHub(ref, 'test-hub-update');
      const sourcesAfterFirst = await mockRegistry.listSources();
      assert.strictEqual(sourcesAfterFirst.length, 2, 'Should have 2 sources after first import');

      // Reset the mock to track only the second import
      mockRegistry.addSourceCalls = [];
      mockRegistry.updateSourceCalls = [];

      // Re-load sources from same hub (simulates re-import/sync)
      await hubManager.loadHubSources('test-hub-update');

      // Verify sources were updated, not duplicated
      const sourcesAfterReload = await mockRegistry.listSources();
      assert.strictEqual(sourcesAfterReload.length, 2, 'Should still have only 2 sources (no duplicates)');
      assert.strictEqual(mockRegistry.updateSourceCalls.length, 2, 'Should have 2 update calls');
      assert.strictEqual(mockRegistry.addSourceCalls.length, 0, 'Should have 0 add calls on reload');
    });
  });

  suite('Duplicate Detection', () => {
    test('should skip duplicate when URL and type match exactly', async () => {
      // Manually add a source
      const existingSource: RegistrySource = {
        id: 'existing-source',
        name: 'Existing Source',
        type: 'awesome-copilot',
        url: 'https://github.com/github/awesome-copilot',
        enabled: true,
        priority: 1,
        config: {
          branch: 'main',
          collectionsPath: 'collections'
        }
      };
      await mockRegistry.addSource(existingSource);

      // Import hub with duplicate source
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
      const ref: HubReference = {
        type: 'local',
        location: fixturePath
      };

      await hubManager.importHub(ref, 'test-hub-dup');

      // Verify duplicate was skipped
      // We should have: 1 existing + 1 new (source-2), source-1 should be skipped as duplicate
      const sources = await mockRegistry.listSources();
      assert.strictEqual(sources.length, 2, 'Should have 2 sources (1 existing + 1 new, 1 duplicate skipped)');

      // Compute expected sourceIds using the new format
      const expectedSource1Id = generateHubSourceId('awesome-copilot', 'https://github.com/github/awesome-copilot');
      const expectedSource2Id = generateHubSourceId('awesome-copilot', 'https://github.com/org/other-repo');

      // Verify the duplicate source-1 was skipped (URL matches existing source)
      // Note: The hub source would have the same ID as existing since they have same URL+type
      // But since existing source already exists with different ID, the hub source is skipped
      const hubSource1 = sources.find((s) => s.id === expectedSource1Id);
      assert.strictEqual(hubSource1, undefined, 'Duplicate source-1 should be skipped');

      // Verify source-2 was added (different URL)
      const hubSource2 = sources.find((s) => s.id === expectedSource2Id);
      assert.ok(hubSource2, 'Non-duplicate source-2 should be added');
    });

    test('should allow same URL with different branch', async () => {
      // Add source with branch: main
      const existingSource: RegistrySource = {
        id: 'existing-source-main',
        name: 'Existing Source Main',
        type: 'awesome-copilot',
        url: 'https://github.com/github/awesome-copilot',
        enabled: true,
        priority: 1,
        config: {
          branch: 'main',
          collectionsPath: 'collections'
        }
      };
      await mockRegistry.addSource(existingSource);

      // Create a hub config with same URL but different branch
      const tempHubPath = path.join(tempDir, 'hub-diff-branch.yml');
      const hubConfig: HubConfig = {
        version: '1.0.0',
        metadata: {
          name: 'Test Hub',
          description: 'Test',
          maintainer: 'Test',
          updatedAt: new Date().toISOString()
        },
        sources: [{
          id: 'source-develop',
          name: 'Source Develop',
          type: 'awesome-copilot',
          url: 'https://github.com/github/awesome-copilot',
          enabled: true,
          priority: 1,
          config: {
            branch: 'develop', // Different branch
            collectionsPath: 'collections'
          }
        }],
        profiles: []
      };

      const yaml = require('js-yaml');
      fs.writeFileSync(tempHubPath, yaml.dump(hubConfig));

      const ref: HubReference = {
        type: 'local',
        location: tempHubPath
      };

      await hubManager.importHub(ref, 'test-hub-branch');

      // Verify both sources exist (different branches = different sources)
      const sources = await mockRegistry.listSources();
      assert.strictEqual(sources.length, 2, 'Should have 2 sources (different branches)');
    });

    test('should allow same URL with different collectionsPath', async () => {
      // Add source with collectionsPath: collections
      const existingSource: RegistrySource = {
        id: 'existing-source-collections',
        name: 'Existing Source Collections',
        type: 'awesome-copilot',
        url: 'https://github.com/github/awesome-copilot',
        enabled: true,
        priority: 1,
        config: {
          branch: 'main',
          collectionsPath: 'collections'
        }
      };
      await mockRegistry.addSource(existingSource);

      // Create a hub config with same URL but different collectionsPath
      const tempHubPath = path.join(tempDir, 'hub-diff-path.yml');
      const hubConfig: HubConfig = {
        version: '1.0.0',
        metadata: {
          name: 'Test Hub',
          description: 'Test',
          maintainer: 'Test',
          updatedAt: new Date().toISOString()
        },
        sources: [{
          id: 'source-prompts',
          name: 'Source Prompts',
          type: 'awesome-copilot',
          url: 'https://github.com/github/awesome-copilot',
          enabled: true,
          priority: 1,
          config: {
            branch: 'main',
            collectionsPath: 'prompts' // Different path
          }
        }],
        profiles: []
      };

      const yaml = require('js-yaml');
      fs.writeFileSync(tempHubPath, yaml.dump(hubConfig));

      const ref: HubReference = {
        type: 'local',
        location: tempHubPath
      };

      await hubManager.importHub(ref, 'test-hub-path');

      // Verify both sources exist (different paths = different sources)
      const sources = await mockRegistry.listSources();
      assert.strictEqual(sources.length, 2, 'Should have 2 sources (different collectionsPath)');
    });

    test('should skip duplicate across multiple hubs', async () => {
      // Import first hub
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
      const ref1: HubReference = {
        type: 'local',
        location: fixturePath
      };

      await hubManager.importHub(ref1, 'hub-a');
      const sourcesAfterFirstHub = await mockRegistry.listSources();
      assert.strictEqual(sourcesAfterFirstHub.length, 2, 'Should have 2 sources from first hub');

      // Import second hub with identical sources (same URLs and configs)
      await hubManager.importHub(ref1, 'hub-b');

      // Verify duplicates were skipped
      const sourcesAfterSecondHub = await mockRegistry.listSources();
      // Hub-b's sources should be skipped because hub-a already has the same URL+config
      // So we should still have only 2 sources total (duplicates were skipped)
      assert.strictEqual(sourcesAfterSecondHub.length, 2, 'Should have only 2 sources (hub-b duplicates were skipped)');

      // Compute expected sourceIds using the new format
      const expectedSource1Id = generateHubSourceId('awesome-copilot', 'https://github.com/github/awesome-copilot');
      const expectedSource2Id = generateHubSourceId('awesome-copilot', 'https://github.com/org/other-repo');

      // Verify we have the sources with new format IDs
      // Note: With new format, sourceIds are based on URL+type, not hubId
      // So both hubs would generate the same sourceId for the same URL+type
      assert.ok(mockRegistry.hasSource(expectedSource1Id), `Should have source with id ${expectedSource1Id}`);
      assert.ok(mockRegistry.hasSource(expectedSource2Id), `Should have source with id ${expectedSource2Id}`);
    });
  });

  suite('Source Validation Failure Handling', () => {
    test('should continue loading other sources when one source fails validation (addSource throws)', async () => {
      // Bug: When a hub has multiple sources and one fails validation (e.g., private repo returns 404),
      // the entire hub import fails. It should gracefully skip the failing source and continue.
      // See: https://github.com/AmadeusITGroup/prompt-registry/issues/213

      // Create a mock that throws on the second source to simulate validation failure
      const failingRegistry = new MockRegistryManager();
      const originalAddSource = failingRegistry.addSource.bind(failingRegistry);
      let callCount = 0;
      failingRegistry.addSource = async (source: RegistrySource): Promise<void> => {
        callCount++;
        if (callCount === 2) {
          // Simulate what RegistryManager.addSource does when adapter.validate() fails
          throw new Error('Source validation failed: Failed to validate repository: HTTP 404: Not Found - Repository not found or not accessible. Check authentication.');
        }
        return originalAddSource(source);
      };

      const failingHubManager = new HubManager(
        storage,
        mockValidator as any,
        process.cwd(),
        undefined,
        failingRegistry as any
      );

      // Import hub with 2 sources (second one will fail validation)
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
      const ref: HubReference = {
        type: 'local',
        location: fixturePath
      };

      // This should NOT throw — it should gracefully skip the failing source
      await failingHubManager.importHub(ref, 'test-hub-partial-fail');

      // The first source should still have been added successfully
      const sources = await failingRegistry.listSources();
      assert.strictEqual(sources.length, 1, 'Should have 1 source (the one that succeeded)');
    });

    test('should not fail hub import when all sources fail validation', async () => {
      // Even if ALL sources fail validation, the hub itself should still be imported
      // (hub config is saved, just sources failed to load)
      const alwaysFailRegistry = new MockRegistryManager();
      alwaysFailRegistry.addSource = async (_source: RegistrySource): Promise<void> => {
        throw new Error('Source validation failed: Failed to validate repository: HTTP 404: Not Found');
      };

      const failingHubManager = new HubManager(
        storage,
        mockValidator as any,
        process.cwd(),
        undefined,
        alwaysFailRegistry as any
      );

      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
      const ref: HubReference = {
        type: 'local',
        location: fixturePath
      };

      // This should NOT throw — hub is saved even if sources fail
      await failingHubManager.importHub(ref, 'test-hub-all-fail');

      // Hub should still be saved in storage
      const hubs = await storage.listHubs();
      assert.ok(hubs.includes('test-hub-all-fail'), 'Hub should be saved even if all sources fail validation');

      // No sources should have been added
      const sources = await alwaysFailRegistry.listSources();
      assert.strictEqual(sources.length, 0, 'No sources should be added when all fail');
    });
  });

  suite('Integration with Hub Operations', () => {
    test('should load sources automatically when importing hub', async () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
      const ref: HubReference = {
        type: 'local',
        location: fixturePath
      };

      // Import hub (loadHubSources should be called automatically)
      await hubManager.importHub(ref, 'test-auto-load');

      // Verify sources were loaded without manual loadHubSources call
      const sources = await mockRegistry.listSources();
      assert.ok(sources.length > 0, 'Sources should be loaded automatically');
      assert.ok(mockRegistry.addSourceCalls.length > 0, 'addSource should have been called');
    });

    test('should reload sources when syncing hub', async () => {
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');

      // Create a modifiable copy
      const tempHubPath = path.join(tempDir, 'hub-sync-test.yml');
      fs.copyFileSync(fixturePath, tempHubPath);

      const ref: HubReference = {
        type: 'local',
        location: tempHubPath
      };

      // Import hub with 2 sources
      await hubManager.importHub(ref, 'test-sync');
      const sourcesAfterImport = await mockRegistry.listSources();
      assert.strictEqual(sourcesAfterImport.length, 2, 'Should have 2 sources after import');

      // Modify the hub config to add a 3rd source
      const yaml = require('js-yaml');
      const hubConfig = yaml.load(fs.readFileSync(tempHubPath, 'utf8')) as HubConfig;
      hubConfig.sources.push({
        id: 'source-3',
        name: 'Source 3',
        type: 'awesome-copilot',
        url: 'https://github.com/org/new-repo',
        enabled: true,
        priority: 3,
        config: {
          branch: 'main',
          collectionsPath: 'collections'
        }
      });
      fs.writeFileSync(tempHubPath, yaml.dump(hubConfig));

      // Sync hub
      await hubManager.syncHub('test-sync');

      // Verify 3 sources exist after sync
      const sourcesAfterSync = await mockRegistry.listSources();
      assert.strictEqual(sourcesAfterSync.length, 3, 'Should have 3 sources after sync');

      // Compute expected sourceId for the new source using the new format
      const expectedSource3Id = generateHubSourceId('awesome-copilot', 'https://github.com/org/new-repo');
      assert.ok(mockRegistry.hasSource(expectedSource3Id), `Should have the newly added source with id ${expectedSource3Id}`);
    });
  });
});
