/**
 * HubManager Profile Methods Unit Tests
 * Tests for hub profile operations
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
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

suite('HubManager - Profile Methods', () => {
  let hubManager: HubManager;
  let storage: HubStorage;
  let tempDir: string;

  const sampleHubConfig: HubConfig = {
    version: '1.0.0',
    metadata: {
      name: 'Test Hub with Profiles',
      description: 'Hub for testing profile methods',
      maintainer: 'Test',
      updatedAt: new Date().toISOString()
    },
    sources: [],
    profiles: [
      {
        id: 'profile-1',
        name: 'Profile 1',
        description: 'First test profile',
        bundles: [
          {
            id: 'bundle-1',
            version: '1.0.0',
            source: 'test-source',
            required: false
          }
        ],
        icon: '',
        active: false,
        createdAt: '',
        updatedAt: ''
      },
      {
        id: 'profile-2',
        name: 'Profile 2',
        description: 'Second test profile',
        bundles: [
          {
            id: 'bundle-2',
            version: '2.0.0',
            source: 'test-source',
            required: false
          },
          {
            id: 'bundle-3',
            version: '1.5.0',
            source: 'test-source',
            required: false
          }
        ],
        icon: '',
        active: false,
        createdAt: '',
        updatedAt: ''
      }
    ]
  };

  setup(() => {
    tempDir = path.join(__dirname, '../../test-temp-profiles');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    storage = new HubStorage(tempDir);
    hubManager = new HubManager(storage, {} as any, process.cwd(), undefined, undefined);
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('listProfilesFromHub', () => {
    test('should return empty array for hub without profiles', async () => {
      const hubConfig: HubConfig = {
        version: '1.0.0',
        metadata: {
          name: 'No Profiles Hub',
          description: 'Hub without profiles',
          maintainer: 'Test',
          updatedAt: new Date().toISOString()
        },
        sources: [],
        profiles: []
      };

      await storage.saveHub('no-profiles', hubConfig, { type: 'github', location: 'test/no-profiles' });
      const profiles = await hubManager.listProfilesFromHub('no-profiles');

      assert.strictEqual(profiles.length, 0);
    });

    test('should return all profiles from hub', async () => {
      await storage.saveHub('test-hub-profiles', sampleHubConfig, { type: 'github', location: 'test/repo' });
      const profiles = await hubManager.listProfilesFromHub('test-hub-profiles');

      assert.strictEqual(profiles.length, 2);
      assert.strictEqual(profiles[0].id, 'profile-1');
      assert.strictEqual(profiles[0].name, 'Profile 1');
      assert.strictEqual(profiles[1].id, 'profile-2');
      assert.strictEqual(profiles[1].name, 'Profile 2');
    });

    test('should throw error for non-existent hub', async () => {
      await assert.rejects(
        async () => await hubManager.listProfilesFromHub('non-existent'),
        (err: Error) => {
          assert.ok(err.message.includes('Hub not found'));
          return true;
        }
      );
    });
  });

  suite('getHubProfile', () => {
    test('should return specific profile from hub', async () => {
      await storage.saveHub('test-hub-profiles', sampleHubConfig, { type: 'github', location: 'test/repo' });
      const profile = await hubManager.getHubProfile('test-hub-profiles', 'profile-2');

      assert.strictEqual(profile.id, 'profile-2');
      assert.strictEqual(profile.name, 'Profile 2');
      assert.strictEqual(profile.bundles.length, 2);
    });

    test('should throw error for non-existent hub', async () => {
      await assert.rejects(
        async () => await hubManager.getHubProfile('non-existent', 'profile-1'),
        (err: Error) => {
          assert.ok(err.message.includes('Hub not found'));
          return true;
        }
      );
    });

    test('should throw error for non-existent profile', async () => {
      await storage.saveHub('test-hub-profiles', sampleHubConfig, { type: 'github', location: 'test/repo' });
      await assert.rejects(
        async () => await hubManager.getHubProfile('test-hub-profiles', 'non-existent'),
        (err: Error) => {
          assert.ok(err.message.includes('Profile not found'));
          return true;
        }
      );
    });
  });

  suite('listAllHubProfiles', () => {
    test('should return empty array when no hubs exist', async () => {
      const profiles = await hubManager.listAllHubProfiles();
      assert.strictEqual(profiles.length, 0);
    });

    test('should return profiles from single hub', async () => {
      await storage.saveHub('test-hub-profiles', sampleHubConfig, { type: 'github', location: 'test/repo' });
      const profiles = await hubManager.listAllHubProfiles();

      assert.strictEqual(profiles.length, 2);
      assert.ok(profiles.every((p) => p.hubId === 'test-hub-profiles'));
    });

    test('should return profiles from multiple hubs', async () => {
      await storage.saveHub('test-hub-profiles', sampleHubConfig, { type: 'github', location: 'test/repo' });

      const anotherConfig: HubConfig = {
        version: '1.0.0',
        metadata: {
          name: 'Another Hub',
          description: 'Another test hub',
          maintainer: 'Test',
          updatedAt: new Date().toISOString()
        },
        sources: [],
        profiles: [
          {
            id: 'profile-3',
            name: 'Profile 3',
            description: 'Third profile',
            bundles: [],
            icon: '',
            active: false,
            createdAt: '',
            updatedAt: ''
          }
        ]
      };

      await storage.saveHub('another-hub', anotherConfig, { type: 'github', location: 'test/another' });
      const profiles = await hubManager.listAllHubProfiles();

      assert.strictEqual(profiles.length, 3);
    });

    test('should include hub information with profiles', async () => {
      await storage.saveHub('test-hub-profiles', sampleHubConfig, { type: 'github', location: 'test/repo' });
      const profiles = await hubManager.listAllHubProfiles();

      assert.ok(profiles[0].hubId);
      assert.ok(profiles[0].hubName);
    });
  });
});
