/**
 * Tests for app/registry/deactivate-registry-profile.ts.
 *
 * Ported behavior coverage from the extension's
 * `RegistryManager.deactivateProfile`, translated into example-based
 * Vitest cases now that it's a standalone, port-driven function.
 */
import type {
  HubProfileSync,
  HubProfileWithMetadata,
  InstalledBundle,
  Profile,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  DeactivateRegistryProfilePorts,
} from '../../src/registry';
import {
  deactivateRegistryProfile,
} from '../../src/registry';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    description: 'Test profile',
    icon: '📦',
    bundles: [],
    active: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeHubProfile(overrides: Partial<HubProfileWithMetadata> = {}): HubProfileWithMetadata {
  return {
    ...makeProfile(),
    bundles: [],
    hubId: 'hub-1',
    hubName: 'Hub 1',
    ...overrides
  };
}

function makeInstalled(overrides: Partial<InstalledBundle> = {}): InstalledBundle {
  return {
    bundleId: 'bundle-1',
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00.000Z',
    scope: 'user',
    installPath: '/mock/path',
    manifest: {
      common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
      bundle_settings: { include_common_in_environment_bundles: false, create_common_bundle: false, compression: 'none', naming: { environment_bundle: 'bundle-1' } },
      metadata: { manifest_version: '1.0.0', description: 'Test' }
    },
    ...overrides
  };
}

function makeHubSync(overrides: Partial<HubProfileSync> = {}): HubProfileSync {
  return {
    listActiveHubProfiles: async () => [],
    listAllActiveProfiles: async () => [],
    activateProfile: async () => undefined,
    deactivateProfile: async () => undefined,
    ...overrides
  };
}

function makePorts(overrides: Partial<DeactivateRegistryProfilePorts> = {}): DeactivateRegistryProfilePorts {
  return {
    getProfiles: async () => [],
    updateProfile: async () => {},
    getInstalledBundles: async () => [],
    uninstallBundles: async () => {},
    ...overrides
  };
}

describe('deactivateRegistryProfile', () => {
  it('delegates to the hub sync port when the profile is hub-provided', async () => {
    let deactivateArgs: [string, string] | undefined;
    const ports = makePorts({
      hub: makeHubSync({
        listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-profile', hubId: 'hub-1' })],
        deactivateProfile: async (hubId, profileId) => {
          deactivateArgs = [hubId, profileId];
        }
      })
    });

    await deactivateRegistryProfile(ports, 'hub-profile');

    expect(deactivateArgs).toEqual(['hub-1', 'hub-profile']);
  });

  it('uninstalls only bundles recorded against the hub profile id', async () => {
    const bundles = [
      makeInstalled({ bundleId: 'a', profileId: 'hub-profile' }),
      makeInstalled({ bundleId: 'b', profileId: 'other-profile' })
    ];
    let uninstallIds: string[] | undefined;
    const ports = makePorts({
      getInstalledBundles: async () => bundles,
      uninstallBundles: async (ids) => {
        uninstallIds = ids;
      },
      hub: makeHubSync({
        listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-profile', hubId: 'hub-1' })]
      })
    });

    await deactivateRegistryProfile(ports, 'hub-profile');

    expect(uninstallIds).toEqual(['a']);
  });

  it('does not call uninstallBundles for a hub profile with no matching installed bundles', async () => {
    let uninstallCalled = false;
    const ports = makePorts({
      getInstalledBundles: async () => [],
      uninstallBundles: async () => {
        uninstallCalled = true;
      },
      hub: makeHubSync({
        listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-profile', hubId: 'hub-1' })]
      })
    });

    await deactivateRegistryProfile(ports, 'hub-profile');

    expect(uninstallCalled).toBe(false);
  });

  it('falls through to the local path when no hub is wired', async () => {
    const profile = makeProfile({ id: 'local-profile', active: true });
    let updateArgs: [string, Partial<Profile>] | undefined;
    const ports = makePorts({
      getProfiles: async () => [profile],
      updateProfile: async (profileId, updates) => {
        updateArgs = [profileId, updates];
      }
    });

    await deactivateRegistryProfile(ports, 'local-profile');

    expect(updateArgs).toEqual(['local-profile', { active: false }]);
  });

  it('falls through to the local path when the hub is wired but has no matching profile', async () => {
    const profile = makeProfile({ id: 'local-profile', active: true });
    let updateCalled = false;
    const ports = makePorts({
      getProfiles: async () => [profile],
      updateProfile: async () => {
        updateCalled = true;
      },
      hub: makeHubSync({ listActiveHubProfiles: async () => [] })
    });

    await deactivateRegistryProfile(ports, 'local-profile');

    expect(updateCalled).toBe(true);
  });

  it('throws when the local profile id does not exist', async () => {
    const ports = makePorts({ getProfiles: async () => [] });

    await expect(deactivateRegistryProfile(ports, 'missing')).rejects.toThrow('Profile not found: missing');
  });

  it('always calls uninstallBundles for the local path, even with zero matching bundles', async () => {
    const profile = makeProfile({ id: 'local-profile' });
    let uninstallIds: string[] | undefined;
    const ports = makePorts({
      getProfiles: async () => [profile],
      getInstalledBundles: async () => [],
      uninstallBundles: async (ids) => {
        uninstallIds = ids;
      }
    });

    await deactivateRegistryProfile(ports, 'local-profile');

    expect(uninstallIds).toEqual([]);
  });

  it('uninstalls only bundles recorded against the local profile id', async () => {
    const profile = makeProfile({ id: 'local-profile' });
    const bundles = [
      makeInstalled({ bundleId: 'a', profileId: 'local-profile' }),
      makeInstalled({ bundleId: 'b', profileId: 'other-profile' })
    ];
    let uninstallIds: string[] | undefined;
    const ports = makePorts({
      getProfiles: async () => [profile],
      getInstalledBundles: async () => bundles,
      uninstallBundles: async (ids) => {
        uninstallIds = ids;
      }
    });

    await deactivateRegistryProfile(ports, 'local-profile');

    expect(uninstallIds).toEqual(['a']);
  });

  it('flags the local profile inactive after uninstalling its bundles', async () => {
    const profile = makeProfile({ id: 'local-profile' });
    let updateArgs: [string, Partial<Profile>] | undefined;
    const ports = makePorts({
      getProfiles: async () => [profile],
      updateProfile: async (profileId, updates) => {
        updateArgs = [profileId, updates];
      }
    });

    await deactivateRegistryProfile(ports, 'local-profile');

    expect(updateArgs).toEqual(['local-profile', { active: false }]);
  });

  it('emits log events without throwing when onLog is omitted', async () => {
    const ports = makePorts({ getProfiles: async () => [makeProfile({ id: 'local-profile' })] });

    await expect(deactivateRegistryProfile(ports, 'local-profile')).resolves.toBeUndefined();
  });

  it('emits an info log when starting and when delegating to the hub', async () => {
    const ports = makePorts({
      hub: makeHubSync({
        listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-profile', hubId: 'hub-1' })]
      })
    });
    const events: string[] = [];

    await deactivateRegistryProfile(ports, 'hub-profile', (event) => events.push(`${event.level}:${event.message}`));

    expect(events).toContain('info:Deactivating profile: hub-profile');
    expect(events).toContain('info:Profile hub-profile is from hub, delegating to HubManager');
    expect(events).toContain('info:Profile deactivated: hub-profile');
  });
});
