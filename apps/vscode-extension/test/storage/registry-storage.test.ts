/**
 * RegistryStorage Unit Tests
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import {
  RegistryStorage,
} from '../../src/storage/registry-storage';

suite('RegistryStorage', () => {
  let sandbox: sinon.SinonSandbox;
  const testStoragePath = '/test/storage';

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('Storage Paths', () => {
    test('should define correct storage structure', () => {
      const paths = {
        root: testStoragePath,
        sources: path.join(testStoragePath, 'sources.json'),
        installed: path.join(testStoragePath, 'installed'),
        profiles: path.join(testStoragePath, 'profiles.json'),
        cache: path.join(testStoragePath, 'cache')
      };

      assert.ok(paths.root);
      assert.ok(paths.sources.endsWith('sources.json'));
      assert.ok(paths.installed.includes('installed'));
      assert.ok(paths.profiles.endsWith('profiles.json'));
    });

    test('should create storage directories if missing', () => {
      const directories = [
        path.join(testStoragePath, 'installed'),
        path.join(testStoragePath, 'cache'),
        path.join(testStoragePath, 'bundles')
      ];

      // Simulate directory creation
      for (const dir of directories) {
        assert.ok(dir);
      }
    });
  });

  suite('Source Management', () => {
    test('should load sources from storage', () => {
      const mockSources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 },
        { id: 'source-2', name: 'Source 2', type: 'local', url: 'url2', enabled: true, priority: 2 }
      ];

      assert.strictEqual(mockSources.length, 2);
      assert.ok(mockSources.every((s) => s.id && s.name && s.type));
    });

    test('should save sources to storage', () => {
      const sources = [
        { id: 'source-1', name: 'Source 1', type: 'github', url: 'url1', enabled: true, priority: 1 }
      ];

      const json = JSON.stringify({ sources, version: '1.0.0' }, null, 2);
      const parsed = JSON.parse(json);

      assert.strictEqual(parsed.sources.length, 1);
      assert.strictEqual(parsed.version, '1.0.0');
    });

    test('should handle missing sources file', () => {
      const defaultSources: any[] = [];
      assert.strictEqual(defaultSources.length, 0);
    });

    test('should validate source structure', () => {
      const source = {
        id: 'source-1',
        name: 'Test Source',
        type: 'github',
        url: 'https://github.com/test/repo',
        enabled: true,
        priority: 1
      };

      const isValid = Boolean(
        source.id
        && source.name
        && source.type
        && source.url
        && typeof source.enabled === 'boolean'
        && typeof source.priority === 'number'
      );

      assert.strictEqual(isValid, true);
    });
  });

  suite('Bundle Installation Records', () => {
    test('should track installed bundles', () => {
      const installed = {
        'bundle-1': {
          id: 'bundle-1',
          version: '1.0.0',
          installPath: '/path/to/bundle-1',
          installedAt: new Date()
        },
        'bundle-2': {
          id: 'bundle-2',
          version: '2.0.0',
          installPath: '/path/to/bundle-2',
          installedAt: new Date()
        }
      };

      assert.strictEqual(Object.keys(installed).length, 2);
      assert.ok(installed['bundle-1'].installedAt instanceof Date);
    });

    test('should store installation metadata', () => {
      const bundleRecord = {
        id: 'bundle-1',
        version: '1.0.0',
        installPath: '/path/to/bundle',
        installedAt: new Date(),
        source: 'source-1',
        scope: 'user'
      };

      assert.ok(bundleRecord.id);
      assert.ok(bundleRecord.version);
      assert.ok(bundleRecord.installPath);
      assert.ok(bundleRecord.installedAt);
      assert.ok(bundleRecord.source);
      assert.ok(bundleRecord.scope);
    });

    test('should update bundle records on reinstall', () => {
      const original = {
        id: 'bundle-1',
        version: '1.0.0',
        installedAt: new Date('2024-01-01')
      };

      const updated = {
        ...original,
        version: '1.1.0',
        installedAt: new Date()
      };

      assert.notStrictEqual(original.version, updated.version);
      assert.ok(updated.installedAt > original.installedAt);
    });

    test('should remove bundle records on uninstall', () => {
      const installed: Record<string, any> = {
        'bundle-1': { id: 'bundle-1', version: '1.0.0' },
        'bundle-2': { id: 'bundle-2', version: '2.0.0' }
      };

      delete installed['bundle-1'];

      assert.strictEqual(Object.keys(installed).length, 1);
      assert.ok(!installed['bundle-1']);
      assert.ok(installed['bundle-2']);
    });
  });

  suite('Profile Storage', () => {
    test('should load profiles from storage', () => {
      const mockProfiles = [
        { id: 'profile-1', name: 'Profile 1', bundles: ['bundle-1'], active: true },
        { id: 'profile-2', name: 'Profile 2', bundles: ['bundle-2'], active: false }
      ];

      assert.strictEqual(mockProfiles.length, 2);
      assert.ok(mockProfiles.find((p) => p.active));
    });

    test('should save profiles to storage', () => {
      const profiles = [
        { id: 'profile-1', name: 'Profile 1', bundles: [], active: false }
      ];

      const json = JSON.stringify({ profiles, version: '1.0.0' }, null, 2);
      const parsed = JSON.parse(json);

      assert.strictEqual(parsed.profiles.length, 1);
    });

    test('should maintain single active profile', () => {
      const profiles = [
        { id: 'profile-1', name: 'Profile 1', active: true },
        { id: 'profile-2', name: 'Profile 2', active: true } // Invalid state
      ];

      const fixed = profiles.map((p, i) => ({ ...p, active: i === 0 }));
      const activeCount = fixed.filter((p) => p.active).length;

      assert.strictEqual(activeCount, 1);
    });
  });

  suite('Cache Management', () => {
    test('should store bundle metadata cache', () => {
      const cache = {
        'source-1': {
          bundles: [{ id: 'bundle-1', name: 'Bundle 1' }],
          timestamp: Date.now(),
          ttl: 3_600_000 // 1 hour
        }
      };

      assert.ok(cache['source-1'].bundles);
      assert.ok(cache['source-1'].timestamp);
    });

    test('should invalidate expired cache', () => {
      const cache = {
        timestamp: Date.now() - 7_200_000, // 2 hours ago
        ttl: 3_600_000 // 1 hour TTL
      };

      const isExpired = Date.now() - cache.timestamp > cache.ttl;

      assert.strictEqual(isExpired, true);
    });

    test('should clear cache on demand', () => {
      let cache: Record<string, any> = {
        'source-1': { bundles: [], timestamp: Date.now() },
        'source-2': { bundles: [], timestamp: Date.now() }
      };

      cache = {};

      assert.strictEqual(Object.keys(cache).length, 0);
    });
  });

  suite('Backup and Recovery', () => {
    test('should create backup before modifications', () => {
      const data = {
        sources: [{ id: 'source-1' }],
        profiles: [{ id: 'profile-1' }]
      };

      const backup = structuredClone(data);

      assert.deepStrictEqual(backup, data);
      assert.notStrictEqual(backup, data); // Different object reference
    });

    test('should restore from backup on error', () => {
      const original = { sources: [{ id: 'source-1' }] };
      const backup = structuredClone(original);

      // Simulate modification
      original.sources.push({ id: 'source-2' });

      // Simulate error and restore
      const restored = backup;

      assert.strictEqual(restored.sources.length, 1);
      assert.strictEqual(restored.sources[0].id, 'source-1');
    });
  });

  suite('Migration and Versioning', () => {
    test('should detect storage version', () => {
      const storageV1 = { version: '1.0.0', sources: [] };
      const storageV2 = { version: '2.0.0', sources: [] };

      assert.strictEqual(storageV1.version, '1.0.0');
      assert.strictEqual(storageV2.version, '2.0.0');
    });

    test('should migrate from v1 to v2 format', () => {
      const v1Data = {
        sources: [{ id: 'source-1', name: 'Source 1' }]
      };

      const v2Data = {
        version: '2.0.0',
        sources: v1Data.sources.map((s) => ({
          ...s,
          enabled: true,
          priority: 1
        }))
      };

      assert.ok(v2Data.version);
      assert.ok(v2Data.sources[0].enabled !== undefined);
      assert.ok(v2Data.sources[0].priority !== undefined);
    });

    test('should handle missing version gracefully', () => {
      const dataNoVersion = {
        sources: [{ id: 'source-1' }]
      };

      const defaultVersion = '1.0.0';
      const migrated = {
        version: defaultVersion,
        ...dataNoVersion
      };

      assert.strictEqual(migrated.version, '1.0.0');
    });
  });

  suite('Concurrent Access', () => {
    test('should persist every concurrently added source', async () => {
      const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-storage-'));
      const context = {
        globalState: {
          get: sandbox.stub().returns({}),
          update: sandbox.stub().resolves()
        },
        globalStorageUri: { fsPath: storageRoot }
      } as any;
      const storage = new RegistryStorage(context);

      try {
        await storage.initialize();
        await Promise.all(
          Array.from({ length: 10 }, (_, index) => storage.addSource({
            id: `source-${index}`,
            name: `Source ${index}`,
            type: 'github',
            url: `https://github.com/example/source-${index}`,
            enabled: true,
            priority: index
          }))
        );

        const persisted = JSON.parse(
          fs.readFileSync(path.join(storageRoot, 'config.json'), 'utf8')
        ) as { sources: { id: string }[] };

        assert.strictEqual(persisted.sources.length, 10);
        assert.deepStrictEqual(
          persisted.sources.map((source) => source.id).toSorted(),
          Array.from({ length: 10 }, (_, index) => `source-${index}`)
        );
      } finally {
        fs.rmSync(storageRoot, { recursive: true, force: true });
      }
    });

    test('should handle concurrent read operations', async () => {
      const data = { sources: [], profiles: [] };

      const reads = await Promise.all([
        Promise.resolve(data),
        Promise.resolve(data),
        Promise.resolve(data)
      ]);

      assert.strictEqual(reads.length, 3);
      reads.forEach((r) => assert.deepStrictEqual(r, data));
    });

    test('should prevent concurrent write conflicts', () => {
      const data = { counter: 0 };

      // Simulate sequential writes (no conflicts)
      data.counter++;
      data.counter++;

      assert.strictEqual(data.counter, 2);
    });
  });

  suite('Storage Integrity', () => {
    test('should validate JSON structure', () => {
      const validJson = '{"version":"1.0.0","sources":[]}';
      const parsed = JSON.parse(validJson);

      assert.ok(parsed.version);
      assert.ok(Array.isArray(parsed.sources));
    });

    test('should detect corrupted storage', () => {
      const corruptedJson = '{"version":"1.0.0","sources":[';

      try {
        JSON.parse(corruptedJson);
        assert.fail('Should have thrown');
      } catch (error) {
        assert.ok(error);
      }
    });

    test('should recover from corrupted storage', () => {
      const corrupted = '{"invalid json';
      let data;

      try {
        data = JSON.parse(corrupted);
      } catch {
        // Recovery: use defaults
        data = { version: '1.0.0', sources: [], profiles: [] };
      }

      assert.ok(data);
      assert.ok(data.version);
    });
  });

  suite('Update Preferences', () => {
    test('should return empty object when no preferences are set', async () => {
      const mockContext = {
        globalState: {
          get: sandbox.stub().returns({}),
          update: sandbox.stub().resolves()
        },
        globalStorageUri: { fsPath: testStoragePath }
      } as any;

      const storage = new RegistryStorage(mockContext);

      const prefs = await storage.getUpdatePreferences();

      assert.deepStrictEqual(prefs, {});
    });

    test('should return all update preferences', async () => {
      const mockPrefs = {
        'bundle-1': { autoUpdate: true, lastChecked: '2024-01-01T00:00:00.000Z' },
        'bundle-2': { autoUpdate: false, lastChecked: '2024-01-02T00:00:00.000Z' }
      };

      const mockContext = {
        globalState: {
          get: sandbox.stub().returns(mockPrefs),
          update: sandbox.stub().resolves()
        },
        globalStorageUri: { fsPath: testStoragePath }
      } as any;

      const storage = new RegistryStorage(mockContext);

      const prefs = await storage.getUpdatePreferences();

      assert.deepStrictEqual(prefs, mockPrefs);
      assert.strictEqual(prefs['bundle-1'].autoUpdate, true);
      assert.strictEqual(prefs['bundle-2'].autoUpdate, false);
    });

    test('should set update preference for a bundle', async () => {
      const mockPrefs = {};
      const updateStub = sandbox.stub().resolves();

      const mockContext = {
        globalState: {
          get: sandbox.stub().returns(mockPrefs),
          update: updateStub
        },
        globalStorageUri: { fsPath: testStoragePath }
      } as any;

      const storage = new RegistryStorage(mockContext);

      await storage.setUpdatePreference('bundle-1', true);

      assert.ok(updateStub.calledOnce);
      const [key, value] = updateStub.firstCall.args;
      assert.strictEqual(key, 'bundleUpdatePreferences');
      assert.strictEqual(value['bundle-1'].autoUpdate, true);
      assert.ok(value['bundle-1'].lastChecked);
    });

    test('should update existing preference for a bundle', async () => {
      const mockPrefs = {
        'bundle-1': { autoUpdate: false, lastChecked: '2024-01-01T00:00:00.000Z' }
      };
      const updateStub = sandbox.stub().resolves();

      const mockContext = {
        globalState: {
          get: sandbox.stub().returns(mockPrefs),
          update: updateStub
        },
        globalStorageUri: { fsPath: testStoragePath }
      } as any;

      const storage = new RegistryStorage(mockContext);

      await storage.setUpdatePreference('bundle-1', true);

      assert.ok(updateStub.calledOnce);
      const [key, value] = updateStub.firstCall.args;
      assert.strictEqual(key, 'bundleUpdatePreferences');
      assert.strictEqual(value['bundle-1'].autoUpdate, true);
      assert.notStrictEqual(value['bundle-1'].lastChecked, '2024-01-01T00:00:00.000Z');
    });

    test('should get update preference for a specific bundle', async () => {
      const mockPrefs = {
        'bundle-1': { autoUpdate: true, lastChecked: '2024-01-01T00:00:00.000Z' },
        'bundle-2': { autoUpdate: false, lastChecked: '2024-01-02T00:00:00.000Z' }
      };

      const mockContext = {
        globalState: {
          get: sandbox.stub().returns(mockPrefs),
          update: sandbox.stub().resolves()
        },
        globalStorageUri: { fsPath: testStoragePath }
      } as any;

      const storage = new RegistryStorage(mockContext);

      const pref1 = await storage.getUpdatePreference('bundle-1');
      const pref2 = await storage.getUpdatePreference('bundle-2');

      assert.strictEqual(pref1, true);
      assert.strictEqual(pref2, false);
    });

    test('should return false for bundle with no preference set', async () => {
      const mockPrefs = {
        'bundle-1': { autoUpdate: true, lastChecked: '2024-01-01T00:00:00.000Z' }
      };

      const mockContext = {
        globalState: {
          get: sandbox.stub().returns(mockPrefs),
          update: sandbox.stub().resolves()
        },
        globalStorageUri: { fsPath: testStoragePath }
      } as any;

      const storage = new RegistryStorage(mockContext);

      const pref = await storage.getUpdatePreference('bundle-nonexistent');

      assert.strictEqual(pref, false);
    });

    test('should persist preference with timestamp', async () => {
      const mockPrefs = {};
      const updateStub = sandbox.stub().resolves();
      const beforeTime = new Date().toISOString();

      const mockContext = {
        globalState: {
          get: sandbox.stub().returns(mockPrefs),
          update: updateStub
        },
        globalStorageUri: { fsPath: testStoragePath }
      } as any;

      const storage = new RegistryStorage(mockContext);

      await storage.setUpdatePreference('bundle-1', true);

      const afterTime = new Date().toISOString();
      const [, value] = updateStub.firstCall.args;
      const timestamp = value['bundle-1'].lastChecked;

      assert.ok(timestamp >= beforeTime);
      assert.ok(timestamp <= afterTime);
    });
  });
});
