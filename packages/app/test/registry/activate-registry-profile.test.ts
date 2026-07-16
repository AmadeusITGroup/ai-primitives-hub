/**
 * Tests for app/registry/activate-registry-profile.ts.
 *
 * Ported behavior coverage from the extension's
 * `RegistryManager.activateProfile` and its private
 * `validateProfileId`/`deactivateOtherProfiles`/`getProfileById`/
 * `installProfileBundles`/`installProfileBundle` helpers, translated
 * into example-based Vitest cases now that the orchestration is a
 * standalone, port-driven function.
 */
import type {
  Bundle,
  HubProfileSync,
  HubProfileWithMetadata,
  InstalledBundle,
  Profile,
  ProfileBundle,
  RegistrySource,
  SourceAdapter,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  ActivateRegistryProfilePorts,
} from '../../src/registry';
import {
  activateRegistryProfile,
} from '../../src/registry';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    description: 'Test profile',
    icon: '📦',
    bundles: [],
    active: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  };
}

function makeProfileBundle(overrides: Partial<ProfileBundle> = {}): ProfileBundle {
  return {
    id: 'bundle-1',
    version: 'latest',
    required: true,
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

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-1',
    name: 'Bundle 1',
    version: '1.0.0',
    description: 'Test',
    author: 'author',
    sourceId: 'source-1',
    environments: [],
    tags: [],
    lastUpdated: '2024-01-01T00:00:00.000Z',
    size: '1KB',
    dependencies: [],
    license: 'MIT',
    manifestUrl: 'https://example.com/manifest',
    downloadUrl: 'https://example.com/download',
    ...overrides
  };
}

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'source-1',
    name: 'Source 1',
    type: 'github',
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
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

function makeAdapter(overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    type: 'github',
    source: makeSource(),
    fetchBundles: async () => [],
    downloadBundle: async () => Buffer.from('zip-bytes'),
    fetchMetadata: async () => ({ name: 'Source 1', description: 'Test source', bundleCount: 1, lastUpdated: '2024-01-01T00:00:00.000Z', version: '1.0.0' }),
    validate: async () => ({ valid: true, errors: [], warnings: [] }),
    requiresAuthentication: () => false,
    getManifestUrl: () => 'https://example.com/manifest',
    getDownloadUrl: () => 'https://example.com/download',
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

function makePorts(overrides: Partial<ActivateRegistryProfilePorts> = {}): ActivateRegistryProfilePorts {
  return {
    getProfiles: async () => [],
    updateProfile: async () => {},
    getSources: async () => [],
    getInstalledBundles: async () => [],
    searchBundles: async () => [],
    getAdapter: () => makeAdapter(),
    installFromBuffer: async () => makeInstalled(),
    recordInstallation: async () => {},
    deactivateOther: async () => {},
    ...overrides
  };
}

describe('activateRegistryProfile', () => {
  it('accepts a legacy {id} object in place of a plain string profileId', async () => {
    const profile = makeProfile({ id: 'legacy-profile' });
    const ports = makePorts({ getProfiles: async () => [profile] });

    const result = await activateRegistryProfile(ports, { id: 'legacy-profile' });

    expect(result.localActivation?.profile.id).toBe('legacy-profile');
  });

  it('throws for a profileId that is neither a string nor an {id} object', async () => {
    const ports = makePorts();

    await expect(activateRegistryProfile(ports, 42)).rejects.toThrow('Invalid profile identifier');
  });

  describe('hub-provided profile path', () => {
    it('delegates to hub.activateProfile and returns hubActivation, without touching local profile installs', async () => {
      const hubProfile = makeHubProfile({ id: 'hub-profile', hubId: 'hub-1' });
      let activateArgs: [string, string, { installBundles: boolean }] | undefined;
      let updateProfileCalled = false;
      const ports = makePorts({
        hub: makeHubSync({
          listActiveHubProfiles: async () => [hubProfile],
          activateProfile: async (hubId, profileId, options) => {
            activateArgs = [hubId, profileId, options];
            return undefined;
          }
        }),
        updateProfile: async () => {
          updateProfileCalled = true;
        }
      });

      const result = await activateRegistryProfile(ports, 'hub-profile');

      expect(activateArgs).toEqual(['hub-1', 'hub-profile', { installBundles: true }]);
      expect(result).toEqual({ hubActivation: { hubProfile } });
      expect(updateProfileCalled).toBe(false);
    });

    it('deactivates other active hub profiles first, skipping the target', async () => {
      const deactivated: string[] = [];
      const ports = makePorts({
        hub: makeHubSync({
          listAllActiveProfiles: async () => [
            { hubId: 'hub-1', profileId: 'other-hub-profile', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] },
            { hubId: 'hub-1', profileId: 'hub-profile', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] }
          ],
          listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-profile', hubId: 'hub-1' })]
        }),
        deactivateOther: async (profileId) => {
          deactivated.push(profileId);
        }
      });

      await activateRegistryProfile(ports, 'hub-profile');

      expect(deactivated).toContain('other-hub-profile');
      expect(deactivated).not.toContain('hub-profile');
    });

    it('continues activation when deactivating another hub profile throws', async () => {
      const ports = makePorts({
        hub: makeHubSync({
          listAllActiveProfiles: async () => [
            { hubId: 'hub-1', profileId: 'failing-profile', activatedAt: '2024-01-01T00:00:00.000Z', syncedBundles: [] }
          ],
          listActiveHubProfiles: async () => [makeHubProfile({ id: 'hub-profile', hubId: 'hub-1' })]
        }),
        deactivateOther: async () => {
          throw new Error('boom');
        }
      });

      const result = await activateRegistryProfile(ports, 'hub-profile');

      expect(result.hubActivation?.hubProfile.id).toBe('hub-profile');
    });
  });

  describe('local profile path', () => {
    it('throws when the local profile cannot be found', async () => {
      const ports = makePorts({ getProfiles: async () => [] });

      await expect(activateRegistryProfile(ports, 'missing')).rejects.toThrow('Profile not found: missing');
    });

    it('deactivates other active local profiles twice (preserves the original redundant second pass)', async () => {
      const target = makeProfile({ id: 'target', active: false });
      const other = makeProfile({ id: 'other', active: true });
      const deactivated: string[] = [];
      const ports = makePorts({
        getProfiles: async () => [target, other],
        deactivateOther: async (profileId) => {
          deactivated.push(profileId);
        }
      });

      await activateRegistryProfile(ports, 'target');

      expect(deactivated).toEqual(['other', 'other']);
    });

    it('never deactivates the target profile itself', async () => {
      const target = makeProfile({ id: 'target', active: true });
      const deactivated: string[] = [];
      const ports = makePorts({
        getProfiles: async () => [target],
        deactivateOther: async (profileId) => {
          deactivated.push(profileId);
        }
      });

      await activateRegistryProfile(ports, 'target');

      expect(deactivated).toEqual([]);
    });

    it('continues activation when deactivating another local profile throws', async () => {
      const target = makeProfile({ id: 'target' });
      const other = makeProfile({ id: 'other', active: true });
      const ports = makePorts({
        getProfiles: async () => [target, other],
        deactivateOther: async () => {
          throw new Error('boom');
        }
      });

      const result = await activateRegistryProfile(ports, 'target');

      expect(result.localActivation?.profile.id).toBe('target');
    });

    it('flags the profile active and returns installedBundles: [] when it has no bundles', async () => {
      const target = makeProfile({ id: 'target', bundles: [] });
      let updateArgs: [string, Partial<Profile>] | undefined;
      let sourcesFetched = false;
      const ports = makePorts({
        getProfiles: async () => [target],
        updateProfile: async (profileId, updates) => {
          updateArgs = [profileId, updates];
        },
        getSources: async () => {
          sourcesFetched = true;
          return [];
        }
      });

      const result = await activateRegistryProfile(ports, 'target');

      expect(result.localActivation).toEqual({ profile: target, installedBundles: [] });
      expect(updateArgs).toEqual(['target', { active: true }]);
      expect(sourcesFetched).toBe(false);
    });

    describe('bundle installation', () => {
      it('skips a bundle that is already installed', async () => {
        const target = makeProfile({ bundles: [makeProfileBundle({ id: 'bundle-1' })] });
        let searchCalled = false;
        const ports = makePorts({
          getProfiles: async () => [target],
          getInstalledBundles: async () => [makeInstalled({ bundleId: 'bundle-1' })],
          searchBundles: async () => {
            searchCalled = true;
            return [];
          }
        });

        const result = await activateRegistryProfile(ports, 'profile-1');

        expect(result.localActivation?.installedBundles).toEqual([]);
        expect(searchCalled).toBe(false);
      });

      it('skips a bundle for which search returns no match', async () => {
        const target = makeProfile({ bundles: [makeProfileBundle({ id: 'no-match' })] });
        const ports = makePorts({
          getProfiles: async () => [target],
          searchBundles: async () => [makeBundle({ id: 'unrelated', name: 'Unrelated' })]
        });

        const result = await activateRegistryProfile(ports, 'profile-1');

        expect(result.localActivation?.installedBundles).toEqual([]);
      });

      it('matches a bundle by exact id and installs it', async () => {
        const target = makeProfile({ bundles: [makeProfileBundle({ id: 'bundle-1' })] });
        const bundle = makeBundle({ id: 'bundle-1', sourceId: 'source-1' });
        const installed = makeInstalled({ bundleId: 'bundle-1' });
        let recordedInstallation: InstalledBundle | undefined;
        const ports = makePorts({
          getProfiles: async () => [target],
          getSources: async () => [makeSource({ id: 'source-1' })],
          searchBundles: async () => [bundle],
          installFromBuffer: async () => installed,
          recordInstallation: async (installation) => {
            recordedInstallation = installation;
          }
        });

        const result = await activateRegistryProfile(ports, 'profile-1');

        expect(result.localActivation?.installedBundles).toEqual([{ ...installed, sourceId: 'source-1', sourceType: 'github' }]);
        expect(recordedInstallation).toEqual(result.localActivation?.installedBundles[0]);
      });

      it('matches a bundle by name substring when the id does not match exactly', async () => {
        const target = makeProfile({ bundles: [makeProfileBundle({ id: 'my-bundle' })] });
        const bundle = makeBundle({ id: 'owner-my-bundle-repo', name: 'Prefix My-Bundle Suffix', sourceId: 'source-1' });
        const ports = makePorts({
          getProfiles: async () => [target],
          getSources: async () => [makeSource({ id: 'source-1' })],
          searchBundles: async () => [bundle]
        });

        const result = await activateRegistryProfile(ports, 'profile-1');

        expect(result.localActivation?.installedBundles).toHaveLength(1);
      });

      it('requires both an id/name match and a sourceId match when the profile bundle pins a sourceId', async () => {
        const target = makeProfile({ bundles: [makeProfileBundle({ id: 'bundle-1', sourceId: 'source-2' })] });
        const wrongSource = makeBundle({ id: 'bundle-1', sourceId: 'source-1' });
        const ports = makePorts({
          getProfiles: async () => [target],
          getSources: async () => [makeSource({ id: 'source-1' }), makeSource({ id: 'source-2' })],
          searchBundles: async () => [wrongSource]
        });

        const result = await activateRegistryProfile(ports, 'profile-1');

        expect(result.localActivation?.installedBundles).toEqual([]);
      });

      it('skips a matched bundle whose source cannot be resolved', async () => {
        const target = makeProfile({ bundles: [makeProfileBundle({ id: 'bundle-1' })] });
        const bundle = makeBundle({ id: 'bundle-1', sourceId: 'missing-source' });
        const ports = makePorts({
          getProfiles: async () => [target],
          getSources: async () => [],
          searchBundles: async () => [bundle]
        });

        const result = await activateRegistryProfile(ports, 'profile-1');

        expect(result.localActivation?.installedBundles).toEqual([]);
      });

      it('catches a per-bundle installation failure and continues with the rest', async () => {
        const target = makeProfile({
          bundles: [makeProfileBundle({ id: 'failing' }), makeProfileBundle({ id: 'ok' })]
        });
        const ports = makePorts({
          getProfiles: async () => [target],
          getSources: async () => [makeSource({ id: 'source-1' })],
          searchBundles: async (query) => [makeBundle({ id: String(query.text), sourceId: 'source-1' })],
          getAdapter: () => makeAdapter({
            downloadBundle: async (bundle) => {
              if (bundle.id === 'failing') {
                throw new Error('download failed');
              }
              return Buffer.from('zip-bytes');
            }
          })
        });
        const events: string[] = [];

        const result = await activateRegistryProfile(ports, 'profile-1', (event) => events.push(`${event.level}:${event.message}`));

        expect(result.localActivation?.installedBundles).toHaveLength(1);
        expect(result.localActivation?.installedBundles[0].bundleId).toBe('bundle-1');
        expect(events.some((e) => e.startsWith('error:Failed to install bundle failing'))).toBe(true);
      });

      it('installs more bundles than fit in a single batch', async () => {
        const bundleIds = Array.from({ length: 7 }, (_, i) => `bundle-${i}`);
        const target = makeProfile({ bundles: bundleIds.map((id) => makeProfileBundle({ id })) });
        const ports = makePorts({
          getProfiles: async () => [target],
          getSources: async () => [makeSource({ id: 'source-1' })],
          searchBundles: async (query) => [makeBundle({ id: String(query.text), name: String(query.text), sourceId: 'source-1' })],
          installFromBuffer: async (bundle) => makeInstalled({ bundleId: bundle.id })
        });

        const result = await activateRegistryProfile(ports, 'profile-1');

        expect(result.localActivation?.installedBundles).toHaveLength(7);
      });
    });
  });

  it('emits log events without throwing when onLog is omitted', async () => {
    const ports = makePorts({ getProfiles: async () => [makeProfile({ id: 'profile-1' })] });

    await expect(activateRegistryProfile(ports, 'profile-1')).resolves.toBeDefined();
  });

  it('emits info logs at each checkpoint for the local path', async () => {
    const ports = makePorts({ getProfiles: async () => [makeProfile({ id: 'profile-1' })] });
    const events: string[] = [];

    await activateRegistryProfile(ports, 'profile-1', (event) => events.push(`${event.level}:${event.message}`));

    expect(events).toContain('info:Activating profile: profile-1');
    expect(events).toContain('info:Deactivating other profiles...');
    expect(events).toContain('info:Installing bundles...');
    expect(events).toContain("info:Profile 'profile-1' activated successfully");
  });
});
