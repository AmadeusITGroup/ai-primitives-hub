/**
 * Tests for app/registry/install-registry-bundle.ts.
 *
 * Ported behavior coverage from the extension's
 * `RegistryManager.installBundle` and its private
 * `checkExistingInstallation`/`getSourceForBundle`/`downloadAndInstall`/
 * `cleanupOldVersions` helpers, translated into example-based Vitest
 * cases now that the orchestration is a standalone, port-driven
 * function.
 */
import type {
  Bundle,
  InstalledBundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  InstallRegistryBundlePorts,
  LocalSkillsCapableAdapter,
} from '../../src/registry';
import {
  installRegistryBundle,
} from '../../src/registry';

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

function makeAdapter(overrides: Partial<LocalSkillsCapableAdapter> = {}): LocalSkillsCapableAdapter {
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

function makePorts(overrides: Partial<InstallRegistryBundlePorts> = {}): InstallRegistryBundlePorts {
  return {
    getBundleDetails: async () => makeBundle(),
    listSources: async () => [makeSource()],
    getCachedSourceBundles: async () => [],
    getBundleVersion: () => undefined,
    getInstalledBundle: async () => undefined,
    getAdapter: () => makeAdapter(),
    installFromBuffer: async () => makeInstalled(),
    installLocalSkillAsSymlink: async () => makeInstalled(),
    recordInstallation: async () => {},
    getInstalledBundles: async () => [],
    removeInstallation: async () => {},
    ...overrides
  };
}

describe('installRegistryBundle', () => {
  it('resolves, downloads, installs, and records a new bundle end to end', async () => {
    const bundle = makeBundle();
    const installed = makeInstalled();
    let recordedInstallation: InstalledBundle | undefined;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      installFromBuffer: async () => installed,
      recordInstallation: async (installation) => {
        recordedInstallation = installation;
      }
    });

    const result = await installRegistryBundle('bundle-1', { scope: 'user' }, ports);

    expect(result).toEqual(installed);
    expect(recordedInstallation).toEqual(installed);
  });

  it('throws when the bundle is already installed at the same version without force', async () => {
    const bundle = makeBundle({ version: '1.0.0' });
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      getInstalledBundle: async () => makeInstalled({ version: '1.0.0' })
    });

    await expect(installRegistryBundle('bundle-1', { scope: 'user' }, ports))
      .rejects.toThrow("Bundle 'bundle-1' is already installed. Use force=true to reinstall.");
  });

  it('proceeds (as a version change) when an existing installation has a different version, without requiring force', async () => {
    const bundle = makeBundle({ version: '2.0.0' });
    let installFromBufferCalled = false;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      getInstalledBundle: async () => makeInstalled({ version: '1.0.0' }),
      installFromBuffer: async () => {
        installFromBufferCalled = true;
        return makeInstalled({ version: '2.0.0' });
      }
    });

    await installRegistryBundle('bundle-1', { scope: 'user' }, ports);

    expect(installFromBufferCalled).toBe(true);
  });

  it('proceeds when force is explicitly set, regardless of existing installation state', async () => {
    const bundle = makeBundle({ version: '1.0.0' });
    let installFromBufferCalled = false;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      getInstalledBundle: async () => makeInstalled({ version: '1.0.0' }),
      installFromBuffer: async () => {
        installFromBufferCalled = true;
        return makeInstalled();
      }
    });

    await installRegistryBundle('bundle-1', { scope: 'user', force: true }, ports);

    expect(installFromBufferCalled).toBe(true);
  });

  it('throws when the resolved bundle has no matching source', async () => {
    const bundle = makeBundle({ sourceId: 'missing-source' });
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      listSources: async () => [makeSource({ id: 'other-source' })]
    });

    await expect(installRegistryBundle('bundle-1', { scope: 'user' }, ports))
      .rejects.toThrow("Source 'missing-source' not found");
  });

  it('downloads via the adapter and installs from the buffer for a standard (non-local-skills) source', async () => {
    const bundle = makeBundle();
    let downloadedBundle: Bundle | undefined;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      getAdapter: () => makeAdapter({
        downloadBundle: async (b) => {
          downloadedBundle = b;
          return Buffer.from('zip-bytes');
        }
      })
    });

    await installRegistryBundle('bundle-1', { scope: 'user' }, ports);

    expect(downloadedBundle).toEqual(bundle);
  });

  it('sets sourceId, sourceType, and profileId on the standard install path', async () => {
    const bundle = makeBundle({ sourceId: 'source-1' });
    let installed: InstalledBundle = makeInstalled();
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      listSources: async () => [makeSource({ id: 'source-1', type: 'apm' })],
      getAdapter: () => makeAdapter({ type: 'apm' }),
      installFromBuffer: async () => {
        installed = makeInstalled();
        return installed;
      }
    });

    const result = await installRegistryBundle('bundle-1', { scope: 'user', profileId: 'profile-1' }, ports);

    expect(result.sourceId).toBe('source-1');
    expect(result.sourceType).toBe('apm');
    expect(result.profileId).toBe('profile-1');
  });

  it('does not set profileId when none was requested', async () => {
    const ports = makePorts();

    const result = await installRegistryBundle('bundle-1', { scope: 'user' }, ports);

    expect(result.profileId).toBeUndefined();
  });

  it('uses symlink installation for a local-skills source when the adapter supports it', async () => {
    const bundle = makeBundle({ sourceId: 'skills-source' });
    let downloadBundleCalled = false;
    let symlinkArgs: [Bundle, string, string] | undefined;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      listSources: async () => [makeSource({ id: 'skills-source', type: 'local-skills' })],
      getAdapter: () => makeAdapter({
        type: 'local-skills',
        getSkillSourcePath: () => '/skills/my-skill',
        getSkillName: () => 'my-skill',
        downloadBundle: async () => {
          downloadBundleCalled = true;
          return Buffer.from('should-not-be-called');
        }
      }),
      installLocalSkillAsSymlink: async (b, skillName, sourcePath) => {
        symlinkArgs = [b, skillName, sourcePath];
        return makeInstalled();
      }
    });

    const result = await installRegistryBundle('bundle-1', { scope: 'user', profileId: 'profile-1' }, ports);

    expect(symlinkArgs).toEqual([bundle, 'my-skill', '/skills/my-skill']);
    expect(downloadBundleCalled).toBe(false);
    expect(result.sourceId).toBe('skills-source');
    expect(result.sourceType).toBe('local-skills');
    expect(result.profileId).toBe('profile-1');
  });

  it('falls back to standard installation for a local-skills source when the adapter lacks symlink methods', async () => {
    const bundle = makeBundle({ sourceId: 'skills-source' });
    let downloadBundleCalled = false;
    let symlinkCalled = false;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      listSources: async () => [makeSource({ id: 'skills-source', type: 'local-skills' })],
      getAdapter: () => makeAdapter({
        type: 'local-skills',
        downloadBundle: async () => {
          downloadBundleCalled = true;
          return Buffer.from('zip-bytes');
        }
      }),
      installLocalSkillAsSymlink: async () => {
        symlinkCalled = true;
        return makeInstalled();
      }
    });

    await installRegistryBundle('bundle-1', { scope: 'user' }, ports);

    expect(downloadBundleCalled).toBe(true);
    expect(symlinkCalled).toBe(false);
  });

  it('records the installation for user/workspace scope', async () => {
    let recordCalled = false;
    const ports = makePorts({
      recordInstallation: async () => {
        recordCalled = true;
      }
    });

    await installRegistryBundle('bundle-1', { scope: 'workspace' }, ports);

    expect(recordCalled).toBe(true);
  });

  it('does not record the installation for repository scope (lockfile-tracked instead)', async () => {
    let recordCalled = false;
    const ports = makePorts({
      recordInstallation: async () => {
        recordCalled = true;
      }
    });

    await installRegistryBundle('bundle-1', { scope: 'repository' }, ports);

    expect(recordCalled).toBe(false);
  });

  it('skips cleanup entirely for repository scope', async () => {
    let getInstalledBundlesCalled = false;
    const ports = makePorts({
      getInstalledBundles: async () => {
        getInstalledBundlesCalled = true;
        return [];
      }
    });

    await installRegistryBundle('bundle-1', { scope: 'repository' }, ports);

    expect(getInstalledBundlesCalled).toBe(false);
  });

  it('removes old versions of the same bundle identity after a successful install', async () => {
    const bundle = makeBundle({ id: 'owner-repo-v2.0.0', version: '2.0.0', sourceId: 'gh-source' });
    const oldInstall = makeInstalled({ bundleId: 'owner-repo-v1.0.0', version: '1.0.0', sourceId: 'gh-source', sourceType: 'github' });
    const removed: string[] = [];
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getInstalledBundles: async () => [oldInstall],
      removeInstallation: async (bundleId) => {
        removed.push(bundleId);
      }
    });

    await installRegistryBundle('owner-repo-v2.0.0', { scope: 'user' }, ports);

    expect(removed).toEqual(['owner-repo-v1.0.0']);
  });

  it('does not remove installed bundles from a different source', async () => {
    const bundle = makeBundle({ id: 'owner-repo-v2.0.0', version: '2.0.0', sourceId: 'gh-source' });
    const unrelated = makeInstalled({ bundleId: 'other-bundle', version: '1.0.0', sourceId: 'different-source' });
    let removeCalled = false;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getInstalledBundles: async () => [unrelated],
      removeInstallation: async () => {
        removeCalled = true;
      }
    });

    await installRegistryBundle('owner-repo-v2.0.0', { scope: 'user' }, ports);

    expect(removeCalled).toBe(false);
  });

  it('does not remove an installed bundle with the same identity and the same version', async () => {
    const bundle = makeBundle({ id: 'owner-repo-v1.0.0', version: '1.0.0', sourceId: 'gh-source' });
    const sameVersion = makeInstalled({ bundleId: 'owner-repo-v1.0.0', version: '1.0.0', sourceId: 'gh-source', sourceType: 'github' });
    let removeCalled = false;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getInstalledBundles: async () => [sameVersion],
      removeInstallation: async () => {
        removeCalled = true;
      }
    });

    await installRegistryBundle('owner-repo-v1.0.0', { scope: 'user' }, ports);

    expect(removeCalled).toBe(false);
  });

  it('swallows cleanup failures without failing the overall install', async () => {
    const installed = makeInstalled();
    const ports = makePorts({
      installFromBuffer: async () => installed,
      getInstalledBundles: async () => Promise.reject(new Error('storage unavailable'))
    });

    await expect(installRegistryBundle('bundle-1', { scope: 'user' }, ports)).resolves.toEqual(installed);
  });

  it('emits log events without throwing when onLog is omitted', async () => {
    const ports = makePorts();

    await expect(installRegistryBundle('bundle-1', { scope: 'user' }, ports)).resolves.toBeDefined();
  });

  it('emits an info log when starting and when finishing successfully', async () => {
    const ports = makePorts();
    const events: string[] = [];

    await installRegistryBundle('bundle-1', { scope: 'user' }, ports, (event) => events.push(`${event.level}:${event.message}`));

    expect(events).toContain('info:Installing bundle: bundle-1');
    expect(events).toContain("info:Bundle 'bundle-1' installed successfully");
  });
});
