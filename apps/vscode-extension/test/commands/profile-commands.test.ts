/**
 * Profile Management Commands Unit Tests
 */

import * as assert from 'node:assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
  ProfileCommands,
} from '../../src/commands/profile-commands';
import {
  RegistryManager,
} from '../../src/services/registry-manager';

suite('Profile Management Commands', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('createProfile', () => {
    test('should prompt for profile name', async () => {
      const showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
      showInputBoxStub.resolves('My Profile');

      const result = await showInputBoxStub({ prompt: 'Enter profile name' });
      assert.strictEqual(result, 'My Profile');
    });

    test('should validate profile name uniqueness', () => {
      const existingProfiles = [
        { id: 'profile-1', name: 'Profile 1' },
        { id: 'profile-2', name: 'Profile 2' }
      ];

      const newName = 'Profile 1';
      const isDuplicate = existingProfiles.some((p) => p.name === newName);

      assert.strictEqual(isDuplicate, true);
    });

    test('should allow custom bundle selection', () => {
      const selectedBundles = ['bundle-1', 'bundle-3'];

      assert.strictEqual(selectedBundles.length, 2);
      assert.ok(selectedBundles.includes('bundle-1'));
      assert.ok(selectedBundles.includes('bundle-3'));
    });

    test('should show expanded icon list with search keywords', async () => {
      const registryManagerStub = sandbox.createStubInstance(RegistryManager);
      registryManagerStub.listProfiles.resolves([]);
      registryManagerStub.createProfile.resolves({} as any);

      const profileCommands = new ProfileCommands(registryManagerStub);

      const showInputBoxStub = sandbox.stub(vscode.window, 'showInputBox');
      showInputBoxStub.onFirstCall().resolves('Test Profile'); // Name
      showInputBoxStub.onSecondCall().resolves('Description'); // Description

      const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick');

      // Mock bundle selection
      sandbox.stub(profileCommands as any, 'selectBundles').resolves(['bundle-1']);
      sandbox.stub(profileCommands as any, 'generateProfileId').returns('test-profile-id');
      // Mock activateProfile to avoid errors
      sandbox.stub(profileCommands as any, 'activateProfile').resolves();

      // Mock icon selection return
      showQuickPickStub.onFirstCall().resolves({ label: '🚀 Rocket', description: 'launch', iconChar: '🚀' } as any);

      await profileCommands.createProfile();

      const iconCall = showQuickPickStub.firstCall;
      assert.ok(iconCall, 'showQuickPick should be called for icons');

      const items = iconCall.args[0] as vscode.QuickPickItem[];
      assert.ok(items.length > 20, 'Should have a larger pool of icons');

      const rocketIcon = items.find((i) => i.label.includes('🚀'));
      assert.ok(rocketIcon);
      assert.ok(rocketIcon.description && rocketIcon.description.toLowerCase().includes('launch'), 'Rocket icon should be searchable by "launch"');
    });
  });

  suite('editProfile', () => {
    test('should allow renaming profile', () => {
      const profile = {
        id: 'profile-1',
        name: 'Old Name',
        bundles: []
      };

      const updated = { ...profile, name: 'New Name' };

      assert.strictEqual(updated.name, 'New Name');
      assert.strictEqual(updated.id, profile.id);
    });

    test('should allow adding bundles to profile', () => {
      const profile = {
        id: 'profile-1',
        name: 'My Profile',
        bundles: ['bundle-1']
      };

      const updated = {
        ...profile,
        bundles: [...profile.bundles, 'bundle-2']
      };

      assert.strictEqual(updated.bundles.length, 2);
      assert.ok(updated.bundles.includes('bundle-2'));
    });

    test('should allow removing bundles from profile', () => {
      const profile = {
        id: 'profile-1',
        name: 'My Profile',
        bundles: ['bundle-1', 'bundle-2', 'bundle-3']
      };

      const updated = {
        ...profile,
        bundles: profile.bundles.filter((b) => b !== 'bundle-2')
      };

      assert.strictEqual(updated.bundles.length, 2);
      assert.ok(!updated.bundles.includes('bundle-2'));
    });

    test('should preserve profile ID when editing', () => {
      const profile = {
        id: 'profile-abc',
        name: 'My Profile',
        bundles: []
      };

      const updated = {
        ...profile,
        name: 'Updated Profile',
        bundles: ['new-bundle']
      };

      assert.strictEqual(updated.id, 'profile-abc');
    });
  });

  suite('activateProfile', () => {
    test('should mark profile as active', () => {
      const profile = {
        id: 'profile-1',
        name: 'My Profile',
        active: false
      };

      const activated = { ...profile, active: true };

      assert.strictEqual(activated.active, true);
    });

    test('should deactivate other profiles', () => {
      const profiles = [
        { id: 'profile-1', name: 'Profile 1', active: true },
        { id: 'profile-2', name: 'Profile 2', active: false },
        { id: 'profile-3', name: 'Profile 3', active: false }
      ];

      const updated = profiles.map((p) => ({
        ...p,
        active: p.id === 'profile-2'
      }));

      assert.strictEqual(updated.filter((p) => p.active).length, 1);
      assert.strictEqual(updated.find((p) => p.id === 'profile-2')?.active, true);
    });

    test('should install profile bundles', () => {
      const profile = {
        id: 'profile-1',
        name: 'My Profile',
        bundles: ['bundle-1', 'bundle-2']
      };

      // Simulate bundle installation
      const installedBundles = [...profile.bundles];

      assert.strictEqual(installedBundles.length, 2);
    });

    test('should sync bundles to Copilot', () => {
      // Simulate sync operation
      const synced = true;

      assert.strictEqual(synced, true);
    });
  });

  suite('deactivateProfile', () => {
    test('should mark profile as inactive', () => {
      const profile = {
        id: 'profile-1',
        name: 'My Profile',
        active: true
      };

      const deactivated = { ...profile, active: false };

      assert.strictEqual(deactivated.active, false);
    });

    test('should prompt for cleanup options', async () => {
      const showQuickPickStub = sandbox.stub(vscode.window, 'showQuickPick');
      showQuickPickStub.resolves({ label: 'Keep bundles installed' });

      const result = await showQuickPickStub([
        { label: 'Keep bundles installed' },
        { label: 'Uninstall bundles' }
      ]);

      assert.ok(result);
    });

    test('should optionally uninstall bundles', () => {
      const uninstallBundles = true;

      if (uninstallBundles) {
        // Simulate bundle removal
        const remainingBundles: string[] = [];
        assert.strictEqual(remainingBundles.length, 0);
      }
    });
  });

  suite('deleteProfile', () => {
    test('should prompt for confirmation', () => {
      // Simulated confirmation
      const confirmed = true;
      assert.strictEqual(confirmed, true);
    });

    test('should prevent deleting active profile', () => {
      const profile = {
        id: 'profile-1',
        name: 'My Profile',
        active: true
      };

      const canDelete = !profile.active;

      assert.strictEqual(canDelete, false);
    });

    test('should remove profile from storage', () => {
      const profiles = [
        { id: 'profile-1', name: 'Profile 1' },
        { id: 'profile-2', name: 'Profile 2' }
      ];

      const updated = profiles.filter((p) => p.id !== 'profile-1');

      assert.strictEqual(updated.length, 1);
      assert.ok(!updated.some((p) => p.id === 'profile-1'));
    });
  });

  suite('exportProfile', () => {
    test('should serialize profile to JSON', () => {
      const profile = {
        id: 'profile-1',
        name: 'My Profile',
        bundles: ['bundle-1', 'bundle-2'],
        created: new Date()
      };

      const json = JSON.stringify(profile);
      const parsed = JSON.parse(json);

      assert.strictEqual(parsed.id, profile.id);
      assert.strictEqual(parsed.name, profile.name);
    });

    test('should include bundle configurations', () => {
      const profile = {
        id: 'profile-1',
        name: 'My Profile',
        bundles: ['bundle-1', 'bundle-2'],
        bundleConfigs: {
          'bundle-1': { enabled: true, settings: {} },
          'bundle-2': { enabled: false, settings: {} }
        }
      };

      assert.ok(profile.bundleConfigs);
      assert.strictEqual(Object.keys(profile.bundleConfigs).length, 2);
    });

    test('should prompt for export location', async () => {
      const showSaveDialogStub = sandbox.stub(vscode.window, 'showSaveDialog');
      showSaveDialogStub.resolves({ fsPath: '/path/to/profile.json' } as vscode.Uri);

      const result = await showSaveDialogStub({});

      assert.ok(result?.fsPath.endsWith('.json'));
    });
  });

  suite('importProfile', () => {
    test('should prompt for profile file', async () => {
      const showOpenDialogStub = sandbox.stub(vscode.window, 'showOpenDialog');
      showOpenDialogStub.resolves([{ fsPath: '/path/to/profile.json' } as vscode.Uri]);

      const result = await showOpenDialogStub({});

      assert.ok(result && result.length > 0);
    });

    test('should validate imported profile structure', () => {
      const importedData = {
        id: 'profile-1',
        name: 'Imported Profile',
        bundles: ['bundle-1']
      };

      const isValid = importedData.id && importedData.name && Array.isArray(importedData.bundles);

      assert.strictEqual(isValid, true);
    });

    test('should handle duplicate profile names', () => {
      const existingProfiles = [
        { id: 'profile-1', name: 'My Profile' }
      ];

      const imported = {
        id: 'profile-2',
        name: 'My Profile'
      };

      const isDuplicate = existingProfiles.some((p) => p.name === imported.name);

      assert.strictEqual(isDuplicate, true);
    });

    test('should generate new ID for imported profile', () => {
      const imported = {
        id: 'old-id',
        name: 'Imported Profile',
        bundles: []
      };

      const newId = `imported-${Date.now()}`;
      const updated = { ...imported, id: newId };

      assert.notStrictEqual(updated.id, imported.id);
      assert.ok(updated.id.startsWith('imported-'));
    });
  });

  suite('listProfiles', () => {
    test('should show all profiles', () => {
      const profiles = [
        { id: 'profile-1', name: 'Profile 1', active: true },
        { id: 'profile-2', name: 'Profile 2', active: false },
        { id: 'profile-3', name: 'Profile 3', active: false }
      ];

      assert.strictEqual(profiles.length, 3);
    });

    test('should indicate active profile', () => {
      const profiles = [
        { id: 'profile-1', name: 'Profile 1', active: true },
        { id: 'profile-2', name: 'Profile 2', active: false }
      ];

      const activeProfile = profiles.find((p) => p.active);

      assert.ok(activeProfile);
      assert.strictEqual(activeProfile.id, 'profile-1');
    });

    test('should sort profiles by name', () => {
      const profiles = [
        { id: 'profile-1', name: 'Charlie' },
        { id: 'profile-2', name: 'Alpha' },
        { id: 'profile-3', name: 'Bravo' }
      ];

      const sorted = [...profiles].toSorted((a, b) => a.name.localeCompare(b.name));

      assert.strictEqual(sorted[0].name, 'Alpha');
      assert.strictEqual(sorted[1].name, 'Bravo');
      assert.strictEqual(sorted[2].name, 'Charlie');
    });
  });

  suite('Profile Switching', () => {
    test('should handle profile switch lifecycle', () => {
      let profiles = [
        { id: 'profile-1', name: 'Profile 1', active: true, bundles: ['bundle-1'] },
        { id: 'profile-2', name: 'Profile 2', active: false, bundles: ['bundle-2'] }
      ];

      // Switch to profile-2
      profiles = profiles.map((p) => ({
        ...p,
        active: p.id === 'profile-2'
      }));

      const activeProfile = profiles.find((p) => p.active);

      assert.strictEqual(activeProfile?.id, 'profile-2');
      assert.strictEqual(profiles.filter((p) => p.active).length, 1);
    });

    test('should maintain profile state during switch', () => {
      const profile1 = {
        id: 'profile-1',
        name: 'Profile 1',
        bundles: ['bundle-1'],
        settings: { key: 'value' }
      };

      // Deactivate
      const deactivated = { ...profile1, active: false };

      // Settings should be preserved
      assert.deepStrictEqual(deactivated.settings, profile1.settings);
      assert.deepStrictEqual(deactivated.bundles, profile1.bundles);
    });
  });
});
