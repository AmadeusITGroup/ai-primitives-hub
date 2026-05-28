/**
 * Hub Cleanup Tests
 * Tests for cleanup behavior when hub is deleted or switched:
 * - Deactivate profiles from that hub
 * - Remove profiles from favorites
 * - Remove sources that came from that hub
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubReference,
} from '../../src/types/hub';

// Mock SchemaValidator
class MockSchemaValidator {
  public validate(): Promise<any> {
    return Promise.resolve({ valid: true, errors: [], warnings: [] });
  }
}

// Mock RegistryManager that tracks calls
class MockRegistryManager {
  public sources: any[] = [];
  public profiles: any[] = [];
  public removedSourceIds: string[] = [];
  public deactivatedProfileIds: string[] = [];

  public listSources() {
    return this.sources;
  }

  public addSource(source: any) {
    this.sources.push(source);
  }

  public removeSource(sourceId: string) {
    this.removedSourceIds.push(sourceId);
    this.sources = this.sources.filter((s) => s.id !== sourceId);
  }

  public updateSource(sourceId: string, updates: any) {
    const source = this.sources.find((s) => s.id === sourceId);
    if (source) {
      Object.assign(source, updates);
    }
  }

  public listProfiles() {
    return this.profiles;
  }

  public createProfile(profile: any) {
    this.profiles.push(profile);
  }

  public updateProfile(profileId: string, updates: any) {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (profile) {
      if (updates.active === false) {
        this.deactivatedProfileIds.push(profileId);
      }
      Object.assign(profile, updates);
    }
  }

  public deleteProfile(profileId: string) {
    this.profiles = this.profiles.filter((p) => p.id !== profileId);
  }
}

suite('Hub Cleanup', () => {
  let hubManager: HubManager;
  let storage: HubStorage;
  let mockRegistryManager: MockRegistryManager;
  let tempDir: string;

  setup(() => {
    // Create temp directory
    tempDir = path.join(__dirname, '..', '..', 'test-temp-hub-cleanup');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    storage = new HubStorage(tempDir);
    const validator = new MockSchemaValidator();
    mockRegistryManager = new MockRegistryManager();

    hubManager = new HubManager(
      storage,
      validator as any,
      process.cwd(),
      undefined,
      mockRegistryManager as any
    );
  });

  teardown(() => {
    sinon.restore();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  suite('deleteHub cleanup', () => {
    test('should remove sources linked to deleted hub', async () => {
      // Setup: Add sources, some from hub, some local
      mockRegistryManager.sources = [
        { id: 'hub-test-hub-source1', name: 'Hub Source 1', hubId: 'test-hub' },
        { id: 'hub-test-hub-source2', name: 'Hub Source 2', hubId: 'test-hub' },
        { id: 'local-source', name: 'Local Source', hubId: undefined },
        { id: 'hub-other-hub-source', name: 'Other Hub Source', hubId: 'other-hub' }
      ];

      // Import a hub first
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      // Delete the hub
      await hubManager.deleteHub('test-hub');

      // Verify only sources from 'test-hub' were removed
      assert.ok(
        mockRegistryManager.removedSourceIds.includes('hub-test-hub-source1'),
        'Source 1 from test-hub should be removed'
      );
      assert.ok(
        mockRegistryManager.removedSourceIds.includes('hub-test-hub-source2'),
        'Source 2 from test-hub should be removed'
      );
      assert.ok(
        !mockRegistryManager.removedSourceIds.includes('local-source'),
        'Local source should NOT be removed'
      );
      assert.ok(
        !mockRegistryManager.removedSourceIds.includes('hub-other-hub-source'),
        'Source from other hub should NOT be removed'
      );
    });

    test('should remove favorites for deleted hub', async () => {
      // Import hub and add some favorites
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      // Add favorites for the hub
      await hubManager.toggleProfileFavorite('test-hub', 'profile1');
      await hubManager.toggleProfileFavorite('test-hub', 'profile2');

      // Also add favorites for another hub
      await hubManager.toggleProfileFavorite('other-hub', 'profile-other');

      // Verify favorites exist
      let favorites = await hubManager.getFavoriteProfiles();
      assert.ok(favorites['test-hub'], 'test-hub should have favorites');
      assert.ok(favorites['other-hub'], 'other-hub should have favorites');

      // Delete the hub
      await hubManager.deleteHub('test-hub');

      // Verify favorites for deleted hub are removed
      favorites = await hubManager.getFavoriteProfiles();
      assert.strictEqual(favorites['test-hub'], undefined, 'test-hub favorites should be removed');
      assert.ok(favorites['other-hub'], 'other-hub favorites should remain');
    });

    test('should deactivate profiles linked to deleted hub', async () => {
      // Setup: Add profiles, some from hub, some local
      mockRegistryManager.profiles = [
        { id: 'hub-profile1', name: 'Hub Profile 1', active: true, hubId: 'test-hub' },
        { id: 'hub-profile2', name: 'Hub Profile 2', active: true, hubId: 'test-hub' },
        { id: 'local-profile', name: 'Local Profile', active: true, hubId: undefined },
        { id: 'other-hub-profile', name: 'Other Hub Profile', active: true, hubId: 'other-hub' }
      ];

      // Import hub
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'test-hub');

      // Delete the hub
      await hubManager.deleteHub('test-hub');

      // Verify only profiles from 'test-hub' were deactivated
      assert.ok(
        mockRegistryManager.deactivatedProfileIds.includes('hub-profile1'),
        'Profile 1 from test-hub should be deactivated'
      );
      assert.ok(
        mockRegistryManager.deactivatedProfileIds.includes('hub-profile2'),
        'Profile 2 from test-hub should be deactivated'
      );
      assert.ok(
        !mockRegistryManager.deactivatedProfileIds.includes('local-profile'),
        'Local profile should NOT be deactivated'
      );
      assert.ok(
        !mockRegistryManager.deactivatedProfileIds.includes('other-hub-profile'),
        'Profile from other hub should NOT be deactivated'
      );
    });
  });

  suite('orphaned favorites cleanup', () => {
    test('should remove favorites for hubs that no longer exist', async () => {
      // Import a hub
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'existing-hub');

      // Manually add favorites for a non-existent hub (simulating stale data)
      const favorites = await hubManager.getFavoriteProfiles();
      favorites['non-existent-hub'] = ['profile1', 'profile2'];
      favorites['another-ghost-hub'] = ['profile3'];
      await storage.saveFavoriteProfiles(favorites);

      // Verify orphaned favorites exist
      let currentFavorites = await hubManager.getFavoriteProfiles();
      assert.ok(currentFavorites['non-existent-hub'], 'Non-existent hub favorites should exist before cleanup');
      assert.ok(currentFavorites['another-ghost-hub'], 'Another ghost hub favorites should exist before cleanup');

      // Run cleanup of orphaned favorites
      await hubManager.cleanupOrphanedFavorites();

      // Verify orphaned favorites are removed
      currentFavorites = await hubManager.getFavoriteProfiles();
      assert.strictEqual(currentFavorites['non-existent-hub'], undefined, 'Non-existent hub favorites should be removed');
      assert.strictEqual(currentFavorites['another-ghost-hub'], undefined, 'Another ghost hub favorites should be removed');
    });

    test('should keep favorites for hubs that still exist', async () => {
      // Import a hub
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'existing-hub');

      // Add favorites for existing hub
      await hubManager.toggleProfileFavorite('existing-hub', 'profile1');

      // Also add orphaned favorites
      const favorites = await hubManager.getFavoriteProfiles();
      favorites['ghost-hub'] = ['profile-ghost'];
      await storage.saveFavoriteProfiles(favorites);

      // Run cleanup
      await hubManager.cleanupOrphanedFavorites();

      // Verify existing hub favorites remain, orphaned are removed
      const currentFavorites = await hubManager.getFavoriteProfiles();
      assert.ok(currentFavorites['existing-hub'], 'Existing hub favorites should remain');
      assert.ok(currentFavorites['existing-hub'].includes('profile1'), 'Profile1 should still be favorited');
      assert.strictEqual(currentFavorites['ghost-hub'], undefined, 'Ghost hub favorites should be removed');
    });
  });

  suite('setActiveHub cleanup (switching hubs)', () => {
    test('should cleanup previous hub when switching to new hub', async () => {
      // Setup sources from two hubs
      mockRegistryManager.sources = [
        { id: 'hub-hub1-source1', name: 'Hub1 Source', hubId: 'hub1' },
        { id: 'hub-hub2-source1', name: 'Hub2 Source', hubId: 'hub2' }
      ];

      // Setup profiles from two hubs
      mockRegistryManager.profiles = [
        { id: 'hub1-profile', name: 'Hub1 Profile', active: true, hubId: 'hub1' },
        { id: 'hub2-profile', name: 'Hub2 Profile', active: false, hubId: 'hub2' }
      ];

      // Import two hubs
      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'hub1');
      await hubManager.importHub(ref, 'hub2');

      // Add favorites for hub1
      await hubManager.toggleProfileFavorite('hub1', 'profile1');

      // Set hub1 as active
      await hubManager.setActiveHub('hub1');

      // Switch to hub2 - should cleanup hub1
      await hubManager.setActiveHub('hub2');

      // Verify hub1 profiles are deactivated
      assert.ok(
        mockRegistryManager.deactivatedProfileIds.includes('hub1-profile'),
        'Hub1 profile should be deactivated when switching away'
      );

      // Verify hub1 sources are removed
      assert.ok(
        mockRegistryManager.removedSourceIds.includes('hub-hub1-source1'),
        'Hub1 source should be removed when switching away'
      );

      // Verify hub1 favorites are cleared
      const favorites = await hubManager.getFavoriteProfiles();
      assert.strictEqual(favorites.hub1, undefined, 'Hub1 favorites should be cleared');
    });

    test('should not cleanup when setting same hub as active', async () => {
      mockRegistryManager.sources = [
        { id: 'hub-hub1-source1', name: 'Hub1 Source', hubId: 'hub1' }
      ];

      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'hub1');

      // Set hub1 as active twice
      await hubManager.setActiveHub('hub1');
      mockRegistryManager.removedSourceIds = []; // Reset
      await hubManager.setActiveHub('hub1');

      // Verify no cleanup happened
      assert.strictEqual(
        mockRegistryManager.removedSourceIds.length,
        0,
        'No sources should be removed when setting same hub'
      );
    });

    test('should cleanup when clearing active hub (setting to null)', async () => {
      mockRegistryManager.sources = [
        { id: 'hub-hub1-source1', name: 'Hub1 Source', hubId: 'hub1' }
      ];
      mockRegistryManager.profiles = [
        { id: 'hub1-profile', name: 'Hub1 Profile', active: true, hubId: 'hub1' }
      ];

      const fixturePath = path.join(__dirname, '..', 'fixtures', 'hubs', 'valid-hub-config.yml');
      const ref: HubReference = { type: 'local', location: fixturePath };
      await hubManager.importHub(ref, 'hub1');
      await hubManager.setActiveHub('hub1');
      await hubManager.toggleProfileFavorite('hub1', 'profile1');

      // Clear active hub
      mockRegistryManager.removedSourceIds = [];
      mockRegistryManager.deactivatedProfileIds = [];
      await hubManager.setActiveHub(null);

      // Verify cleanup happened
      assert.ok(
        mockRegistryManager.removedSourceIds.includes('hub-hub1-source1'),
        'Hub1 source should be removed when clearing active hub'
      );
      assert.ok(
        mockRegistryManager.deactivatedProfileIds.includes('hub1-profile'),
        'Hub1 profile should be deactivated when clearing active hub'
      );
    });
  });
});
