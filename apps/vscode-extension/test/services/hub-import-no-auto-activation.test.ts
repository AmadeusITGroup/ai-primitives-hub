/**
 * Hub Import - No Auto-Activation Tests
 *
 * Verifies that importing a hub does NOT automatically activate any profile.
 * Users should explicitly choose which profile to activate.
 *
 * This test prevents regression of the bug where the first profile was
 * automatically activated upon hub import.
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

// Mock SchemaValidator
class MockSchemaValidator {
  public async validate(_data: any, _schemaPath: string): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }
}

// Mock RegistryManager to track profile activation calls
class MockRegistryManager {
  public activateProfileCalls: string[] = [];
  public sources: any[] = [];

  public async activateProfile(profileId: string): Promise<void> {
    this.activateProfileCalls.push(profileId);
  }

  public async listSources(): Promise<any[]> {
    return this.sources;
  }

  public async addSource(source: any): Promise<void> {
    this.sources.push(source);
  }

  public async updateSource(_id: string, _updates: any): Promise<void> {
    // no-op for tests
  }
}

suite('Hub Import - No Auto-Activation', () => {
  let hubManager: HubManager;
  let storage: HubStorage;
  let mockValidator: MockSchemaValidator;
  let mockRegistryManager: MockRegistryManager;
  let tempDir: string;

  const createHubWithProfiles = (): HubConfig => ({
    version: '1.0.0',
    metadata: {
      name: 'Test Hub with Profiles',
      description: 'Hub for testing no auto-activation',
      maintainer: 'Test',
      updatedAt: new Date().toISOString()
    },
    sources: [
      {
        id: 'source-1',
        name: 'Test Source',
        type: 'github',
        url: 'github:test/repo',
        enabled: true,
        priority: 1,
        metadata: { description: 'Test source' }
      }
    ],
    profiles: [
      {
        id: 'profile-1',
        name: 'First Profile',
        description: 'This should NOT be auto-activated',
        bundles: [
          { id: 'bundle-1', version: '1.0.0', source: 'source-1', required: true }
        ],
        icon: '📦',
        active: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: 'profile-2',
        name: 'Second Profile',
        description: 'Another profile',
        bundles: [],
        icon: '📦',
        active: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });

  setup(() => {
    tempDir = path.join(__dirname, '..', '..', 'test-temp-no-auto-activation');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    storage = new HubStorage(tempDir);
    mockValidator = new MockSchemaValidator();
    mockRegistryManager = new MockRegistryManager();

    hubManager = new HubManager(
      storage,
      mockValidator as any,
      process.cwd(),
      undefined, // bundleInstaller
      mockRegistryManager as any // registryManager
    );
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  suite('Hub Import Behavior', () => {
    test('should NOT activate any profile when importing a hub with profiles', async () => {
      // Arrange: Create a hub config file with multiple profiles
      const hubConfig = createHubWithProfiles();
      const hubConfigPath = path.join(tempDir, 'hub-config.yml');
      const yaml = require('js-yaml');
      fs.writeFileSync(hubConfigPath, yaml.dump(hubConfig));

      const localRef: HubReference = {
        type: 'local',
        location: hubConfigPath
      };

      // Act: Import the hub
      const hubId = await hubManager.importHub(localRef, 'test-hub');

      // Assert: No profile should be activated
      // 1. Check that RegistryManager.activateProfile was never called
      assert.strictEqual(
        mockRegistryManager.activateProfileCalls.length,
        0,
        'RegistryManager.activateProfile should NOT be called during hub import'
      );

      // 2. Verify no profile has active=true in storage
      const profiles = await hubManager.listProfilesFromHub(hubId);
      const activeProfiles = profiles.filter((p) => p.active);
      assert.strictEqual(
        activeProfiles.length,
        0,
        'No profile should be marked as active after hub import'
      );

      // 3. Verify no activation state exists
      const activationState = await hubManager.getActiveProfile(hubId);
      assert.strictEqual(
        activationState,
        null,
        'No activation state should exist after hub import'
      );
    });

    test('should NOT activate any profile when setting a hub as active', async () => {
      // Arrange: Create and import a hub
      const hubConfig = createHubWithProfiles();
      const hubConfigPath = path.join(tempDir, 'hub-config-active.yml');
      const yaml = require('js-yaml');
      fs.writeFileSync(hubConfigPath, yaml.dump(hubConfig));

      const localRef: HubReference = {
        type: 'local',
        location: hubConfigPath
      };

      const hubId = await hubManager.importHub(localRef, 'test-active-hub');

      // Act: Set the hub as active
      await hubManager.setActiveHub(hubId);

      // Assert: Still no profile should be activated
      assert.strictEqual(
        mockRegistryManager.activateProfileCalls.length,
        0,
        'RegistryManager.activateProfile should NOT be called when setting active hub'
      );

      const profiles = await hubManager.listProfilesFromHub(hubId);
      const activeProfiles = profiles.filter((p) => p.active);
      assert.strictEqual(
        activeProfiles.length,
        0,
        'No profile should be marked as active after setting hub as active'
      );
    });

    test('profiles should remain inactive until explicitly activated by user', async () => {
      // Arrange: Create and import a hub
      const hubConfig = createHubWithProfiles();
      const hubConfigPath = path.join(tempDir, 'hub-config-explicit.yml');
      const yaml = require('js-yaml');
      fs.writeFileSync(hubConfigPath, yaml.dump(hubConfig));

      const localRef: HubReference = {
        type: 'local',
        location: hubConfigPath
      };

      const hubId = await hubManager.importHub(localRef, 'test-explicit-hub');
      await hubManager.setActiveHub(hubId);

      // Verify profiles are inactive
      let profiles = await hubManager.listProfilesFromHub(hubId);
      assert.ok(profiles.every((p) => !p.active), 'All profiles should be inactive initially');

      // Act: Explicitly activate a profile (simulating user action)
      await hubManager.activateProfile(hubId, 'profile-1', { installBundles: false });

      // Assert: Only the explicitly activated profile should be active
      profiles = await hubManager.listProfilesFromHub(hubId);
      const activeProfile = profiles.find((p) => p.active);
      assert.ok(activeProfile, 'One profile should now be active');
      assert.strictEqual(activeProfile?.id, 'profile-1', 'The explicitly activated profile should be active');

      const inactiveProfiles = profiles.filter((p) => !p.active);
      assert.strictEqual(inactiveProfiles.length, 1, 'Other profiles should remain inactive');
    });
  });

  suite('Hub Sync Behavior', () => {
    test('should NOT activate any profile when syncing a hub', async () => {
      // Arrange: Create and import a hub
      const hubConfig = createHubWithProfiles();
      const hubConfigPath = path.join(tempDir, 'hub-config-sync.yml');
      const yaml = require('js-yaml');
      fs.writeFileSync(hubConfigPath, yaml.dump(hubConfig));

      const localRef: HubReference = {
        type: 'local',
        location: hubConfigPath
      };

      const hubId = await hubManager.importHub(localRef, 'test-sync-hub');

      // Modify the hub config (simulate remote update)
      hubConfig.metadata.description = 'Updated description';
      fs.writeFileSync(hubConfigPath, yaml.dump(hubConfig));

      // Act: Sync the hub
      await hubManager.syncHub(hubId);

      // Assert: No profile should be activated
      assert.strictEqual(
        mockRegistryManager.activateProfileCalls.length,
        0,
        'RegistryManager.activateProfile should NOT be called during hub sync'
      );

      const profiles = await hubManager.listProfilesFromHub(hubId);
      const activeProfiles = profiles.filter((p) => p.active);
      assert.strictEqual(
        activeProfiles.length,
        0,
        'No profile should be marked as active after hub sync'
      );
    });
  });
});
