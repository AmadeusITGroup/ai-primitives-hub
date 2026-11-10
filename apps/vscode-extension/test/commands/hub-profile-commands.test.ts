/**
 * HubProfileCommands Unit Tests
 * Tests for hub profile command logic and data transformations
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveUserConfigPaths,
} from '@ai-primitives-hub/app';
import {
  FavoritesStore,
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  JSDOM,
} from 'jsdom';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  HubProfileCommands,
} from '../../src/commands/hub-profile-commands';
import {
  HubManager,
} from '../../src/services/hub-manager';
import {
  createHubStorage,
} from '../../src/storage/create-hub-storage';
import {
  HubStorage,
} from '../../src/storage/hub-storage';
import {
  HubConfig,
} from '../../src/types/hub';

suite('HubProfileCommands - Logic Tests', () => {
  let storage: HubStorage;
  let hubManager: HubManager;
  let tempDir: string;

  const createSampleHub = (hubId: string, profileCount: number): HubConfig => ({
    version: '1.0.0',
    metadata: {
      name: `Test Hub ${hubId}`,
      description: `Test hub with ${profileCount} profiles`,
      maintainer: 'Test',
      updatedAt: new Date().toISOString()
    },
    sources: [],
    profiles: Array.from({ length: profileCount }, (_, i) => ({
      id: `profile-${i + 1}`,
      name: `Profile ${i + 1}`,
      description: `Test profile ${i + 1}`,
      bundles: [
        {
          id: `bundle-${i + 1}`,
          version: '1.0.0',
          source: 'test-source',
          required: i % 2 === 0
        }
      ],
      icon: '📦',
      active: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }))
  });

  setup(() => {
    tempDir = path.join(__dirname, '../../test-temp-hub-profile-commands');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    storage = createHubStorage(process.env);
    hubManager = new HubManager(storage, {} as any, process.cwd(), undefined, undefined);
  });

  teardown(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  suite('Profile Data Retrieval', () => {
    test('should retrieve all profiles from multiple hubs', async () => {
      await storage.saveHub('hub-1', createSampleHub('1', 2), { type: 'github', location: 'test/hub1' });
      await storage.saveHub('hub-2', createSampleHub('2', 3), { type: 'github', location: 'test/hub2' });

      const profiles = await hubManager.listAllHubProfiles();

      assert.strictEqual(profiles.length, 5);
      assert.strictEqual(profiles.filter((p) => p.hubId === 'hub-1').length, 2);
      assert.strictEqual(profiles.filter((p) => p.hubId === 'hub-2').length, 3);
    });

    test('should include hub metadata with profiles', async () => {
      await storage.saveHub('test-hub', createSampleHub('test', 1), { type: 'github', location: 'test/hub' });

      const profiles = await hubManager.listAllHubProfiles();

      assert.strictEqual(profiles.length, 1);
      assert.strictEqual(profiles[0].hubId, 'test-hub');
      assert.strictEqual(profiles[0].hubName, 'Test Hub test');
    });

    test('should return empty array when no hubs exist', async () => {
      const profiles = await hubManager.listAllHubProfiles();
      assert.strictEqual(profiles.length, 0);
    });

    test('should handle hubs without profiles', async () => {
      const emptyHub: HubConfig = {
        version: '1.0.0',
        metadata: {
          name: 'Empty Hub',
          description: 'No profiles',
          maintainer: 'Test',
          updatedAt: new Date().toISOString()
        },
        sources: [],
        profiles: []
      };

      await storage.saveHub('empty-hub', emptyHub, { type: 'github', location: 'test/empty' });
      const profiles = await hubManager.listAllHubProfiles();

      assert.strictEqual(profiles.length, 0);
    });
  });

  suite('Profile Grouping Logic', () => {
    test('should group profiles by hub correctly', async () => {
      await storage.saveHub('hub-a', createSampleHub('A', 2), { type: 'github', location: 'test/a' });
      await storage.saveHub('hub-b', createSampleHub('B', 2), { type: 'github', location: 'test/b' });

      const profiles = await hubManager.listAllHubProfiles();

      // Group by hubId
      const grouped = new Map<string, typeof profiles>();
      for (const profile of profiles) {
        if (!grouped.has(profile.hubId)) {
          grouped.set(profile.hubId, []);
        }
        grouped.get(profile.hubId)!.push(profile);
      }

      assert.strictEqual(grouped.size, 2);
      assert.strictEqual(grouped.get('hub-a')?.length, 2);
      assert.strictEqual(grouped.get('hub-b')?.length, 2);
    });

    test('should maintain profile order within hub', async () => {
      await storage.saveHub('ordered-hub', createSampleHub('ordered', 5), { type: 'github', location: 'test/ordered' });

      const profiles = await hubManager.listAllHubProfiles();

      assert.strictEqual(profiles.length, 5);
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(profiles[i].id, `profile-${i + 1}`);
      }
    });
  });

  suite('Profile Detail Access', () => {
    test('renders imported profile metadata as text with a restrictive CSP', async () => {
      const payload = '<img src="https://example.invalid/beacon"><script>alert(1)</script><style>body{display:none}</style>';
      const hub = createSampleHub('html', 1);
      hub.metadata.name = payload;
      const profile = hub.profiles[0];
      profile.name = payload;
      profile.description = payload;
      profile.icon = payload;
      profile.createdAt = payload;
      profile.updatedAt = payload;
      profile.bundles[0] = { id: payload, version: payload, source: payload, required: true };
      await storage.saveHub('html-hub', hub, { type: 'github', location: 'test/html' });

      const sandbox = sinon.createSandbox();
      const subscriptions: vscode.Disposable[] = [];
      try {
        const panel = vscode.window.createWebviewPanel('test', 'test', vscode.ViewColumn.One, {});
        const createPanel = sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
        sandbox.stub(vscode.window, 'showInformationMessage').resolves();
        const commands = new HubProfileCommands({
          globalStorageUri: vscode.Uri.file(tempDir),
          extensionPath: path.resolve(__dirname, '../../..'),
          subscriptions
        } as vscode.ExtensionContext);
        await commands.viewHubProfile('html-hub', profile.id);
        assert.ok(createPanel.calledOnce);
        const options = createPanel.firstCall.args[3];
        assert.ok(options);
        assert.strictEqual(options.enableScripts, false);
        assert.deepStrictEqual(options.localResourceRoots, []);
        const dom = new JSDOM(panel.webview.html);
        try {
          assert.strictEqual(dom.window.document.querySelectorAll('img, script').length, 0);
          assert.strictEqual(dom.window.document.querySelectorAll('style').length, 1);
          assert.ok(dom.window.document.querySelector('h1')?.textContent?.includes(payload));
          assert.ok(dom.window.document.querySelector('td')?.textContent?.includes(payload));
          const csp = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
          assert.ok(csp?.includes("default-src 'none'"));
          assert.ok(csp?.includes("style-src 'nonce-"));
          assert.ok(!csp?.includes('unsafe-inline'));
        } finally {
          dom.window.close();
        }
      } finally {
        subscriptions.forEach((disposable) => disposable.dispose());
        sandbox.restore();
      }
    });

    test('should retrieve specific profile with all details', async () => {
      await storage.saveHub('detail-hub', createSampleHub('detail', 3), { type: 'github', location: 'test/detail' });

      const profile = await hubManager.getHubProfile('detail-hub', 'profile-2');

      assert.strictEqual(profile.id, 'profile-2');
      assert.strictEqual(profile.name, 'Profile 2');
      assert.ok(profile.bundles.length > 0);
      assert.strictEqual(profile.bundles[0].id, 'bundle-2');
    });

    test('should include bundle metadata in profile', async () => {
      await storage.saveHub('bundle-hub', createSampleHub('bundle', 1), { type: 'github', location: 'test/bundle' });

      const profile = await hubManager.getHubProfile('bundle-hub', 'profile-1');

      assert.strictEqual(profile.bundles.length, 1);
      assert.ok(profile.bundles[0].id);
      assert.ok(profile.bundles[0].version);
      assert.ok(profile.bundles[0].source);
      assert.strictEqual(typeof profile.bundles[0].required, 'boolean');
    });

    test('should handle profile with no bundles', async () => {
      const noBundlesHub: HubConfig = {
        version: '1.0.0',
        metadata: {
          name: 'No Bundles Hub',
          description: 'Profile without bundles',
          maintainer: 'Test',
          updatedAt: new Date().toISOString()
        },
        sources: [],
        profiles: [{
          id: 'empty-profile',
          name: 'Empty Profile',
          description: 'No bundles',
          bundles: [],
          icon: '',
          active: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }]
      };

      await storage.saveHub('no-bundles', noBundlesHub, { type: 'github', location: 'test/nobundles' });
      const profile = await hubManager.getHubProfile('no-bundles', 'empty-profile');

      assert.strictEqual(profile.bundles.length, 0);
    });
  });

  suite('Profile Filtering and Search', () => {
    test('should filter profiles by hub', async () => {
      await storage.saveHub('hub-1', createSampleHub('1', 3), { type: 'github', location: 'test/1' });
      await storage.saveHub('hub-2', createSampleHub('2', 2), { type: 'github', location: 'test/2' });

      const hub1Profiles = await hubManager.listProfilesFromHub('hub-1');
      const hub2Profiles = await hubManager.listProfilesFromHub('hub-2');

      assert.strictEqual(hub1Profiles.length, 3);
      assert.strictEqual(hub2Profiles.length, 2);
    });

    test('should find profiles with specific characteristics', async () => {
      await storage.saveHub('test-hub', createSampleHub('test', 4), { type: 'github', location: 'test/hub' });

      const profiles = await hubManager.listProfilesFromHub('test-hub');

      // Find profiles with required bundles (created with i % 2 === 0)
      const withRequired = profiles.filter((p) =>
        p.bundles.some((b) => b.required)
      );

      assert.strictEqual(withRequired.length, 2); // profiles 1 and 3 (0-indexed 0 and 2)
    });
  });

  suite('Hub List Access', () => {
    test('should retrieve hub list for browsing', async () => {
      await storage.saveHub('hub-1', createSampleHub('1', 1), { type: 'github', location: 'test/1' });
      await storage.saveHub('hub-2', createSampleHub('2', 1), { type: 'url', location: 'https://test.com' });

      const hubs = await hubManager.listHubs();

      assert.strictEqual(hubs.length, 2);
      assert.ok(hubs.every((h) => h.id && h.name && h.description));
    });

    test('should include reference information in hub list', async () => {
      await storage.saveHub('test-hub', createSampleHub('test', 1), { type: 'local', location: '/path/to/hub' });

      const hubs = await hubManager.listHubs();

      assert.strictEqual(hubs.length, 1);
      assert.strictEqual(hubs[0].reference.type, 'local');
      assert.strictEqual(hubs[0].reference.location, '/path/to/hub');
    });
  });

  suite('Profile Metadata Validation', () => {
    test('should have all required profile fields', async () => {
      await storage.saveHub('valid-hub', createSampleHub('valid', 1), { type: 'github', location: 'test/valid' });

      const profile = await hubManager.getHubProfile('valid-hub', 'profile-1');

      assert.ok(profile.id);
      assert.ok(profile.name);
      assert.ok(profile.description);
      assert.ok(Array.isArray(profile.bundles));
      assert.strictEqual(typeof profile.active, 'boolean');
    });

    test('should preserve profile icons', async () => {
      await storage.saveHub('icon-hub', createSampleHub('icon', 1), { type: 'github', location: 'test/icon' });

      const profile = await hubManager.getHubProfile('icon-hub', 'profile-1');

      assert.strictEqual(profile.icon, '📦');
    });

    test('should include timestamps in profiles', async () => {
      await storage.saveHub('time-hub', createSampleHub('time', 1), { type: 'github', location: 'test/time' });

      const profile = await hubManager.getHubProfile('time-hub', 'profile-1');

      assert.ok(profile.createdAt);
      assert.ok(profile.updatedAt);
    });
  });

  suite('XDG composition (ADR-0011)', () => {
    test('toggleProfileFavorite writes to the canonical shared favorites store over the shared XDG paths', async () => {
      const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-xdg-'));
      const envKeys = [
        'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
        'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP',
        'AI_PRIMITIVES_HUB_CACHE'
      ] as const;
      const savedEnv = new Map<string, string | undefined>();
      const synthetic = {
        HOME: path.join(sandboxRoot, 'home'),
        USERPROFILE: path.join(sandboxRoot, 'home'),
        XDG_CONFIG_HOME: path.join(sandboxRoot, 'xdg', 'config'),
        XDG_DATA_HOME: path.join(sandboxRoot, 'xdg', 'data'),
        XDG_CACHE_HOME: path.join(sandboxRoot, 'xdg', 'cache'),
        XDG_STATE_HOME: path.join(sandboxRoot, 'xdg', 'state'),
        TMPDIR: path.join(sandboxRoot, 'tmp'),
        TMP: path.join(sandboxRoot, 'tmp'),
        TEMP: path.join(sandboxRoot, 'tmp'),
        AI_PRIMITIVES_HUB_CACHE: path.join(sandboxRoot, 'aph-cache')
      };
      const sinonSandbox = sinon.createSandbox();
      const subscriptions: vscode.Disposable[] = [];
      try {
        for (const key of envKeys) {
          savedEnv.set(key, process.env[key]);
          process.env[key] = synthetic[key];
        }
        const paths = resolveUserConfigPaths(process.env);
        const canonical = new HubStorage(paths.hubs, {
          activeHubPath: paths.activeHub,
          cacheMode: 'stateless'
        });
        await canonical.saveHub('shared-hub', createSampleHub('shared', 1), { type: 'local', location: '/fixture/hub' });

        const showError = sinonSandbox.stub(vscode.window, 'showErrorMessage').resolves();
        sinonSandbox.stub(vscode.window, 'showInformationMessage').resolves();
        const commands = new HubProfileCommands({
          get globalStorageUri(): never {
            throw new Error('globalStorageUri must not be read in XDG composition');
          },
          get globalState(): never {
            throw new Error('globalState must not be read in XDG composition');
          },
          extensionPath: process.cwd(),
          secrets: undefined,
          subscriptions
        } as unknown as vscode.ExtensionContext);

        await commands.toggleProfileFavorite({ hubId: 'shared-hub', profileId: 'profile-1' });

        const favoritesPath = path.join(paths.hubs, 'favorites.json');
        const favorites = await new FavoritesStore(favoritesPath, new NodeFileSystem()).get();
        assert.deepStrictEqual(favorites, { 'shared-hub': ['profile-1'] });
        assert.ok(showError.notCalled, 'no error notification expected');
      } finally {
        for (const [key, value] of savedEnv) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        subscriptions.forEach((disposable) => disposable.dispose());
        sinonSandbox.restore();
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
      }
    });
  });

  suite('Error Handling', () => {
    test('should handle non-existent hub gracefully', async () => {
      await assert.rejects(
        async () => await hubManager.listProfilesFromHub('non-existent'),
        (err: Error) => {
          assert.ok(err.message.includes('Hub not found'));
          return true;
        }
      );
    });

    test('should handle non-existent profile gracefully', async () => {
      await storage.saveHub('test-hub', createSampleHub('test', 1), { type: 'github', location: 'test/hub' });

      await assert.rejects(
        async () => await hubManager.getHubProfile('test-hub', 'non-existent'),
        (err: Error) => {
          assert.ok(err.message.includes('Profile not found'));
          return true;
        }
      );
    });
  });
});
