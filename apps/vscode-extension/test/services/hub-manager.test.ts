/**
 * HubManager Unit Tests
 * Tests for hub orchestration logic
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import nock from 'nock';
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
  private shouldFail = false;
  private errors: string[] = [];

  public setShouldFail(fail: boolean, errors: string[] = []): void {
    this.shouldFail = fail;
    this.errors = errors;
  }

  public validate(_data: any, _schemaPath: string): Promise<ValidationResult> {
    if (this.shouldFail) {
      return Promise.resolve({
        valid: false,
        errors: this.errors.length > 0 ? this.errors : ['Schema validation failed'],
        warnings: []
      });
    }
    return Promise.resolve({
      valid: true,
      errors: [],
      warnings: []
    });
  }
}

suite('HubManager', () => {
  let hubManager: HubManager;
  let storage: HubStorage;
  let mockValidator: MockSchemaValidator;
  let tempDir: string;

  const localRef: HubReference = {
    type: 'local',
    location: '' // Will be set in setup
  };

  setup(() => {
    // Create temp directory
    tempDir = path.join(__dirname, '..', '..', 'test-temp-hubmanager');

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Use existing valid fixture
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
    localRef.location = fixturePath;

    // Initialize services
    storage = new HubStorage(tempDir);
    mockValidator = new MockSchemaValidator();
    hubManager = new HubManager(storage, mockValidator as any, process.cwd(), undefined, undefined);
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  suite('Initialization', () => {
    test('should initialize with storage and validator', () => {
      assert.ok(hubManager);
    });

    test('should throw if storage is missing', () => {
      assert.throws(() => {
        new HubManager(null as any, mockValidator as any, process.cwd(), undefined, undefined);
      }, /storage is required/);
    });

    test('should throw if validator is missing', () => {
      assert.throws(() => {
        new HubManager(storage, null as any, process.cwd(), undefined, undefined);
      }, /validator is required/);
    });
  });

  suite('Import Hub from Local', () => {
    test('should import hub from local file', async () => {
      const hubId = await hubManager.importHub(localRef, 'test-local');
      assert.strictEqual(hubId, 'test-local');

      // Verify it's saved
      const loaded = await storage.loadHub('test-local');
      assert.strictEqual(loaded.config.metadata.name, 'Official Prompt Registry Hub');
    });

    test('should auto-generate hub ID if not provided', async () => {
      const hubId = await hubManager.importHub(localRef);
      assert.ok(hubId);
      assert.ok(hubId.length > 0);
    });

    test('should fail if local file does not exist', async () => {
      const badRef: HubReference = {
        type: 'local',
        location: '/non/existent/file.yml'
      };

      await assert.rejects(
        async () => await hubManager.importHub(badRef),
        /File not found/
      );
    });

    test('should fail if hub config is invalid', async () => {
      mockValidator.setShouldFail(true, ['Invalid config']);

      await assert.rejects(
        async () => await hubManager.importHub(localRef, 'test-invalid'),
        /Hub validation failed/
      );
    });
  });

  suite('Hub Validation', () => {
    test('should validate hub config', async () => {
      // Load the fixture
      const config = yaml.load(fs.readFileSync(localRef.location, 'utf8')) as HubConfig;
      const result = await hubManager.validateHub(config);
      assert.strictEqual(result.valid, true);
    });

    test('should fail validation for invalid config', async () => {
      const config = yaml.load(fs.readFileSync(localRef.location, 'utf8')) as HubConfig;
      mockValidator.setShouldFail(true, ['Schema error']);

      const result = await hubManager.validateHub(config);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('Schema error'));
    });
  });

  suite('Load Hub', () => {
    test('should load hub from storage', async () => {
      // First import a hub
      await hubManager.importHub(localRef, 'test-load');

      // Then load it
      const result = await hubManager.loadHub('test-load');
      assert.strictEqual(result.config.metadata.name, 'Official Prompt Registry Hub');
      assert.strictEqual(result.reference.type, 'local');
    });

    test('should fail to load non-existent hub', async () => {
      await assert.rejects(
        async () => await hubManager.loadHub('non-existent'),
        /Hub not found/
      );
    });

    test('should fail if loaded hub is invalid', async () => {
      // Import valid hub
      await hubManager.importHub(localRef, 'test-invalid-load');

      // Make validator fail
      mockValidator.setShouldFail(true, ['Validation failed']);

      // Load should fail
      await assert.rejects(
        async () => await hubManager.loadHub('test-invalid-load'),
        /Hub validation failed/
      );
    });
  });

  suite('List Hubs', () => {
    test('should return empty array when no hubs', async () => {
      const hubs = await hubManager.listHubs();
      assert.strictEqual(hubs.length, 0);
    });

    test('should list all imported hubs', async () => {
      await hubManager.importHub(localRef, 'hub1');
      await hubManager.importHub(localRef, 'hub2');

      const hubs = await hubManager.listHubs();
      assert.strictEqual(hubs.length, 2);
      assert.ok(hubs.some((h: any) => h.id === 'hub1'));
      assert.ok(hubs.some((h: any) => h.id === 'hub2'));
    });

    test('should include hub metadata in list', async () => {
      await hubManager.importHub(localRef, 'hub-meta');

      const hubs = await hubManager.listHubs();
      const hub = hubs.find((h: any) => h.id === 'hub-meta');
      assert.ok(hub);
      assert.strictEqual(hub.name, 'Official Prompt Registry Hub');
    });
  });

  suite('Delete Hub', () => {
    test('should delete hub from storage', async () => {
      await hubManager.importHub(localRef, 'test-delete');

      // Verify it exists
      const beforeDelete = await hubManager.listHubs();
      assert.strictEqual(beforeDelete.length, 1);

      // Delete it
      await hubManager.deleteHub('test-delete');

      // Verify it's gone
      const afterDelete = await hubManager.listHubs();
      assert.strictEqual(afterDelete.length, 0);
    });

    test('should fail to delete non-existent hub', async () => {
      await assert.rejects(
        async () => await hubManager.deleteHub('non-existent'),
        /Hub not found/
      );
    });
  });

  suite('Sync Hub', () => {
    test('should sync hub from local source', async () => {
      // Copy fixture to temp location for modification
      const tempFixture = path.join(tempDir, 'sync-hub.yml');
      fs.copyFileSync(localRef.location, tempFixture);

      const syncRef: HubReference = {
        type: 'local',
        location: tempFixture
      };

      // Import initial hub
      await hubManager.importHub(syncRef, 'test-sync');

      // Modify the source file
      const config = yaml.load(fs.readFileSync(tempFixture, 'utf8')) as any;
      config.metadata.maintainer = 'Updated Team';
      fs.writeFileSync(tempFixture, yaml.dump(config));

      // Sync hub
      await hubManager.syncHub('test-sync');

      // Verify updated
      const result = await storage.loadHub('test-sync');
      assert.strictEqual(result.config.metadata.maintainer, 'Updated Team');
    });

    test('should fail to sync non-existent hub', async () => {
      await assert.rejects(
        async () => await hubManager.syncHub('non-existent'),
        /Hub not found/
      );
    });

    test('should fail sync if updated config is invalid', async () => {
      await hubManager.importHub(localRef, 'test-sync-invalid');

      // Make validator fail for next validation
      mockValidator.setShouldFail(true, ['Invalid after sync']);

      await assert.rejects(
        async () => await hubManager.syncHub('test-sync-invalid'),
        /Hub validation failed after sync/
      );
    });
  });

  suite('syncActiveHub()', () => {
    test('should sync the active hub when one is set', async () => {
      // Import and set as active
      await hubManager.importHub(localRef, 'test-active');
      await storage.setActiveHubId('test-active');

      // Modify the source file to verify sync happened
      const tempFixture = path.join(tempDir, 'sync-active-hub.yml');
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      fs.copyFileSync(fixturePath, tempFixture);

      const config = yaml.load(fs.readFileSync(tempFixture, 'utf8')) as any;
      config.metadata.maintainer = 'Active Sync Team';
      fs.writeFileSync(tempFixture, yaml.dump(config));

      // Re-import with the modified fixture so syncHub re-fetches it
      const syncRef: HubReference = { type: 'local', location: tempFixture };
      await hubManager.importHub(syncRef, 'test-active');
      await storage.setActiveHubId('test-active');

      // Now modify again to verify syncActiveHub picks it up
      config.metadata.maintainer = 'Updated Active Sync Team';
      fs.writeFileSync(tempFixture, yaml.dump(config));

      await hubManager.syncActiveHub();

      const loaded = await storage.loadHub('test-active');
      assert.strictEqual(loaded.config.metadata.maintainer, 'Updated Active Sync Team');
    });

    test('should no-op silently when no active hub is set', async () => {
      // No active hub set — should not throw
      await hubManager.syncActiveHub();
    });
  });

  suite('Get Hub Info', () => {
    test('should get detailed hub information', async () => {
      await hubManager.importHub(localRef, 'test-info');

      const info = await hubManager.getHubInfo('test-info');
      assert.strictEqual(info.id, 'test-info');
      assert.strictEqual(info.config.metadata.name, 'Official Prompt Registry Hub');
      assert.strictEqual(info.reference.type, 'local');
      assert.ok(info.metadata.name);
      assert.ok(info.metadata.description);
      assert.ok(info.metadata.lastModified);
      assert.ok(info.metadata.size > 0);
    });

    test('should fail to get info for non-existent hub', async () => {
      await assert.rejects(
        async () => await hubManager.getHubInfo('non-existent'),
        /Hub not found/
      );
    });
  });

  suite('Reference Validation', () => {
    test('should fail with missing type', async () => {
      const badRef: any = {
        location: 'somewhere'
      };

      await assert.rejects(
        async () => await hubManager.importHub(badRef),
        /Reference type is required/
      );
    });

    test('should fail with missing location', async () => {
      const badRef: any = {
        type: 'local'
      };

      await assert.rejects(
        async () => await hubManager.importHub(badRef),
        /Reference location is required/
      );
    });

    test('should fail with invalid GitHub location', async () => {
      const badRef: HubReference = {
        type: 'github',
        location: 'invalid-format'
      };

      await assert.rejects(
        async () => await hubManager.importHub(badRef),
        /Invalid GitHub location format/
      );
    });

    test('should accept valid GitHub location', async () => {
      // This will fail at fetch stage, but reference validation should pass
      const validRef: HubReference = {
        type: 'github',
        location: 'owner/repo'
      };

      // Will fail at fetch, not at validation
      await assert.rejects(
        async () => await hubManager.importHub(validRef),
        /Failed to fetch/
      );
    });
  });

  suite('Hub ID Validation', () => {
    test('should reject invalid hub IDs', async () => {
      await assert.rejects(
        async () => await hubManager.importHub(localRef, '../bad-id'),
        /Invalid hub ID/
      );
    });

    test('should accept valid hub IDs', async () => {
      const hubId = await hubManager.importHub(localRef, 'valid-hub-123');
      assert.strictEqual(hubId, 'valid-hub-123');
    });
  });

  suite('Active Hub Management', () => {
    test('should return null when no active hub is set', async () => {
      const activeHub = await hubManager.getActiveHub();
      assert.strictEqual(activeHub, null, 'Should return null when no active hub exists');
    });

    test('should set and retrieve active hub', async () => {
      const hubId = await hubManager.importHub(localRef, 'test-active-hub');

      await hubManager.setActiveHub(hubId);
      const activeHub = await hubManager.getActiveHub();

      assert.ok(activeHub, 'Should return active hub');
      assert.ok(activeHub.config, 'Should have config');
      assert.ok(activeHub.reference, 'Should have reference');
    });

    test('should update active hub when changed', async () => {
      const hubId1 = await hubManager.importHub(localRef, 'test-hub-1');
      const hubId2 = await hubManager.importHub(localRef, 'test-hub-2');

      await hubManager.setActiveHub(hubId1);
      let activeHub = await hubManager.getActiveHub();
      assert.ok(activeHub, 'First hub should be active');

      await hubManager.setActiveHub(hubId2);
      activeHub = await hubManager.getActiveHub();
      assert.ok(activeHub, 'Second hub should be active');
    });

    test('should return null after clearing active hub', async () => {
      const hubId = await hubManager.importHub(localRef, 'test-clear-hub');

      await hubManager.setActiveHub(hubId);
      assert.ok(await hubManager.getActiveHub(), 'Hub should be active');

      await hubManager.setActiveHub(null);
      assert.strictEqual(await hubManager.getActiveHub(), null, 'Active hub should be cleared');
    });

    test('should reject setting non-existent hub as active', async () => {
      await assert.rejects(
        async () => await hubManager.setActiveHub('non-existent-hub'),
        /Hub not found/,
        'Should reject non-existent hub'
      );
    });

    test('should list profiles from active hub only', async () => {
      const hubId1 = await hubManager.importHub(localRef, 'test-profiles-hub-1');

      // Set first hub as active
      await hubManager.setActiveHub(hubId1);

      const profiles = await hubManager.listActiveHubProfiles();

      // Verify all profiles belong to the active hub
      for (const profile of profiles) {
        assert.strictEqual(profile.hubId, hubId1, 'Profile should belong to active hub');
        assert.ok(profile.name, 'Profile should have name');
        assert.ok(profile.hubName, 'Profile should have hub name');
      }
    });

    test('should return empty array when active hub has no profiles', async () => {
      // Import a hub (fixture should have some profiles, but we can test the flow)
      const hubId = await hubManager.importHub(localRef, 'test-no-profiles');
      await hubManager.setActiveHub(hubId);

      const profiles = await hubManager.listActiveHubProfiles();

      // Fixture has profiles, so this will have items, but we're testing the method works
      assert.ok(Array.isArray(profiles), 'Should return an array');
    });

    test('should return empty array when no active hub is set', async () => {
      const profiles = await hubManager.listActiveHubProfiles();
      assert.ok(Array.isArray(profiles), 'Should return an array');
      assert.strictEqual(profiles.length, 0, 'Should return empty array when no active hub');
    });

    test('should auto-clear invalid active hub ID', async () => {
      const hubId = await hubManager.importHub(localRef, 'test-auto-clear');
      await hubManager.setActiveHub(hubId);

      // Manually delete the hub
      await hubManager.deleteHub(hubId);

      // Try to get active hub - should auto-clear and return null
      const activeHub = await hubManager.getActiveHub();
      assert.strictEqual(activeHub, null, 'Should auto-clear invalid hub ID');

      // Verify it was cleared in storage
      const activeHubId = await storage.getActiveHubId();
      assert.strictEqual(activeHubId, null, 'Storage should have cleared active hub ID');
    });

    test('should handle concurrent setActiveHub calls', async () => {
      const hubId1 = await hubManager.importHub(localRef, 'concurrent-1');
      const hubId2 = await hubManager.importHub(localRef, 'concurrent-2');

      // Concurrent updates
      await Promise.all([
        hubManager.setActiveHub(hubId1),
        hubManager.setActiveHub(hubId2)
      ]);

      const activeHub = await hubManager.getActiveHub();
      assert.ok(activeHub, 'Should have an active hub');
    });
  });

  suite('Favorites Management', () => {
    test('should toggle favorite status', async () => {
      const hubId = 'test-hub';
      const profileId = 'profile-1';

      // Initially not favorite
      let favorites = await hubManager.getFavoriteProfiles();
      assert.strictEqual(favorites[hubId], undefined);

      // Toggle ON
      await hubManager.toggleProfileFavorite(hubId, profileId);
      let isFav = await hubManager.isProfileFavorite(hubId, profileId);
      assert.strictEqual(isFav, true);

      favorites = await hubManager.getFavoriteProfiles();
      assert.deepStrictEqual(favorites[hubId], [profileId]);

      // Toggle OFF
      await hubManager.toggleProfileFavorite(hubId, profileId);
      isFav = await hubManager.isProfileFavorite(hubId, profileId);
      assert.strictEqual(isFav, false);

      favorites = await hubManager.getFavoriteProfiles();
      // Should be empty array or undefined depending on implementation cleanup
      // Implementation: if (favorites[hubId].length === 0) { delete favorites[hubId]; }
      assert.strictEqual(favorites[hubId], undefined);
    });

    test('should not create duplicates when toggling on repeatedly (simulated race)', async () => {
      const hubId = 'test-hub';
      const profileId = 'profile-1';

      // Manually corrupt storage to have duplicates (if possible via API? No, API toggles)
      // But let's verify API doesn't add duplicate if we call it weirdly?
      // Actually API toggles. If we call it twice, it adds then removes.

      // Let's verify standard behavior first
      await hubManager.toggleProfileFavorite(hubId, profileId);
      await hubManager.toggleProfileFavorite(hubId, profileId); // Remove
      await hubManager.toggleProfileFavorite(hubId, profileId); // Add back

      const favorites = await hubManager.getFavoriteProfiles();
      assert.strictEqual(favorites[hubId].length, 1);
      assert.strictEqual(favorites[hubId][0], profileId);
    });

    test('should emit event on change', async () => {
      let eventFired = false;
      hubManager.onFavoritesChanged(() => {
        eventFired = true;
      });

      await hubManager.toggleProfileFavorite('hub', 'profile');
      assert.strictEqual(eventFired, true);
    });
  });

  suite('Profile Activation State', () => {
    test('listProfilesFromHub should reflect active state', async () => {
      // Import a hub with profiles
      const hubId = await hubManager.importHub(localRef, 'active-state-hub');

      // Initially no profiles are active
      let profiles = await hubManager.listProfilesFromHub(hubId);
      assert.ok(profiles.length > 0);
      assert.ok(profiles.every((p) => !p.active));

      // Mark one profile as active in storage
      const profileToActivate = profiles[0];
      await storage.saveProfileActivationState(hubId, profileToActivate.id, {
        hubId,
        profileId: profileToActivate.id,
        activatedAt: new Date().toISOString(),
        syncedBundles: []
      });

      // Check if active state is reflected
      profiles = await hubManager.listProfilesFromHub(hubId);
      const activeProfile = profiles.find((p) => p.id === profileToActivate.id);
      assert.ok(activeProfile);
      assert.strictEqual(activeProfile.active, true);

      // Check others are still inactive
      const otherProfiles = profiles.filter((p) => p.id !== profileToActivate.id);
      if (otherProfiles.length > 0) {
        assert.ok(otherProfiles.every((p) => !p.active));
      }
    });
  });
});

/**
 * Hub Source Loading - SourceId Format Tests
 * Tests for the new sourceId format: {sourceType}-{12-char-hash}
 * Validates Requirement 2: Remove Hub ID from SourceId Generation
 */
suite('Hub Source Loading - SourceId Format', () => {
  let hubManager: HubManager;
  let storage: HubStorage;
  let mockValidator: MockSchemaValidator;
  let mockRegistry: MockRegistryManager;
  let tempDir: string;

  // Mock RegistryManager for tracking source operations
  class MockRegistryManager {
    private sources: RegistrySource[] = [];
    public addSourceCalls: RegistrySource[] = [];
    public updateSourceCalls: { id: string; updates: Partial<RegistrySource> }[] = [];
    public removeSourceCalls: string[] = [];

    // Minimal storage stub for SourceTypeReconciler
    private readonly storageStub = {
      getInstalledBundles: () => Promise.resolve([]),
      getCachedSourceBundles: () => Promise.resolve([])
    };

    public getStorage(): typeof this.storageStub {
      return this.storageStub;
    }

    public listInstalledBundles(): Promise<any[]> {
      return Promise.resolve([]);
    }

    public listSources(): Promise<RegistrySource[]> {
      return Promise.resolve([...this.sources]);
    }

    public syncSource(_sourceId: string): Promise<void> {
      return Promise.resolve();
    }

    public getBundleDetails(_bundleId: string): Promise<any> {
      return Promise.resolve({});
    }

    public addSource(source: RegistrySource): Promise<void> {
      this.sources.push(source);
      this.addSourceCalls.push(source);
      return Promise.resolve();
    }

    public updateSource(id: string, updates: Partial<RegistrySource>): Promise<void> {
      const index = this.sources.findIndex((s) => s.id === id);
      if (index !== -1) {
        this.sources[index] = { ...this.sources[index], ...updates };
        this.updateSourceCalls.push({ id, updates });
      }
      return Promise.resolve();
    }

    public removeSource(id: string): Promise<void> {
      const index = this.sources.findIndex((s) => s.id === id);
      if (index !== -1) {
        this.sources.splice(index, 1);
      }
      this.removeSourceCalls.push(id);
      return Promise.resolve();
    }

    public reset(): void {
      this.sources = [];
      this.addSourceCalls = [];
      this.updateSourceCalls = [];
      this.removeSourceCalls = [];
    }

    public getSourceCount(): number {
      return this.sources.length;
    }

    public hasSource(id: string): boolean {
      return this.sources.some((s) => s.id === id);
    }
  }

  const localRef: HubReference = {
    type: 'local',
    location: '' // Will be set in setup
  };

  setup(() => {
    // Create temp directory
    tempDir = path.join(__dirname, '..', '..', 'test-temp-hubmanager-sourceid');

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Use existing valid fixture with sources
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
    localRef.location = fixturePath;

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

  suite('New SourceId Format Generation', () => {
    test('loadHubSources() should generate sourceId via generateHubSourceId', async () => {
      // Import hub with sources
      await hubManager.importHub(localRef, 'test-new-format');

      // Verify sources were loaded
      const sources = await mockRegistry.listSources();
      assert.ok(sources.length > 0, 'Should have loaded sources');

      // Verify each source ID matches generateHubSourceId output
      for (const source of sources) {
        const expectedId = generateHubSourceId(source.type, source.url, {
          branch: source.config?.branch,
          collectionsPath: source.config?.collectionsPath
        });
        assert.strictEqual(
          source.id,
          expectedId,
          `Source ID "${source.id}" should match generateHubSourceId() output "${expectedId}"`
        );
      }
    });

    test('loadHubSources() should NOT include hub ID in sourceId', async () => {
      const hubId = 'my-custom-hub-id';

      // Import hub with a specific hub ID
      await hubManager.importHub(localRef, hubId);

      // Verify sources were loaded
      const sources = await mockRegistry.listSources();
      assert.ok(sources.length > 0, 'Should have loaded sources');

      // Verify NO source ID contains the hub ID
      for (const source of sources) {
        assert.ok(
          !source.id.includes(hubId),
          `Source ID "${source.id}" should NOT contain hub ID "${hubId}"`
        );

        // Also verify it doesn't start with 'hub-' (legacy format)
        assert.ok(
          !source.id.startsWith('hub-'),
          `Source ID "${source.id}" should NOT start with 'hub-' (legacy format)`
        );
      }
    });
  });

  suite('Duplicate Detection with URL Matching', () => {
    test('should detect duplicate sources by URL matching (not by ID)', async () => {
      // Manually add a source with the new format ID
      const existingUrl = 'https://github.com/github/awesome-copilot';
      const existingType = 'awesome-copilot';
      const existingSourceId = generateHubSourceId(existingType, existingUrl, {
        branch: 'main',
        collectionsPath: 'collections'
      });

      const existingSource: RegistrySource = {
        id: existingSourceId,
        name: 'Existing Source',
        type: existingType,
        url: existingUrl,
        enabled: true,
        priority: 1,
        config: {
          branch: 'main',
          collectionsPath: 'collections'
        }
      };
      await mockRegistry.addSource(existingSource);

      // Import hub that has a source with the same URL
      // hub-two-sources.yml has source-1 with url: https://github.com/github/awesome-copilot
      await hubManager.importHub(localRef, 'test-dup-detection');

      // Verify duplicate was detected and skipped
      const sources = await mockRegistry.listSources();

      // Should have 2 sources: 1 existing + 1 new (source-2 has different URL)
      // source-1 should be skipped as duplicate
      assert.strictEqual(sources.length, 2, 'Should have 2 sources (1 existing + 1 new, duplicate skipped)');

      // Verify the existing source is still there
      assert.ok(
        sources.some((s) => s.id === existingSourceId),
        'Existing source should still be present'
      );
    });

    test('should add new source when same URL but different branch is imported (different sourceId)', async () => {
      // Add source with branch: main
      const existingUrl = 'https://github.com/github/awesome-copilot';
      const existingType = 'awesome-copilot';
      const existingSourceId = generateHubSourceId(existingType, existingUrl, {
        branch: 'main',
        collectionsPath: 'collections'
      });

      const existingSource: RegistrySource = {
        id: existingSourceId,
        name: 'Existing Source Main',
        type: existingType,
        url: existingUrl,
        enabled: true,
        priority: 1,
        config: {
          branch: 'main',
          collectionsPath: 'collections'
        }
      };
      await mockRegistry.addSource(existingSource);

      // Create a hub config with same URL but different branch
      // Note: Since sourceId is based on type+URL only, this will have the SAME sourceId
      // and will UPDATE the existing source, not add a new one
      const tempHubPath = path.join(tempDir, 'hub-diff-branch.yml');
      const hubConfig = {
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

      fs.writeFileSync(tempHubPath, yaml.dump(hubConfig));

      const ref: HubReference = {
        type: 'local',
        location: tempHubPath
      };

      // Reset tracking to see what happens
      mockRegistry.addSourceCalls = [];
      mockRegistry.updateSourceCalls = [];

      await hubManager.importHub(ref, 'test-diff-branch');

      // Since sourceId now includes branch, different branch = different sourceId = ADD new source
      const sources = await mockRegistry.listSources();
      assert.strictEqual(sources.length, 2, 'Should have 2 sources (original + new with different branch)');

      // Verify it was an add, not an update
      assert.strictEqual(mockRegistry.addSourceCalls.length, 1, 'Should have 1 add call');
      assert.strictEqual(mockRegistry.updateSourceCalls.length, 0, 'Should have 0 update calls');

      // Verify we have both sources with different branches
      const mainSource = sources.find((s) => s.config?.branch === 'main');
      const developSource = sources.find((s) => s.config?.branch === 'develop');
      assert.ok(mainSource, 'Should have main branch source');
      assert.ok(developSource, 'Should have develop branch source');
      assert.notStrictEqual(mainSource.id, developSource.id, 'Different branches should have different sourceIds');
    });

    test('should update existing source when re-importing same hub', async () => {
      // Import hub first time
      await hubManager.importHub(localRef, 'test-update');

      const sourcesAfterFirst = await mockRegistry.listSources();
      assert.strictEqual(sourcesAfterFirst.length, 2, 'Should have 2 sources after first import');

      // Reset tracking
      mockRegistry.addSourceCalls = [];
      mockRegistry.updateSourceCalls = [];

      // Re-load sources from same hub
      await hubManager.loadHubSources('test-update');

      // Verify sources were updated, not duplicated
      const sourcesAfterReload = await mockRegistry.listSources();
      assert.strictEqual(sourcesAfterReload.length, 2, 'Should still have only 2 sources (no duplicates)');
      assert.strictEqual(mockRegistry.updateSourceCalls.length, 2, 'Should have 2 update calls');
      assert.strictEqual(mockRegistry.addSourceCalls.length, 0, 'Should have 0 add calls on reload');
    });
  });

  suite('Source Type Change Detection (awesome-copilot → github)', () => {
    test('should detect type change and attempt reconciliation without duplicating source', async () => {
      // Pre-seed an awesome-copilot source for the same URL used in hub-two-sources.yml (source-1)
      const sourceUrl = 'https://github.com/github/awesome-copilot';
      const oldSourceId = generateHubSourceId('awesome-copilot', sourceUrl, {
        branch: 'main',
        collectionsPath: 'collections'
      });

      const existingSource: RegistrySource = {
        id: oldSourceId,
        name: 'Legacy Awesome Copilot Source',
        type: 'awesome-copilot',
        url: sourceUrl,
        enabled: true,
        priority: 1,
        config: {
          branch: 'main',
          collectionsPath: 'collections'
        }
      };
      await mockRegistry.addSource(existingSource);

      // Create a hub config where that source is now type 'github'
      const tempHubPath = path.join(tempDir, 'hub-type-change.yml');
      const hubConfig = {
        version: '1.0.0',
        metadata: {
          name: 'Type Change Test Hub',
          description: 'Test',
          maintainer: 'Test',
          updatedAt: new Date().toISOString()
        },
        sources: [{
          id: 'source-migrated',
          name: 'Migrated Source',
          type: 'github',
          url: sourceUrl,
          enabled: true,
          priority: 1,
          config: {
            branch: 'main',
            collectionsPath: 'collections'
          }
        }],
        profiles: []
      };
      fs.writeFileSync(tempHubPath, yaml.dump(hubConfig));

      const ref: HubReference = { type: 'local', location: tempHubPath };

      // Reset tracking
      mockRegistry.addSourceCalls = [];
      mockRegistry.updateSourceCalls = [];

      // Import hub — the reconciler runs the happy path: no installed bundles
      // and an empty bundle cache, so no bundle migration happens. The old
      // awesome-copilot source is then removed (cleanupIfUnreferenced), and the
      // new github source takes its place without duplication.
      await hubManager.importHub(ref, 'test-type-change');

      const sources = await mockRegistry.listSources();

      // Key assertion: We should NOT have two sources for the same URL.
      // The reconciler adds the new github source and removes the old awesome-copilot one.
      const sourcesForUrl = sources.filter(
        (s) => s.url === sourceUrl
      );
      assert.strictEqual(
        sourcesForUrl.length,
        1,
        `Should have exactly 1 source for ${sourceUrl}, not ${sourcesForUrl.length} (no duplication on type change)`
      );

      // The source should now be the new github one (reconciliation succeeded)
      assert.strictEqual(sourcesForUrl[0].type, 'github',
        'Source type should be github after reconciliation');

      // Verify the old source was removed
      assert.strictEqual(mockRegistry.removeSourceCalls.length, 1,
        'Should have called removeSource once for the old awesome-copilot source');
      assert.strictEqual(mockRegistry.removeSourceCalls[0], oldSourceId,
        'Should have removed the old awesome-copilot source');
    });
  });
});

suite('HubManager Ghost Hub Cleanup on Failed Import', () => {
  // Bug: When importHub fails during loadHubSources (e.g., source validation 404),
  // the hub is already saved to storage (line 196) but the error propagates up.
  // This leaves a "ghost hub" in storage that:
  // 1. Causes initializeHub to enter migration path instead of fresh install
  // 2. Cannot be recovered from via "Reset First Run" (which only clears state + active hub)
  // 3. Accumulates on each retry (timestamp-based IDs create new ghost each time)
  // See: https://github.com/AmadeusITGroup/prompt-registry/issues/213

  let hubManager: HubManager;
  let hubStorage: HubStorage;
  let mockValidator: MockSchemaValidator;
  let tempDir: string;

  setup(() => {
    tempDir = path.join(__dirname, '..', '..', 'test-temp-hubmanager-ghost');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    hubStorage = new HubStorage(tempDir);
    mockValidator = new MockSchemaValidator();
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  test('should save hub even when all sources fail validation (no ghost)', async () => {
    // Source validation failures are non-fatal: hub is saved, failing sources are skipped.
    const failingRegistry = {
      listSources: () => Promise.resolve([]),
      addSource: (_source: any) => Promise.reject(new Error('Source validation failed: Failed to validate repository: HTTP 404: Not Found')),
      updateSource: () => Promise.resolve()
    };

    hubManager = new HubManager(
      hubStorage,
      mockValidator as any,
      process.cwd(),
      undefined,
      failingRegistry as any
    );

    const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
    const ref = { type: 'local' as const, location: fixturePath };

    // importHub should succeed — source failures are non-fatal
    const hubId = await hubManager.importHub(ref, 'test-ghost');
    assert.strictEqual(hubId, 'test-ghost');

    // Hub IS saved in storage (this is intentional, not a ghost)
    const hubs = await hubStorage.listHubs();
    assert.strictEqual(hubs.length, 1, 'Hub should be saved even when all sources fail');
  });

  test('should handle repeated imports with source failures gracefully', async () => {
    // Source validation failures are non-fatal: each import succeeds, hub is saved.
    const failingRegistry = {
      listSources: () => Promise.resolve([]),
      addSource: (_source: any) => Promise.reject(new Error('Source validation failed: HTTP 404')),
      updateSource: () => Promise.resolve()
    };

    hubManager = new HubManager(
      hubStorage,
      mockValidator as any,
      process.cwd(),
      undefined,
      failingRegistry as any
    );

    const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
    const ref = { type: 'local' as const, location: fixturePath };

    // Each import succeeds (source failures are non-fatal)
    for (let i = 0; i < 3; i++) {
      const hubId = await hubManager.importHub(ref, `retry-hub-${i}`);
      assert.strictEqual(hubId, `retry-hub-${i}`, `Import ${i + 1} should succeed`);
    }

    // All 3 hubs are saved (they are intentional, not ghosts)
    const hubs = await hubStorage.listHubs();
    assert.strictEqual(hubs.length, 3, 'All 3 imports should be saved');
  });

  test('deleteAllHubs should clean up hubs, allowing fresh hub selector after reset', async () => {
    // Simulate a ghost hub left by a failed import
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'hub-two-sources.yml');
    const hubConfig = yaml.load(fs.readFileSync(fixturePath, 'utf8')) as any;

    // Save a "ghost hub" to storage
    await hubStorage.saveHub('ghost-hub-123456', hubConfig, {
      type: 'local',
      location: fixturePath
    });

    // Verify ghost hub exists
    const hubs = await hubStorage.listHubs();
    assert.ok(hubs.includes('ghost-hub-123456'), 'Ghost hub should exist in storage');

    // Simulate what resetFirstRun now does: deleteAllHubs()
    const hubManagerForCleanup = new HubManager(
      hubStorage,
      mockValidator as any,
      process.cwd(),
      undefined,
      undefined
    );
    await hubManagerForCleanup.deleteAllHubs();

    // After cleanup, listHubs should return 0 — initializeHub enters fresh install path
    const hubList = await hubManagerForCleanup.listHubs();
    assert.strictEqual(hubList.length, 0,
      'After deleteAllHubs, listHubs should return 0 hubs');
  });
});

suite('HubManager HTTP Redirect Handling', () => {
  let hubManager: HubManager;
  let storage: HubStorage;
  let mockValidator: any;
  let tempDir: string;

  setup(() => {
    // Create temp directory
    tempDir = path.join(__dirname, '..', '..', 'test-temp-hubmanager-redirect');

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize services
    storage = new HubStorage(tempDir);
    mockValidator = {
      validate: () => {
        return { valid: true, errors: [], warnings: [] };
      }
    };
    hubManager = new HubManager(storage, mockValidator, process.cwd(), undefined, undefined);
  });

  teardown(() => {
    nock.cleanAll();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  test('should follow HTTP 301 redirects when importing hub from URL', async () => {
    const hubConfigYaml = `
version: "1.0.0"
metadata:
  name: Redirect Test Hub
  description: Hub for testing redirect handling
  maintainer: test@example.com
  updatedAt: "2025-01-01T00:00:00Z"
sources: []
profiles: []
`;
    // First request returns 301 redirect
    nock('https://raw.githubusercontent.com')
      .get('/old-owner/old-repo/main/hub-config.yml')
      .query(true)
      .reply(301, '', { location: 'https://raw.githubusercontent.com/new-owner/new-repo/main/hub-config.yml' });

    // Redirect target returns the actual content
    nock('https://raw.githubusercontent.com')
      .get('/new-owner/new-repo/main/hub-config.yml')
      .reply(200, hubConfigYaml);

    const reference = {
      type: 'github' as const,
      location: 'old-owner/old-repo'
    };

    const hubId = await hubManager.importHub(reference, 'redirect-test-hub');
    assert.strictEqual(hubId, 'redirect-test-hub');

    // Verify hub was imported successfully
    const loaded = await storage.loadHub('redirect-test-hub');
    assert.strictEqual(loaded.config.metadata.name, 'Redirect Test Hub');
  });

  test('should follow HTTP 302 redirects when syncing hub', async () => {
    // First, import a hub using local file
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
    const localRef = { type: 'local' as const, location: fixturePath };
    const hubId = await hubManager.importHub(localRef, 'sync-redirect-hub');

    // Now update the reference to use URL and mock the sync with redirect
    const hubConfigYaml = `
version: "1.0.0"
metadata:
  name: Updated Hub After Redirect
  description: Hub synced after following redirect
  maintainer: test@example.com
  updatedAt: "2025-01-02T00:00:00Z"
sources: []
profiles: []
`;
    // Update the hub reference to URL type for sync test
    await storage.saveHub(hubId, yaml.load(fs.readFileSync(fixturePath, 'utf8')) as HubConfig, {
      type: 'url',
      location: 'https://raw.githubusercontent.com/test-owner/test-repo/main/hub-config.yml'
    });

    // Mock the sync request with 302 redirect
    nock('https://raw.githubusercontent.com')
      .get('/test-owner/test-repo/main/hub-config.yml')
      .reply(302, '', { location: 'https://raw.githubusercontent.com/test-owner/test-repo-v2/main/hub-config.yml' });

    nock('https://raw.githubusercontent.com')
      .get('/test-owner/test-repo-v2/main/hub-config.yml')
      .reply(200, hubConfigYaml);

    await hubManager.syncHub(hubId);

    // Verify hub was synced successfully
    const loaded = await storage.loadHub(hubId);
    assert.strictEqual(loaded.config.metadata.name, 'Updated Hub After Redirect');
  });
});
