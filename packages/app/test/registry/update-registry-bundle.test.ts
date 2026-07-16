/**
 * Tests for app/registry/update-registry-bundle.ts.
 *
 * Ported behavior coverage from the extension's
 * `RegistryManager.updateBundle`, translated into example-based Vitest
 * cases now that the orchestration is a standalone, port-driven
 * function. The interactive local-modifications check
 * (`checkLocalModificationsBeforeUpdate` in the extension) is exercised
 * only at the port-invocation level here — its own dialog/lockfile
 * behavior is extension-only and out of scope for this module.
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
  UpdateRegistryBundlePorts,
} from '../../src/registry';
import {
  updateRegistryBundle,
} from '../../src/registry';

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'owner-repo',
    name: 'Bundle 1',
    version: '2.0.0',
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
    bundleId: 'owner-repo-v1.0.0',
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00.000Z',
    scope: 'user',
    sourceId: 'source-1',
    sourceType: 'github',
    installPath: '/mock/path',
    manifest: {
      common: { directories: [], files: [], include_patterns: [], exclude_patterns: [] },
      bundle_settings: { include_common_in_environment_bundles: false, create_common_bundle: false, compression: 'none', naming: { environment_bundle: 'bundle-1' } },
      metadata: { manifest_version: '1.0.0', description: 'Test' }
    },
    ...overrides
  };
}

function makePorts(overrides: Partial<UpdateRegistryBundlePorts> = {}): UpdateRegistryBundlePorts {
  return {
    listInstalledBundles: async () => [makeInstalled()],
    getBundleDetails: async () => makeBundle(),
    listSources: async () => [makeSource()],
    getAdapter: () => ({
      type: 'github',
      source: makeSource(),
      fetchBundles: async () => [],
      downloadBundle: async () => Buffer.from('zip-bytes'),
      fetchMetadata: async () => ({ name: 'Source 1', description: 'Test source', bundleCount: 1, lastUpdated: '2024-01-01T00:00:00.000Z', version: '1.0.0' }),
      validate: async () => ({ valid: true, errors: [], warnings: [] }),
      requiresAuthentication: () => false,
      getManifestUrl: () => 'https://example.com/manifest',
      getDownloadUrl: () => 'https://example.com/download'
    }),
    updateInstalledBundle: async () => makeInstalled({ bundleId: 'owner-repo-v2.0.0', version: '2.0.0' }),
    recordInstallation: async () => {},
    removeInstallation: async () => {},
    ...overrides
  };
}

describe('updateRegistryBundle', () => {
  it('updates the current installation end to end and returns the new record', async () => {
    const updated = makeInstalled({ bundleId: 'owner-repo-v2.0.0', version: '2.0.0' });
    const ports = makePorts({
      updateInstalledBundle: async () => updated
    });

    const result = await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(result).toEqual(updated);
  });

  it('throws when the bundle is not installed', async () => {
    const ports = makePorts({ listInstalledBundles: async () => [] });

    await expect(updateRegistryBundle('missing-bundle', undefined, ports))
      .rejects.toThrow("Bundle 'missing-bundle' is not installed");
  });

  it('invokes checkLocalModifications with the bundle id and current installation before resolving the new bundle', async () => {
    const current = makeInstalled({ bundleId: 'owner-repo-v1.0.0' });
    let receivedArgs: [string, InstalledBundle] | undefined;
    const ports = makePorts({
      listInstalledBundles: async () => [current],
      checkLocalModifications: async (id, cur) => {
        receivedArgs = [id, cur];
      }
    });

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(receivedArgs).toEqual(['owner-repo-v1.0.0', current]);
  });

  it('does not require checkLocalModifications to be provided', async () => {
    const ports = makePorts();
    delete (ports as { checkLocalModifications?: unknown }).checkLocalModifications;

    await expect(updateRegistryBundle('owner-repo-v1.0.0', undefined, ports)).resolves.toBeDefined();
  });

  it('propagates errors thrown by checkLocalModifications (e.g. user cancellation) without resolving a new bundle', async () => {
    let getBundleDetailsCalled = false;
    const ports = makePorts({
      checkLocalModifications: async () => {
        throw new Error('Update cancelled by user');
      },
      getBundleDetails: async () => {
        getBundleDetailsCalled = true;
        return makeBundle();
      }
    });

    await expect(updateRegistryBundle('owner-repo-v1.0.0', undefined, ports))
      .rejects.toThrow('Update cancelled by user');
    expect(getBundleDetailsCalled).toBe(false);
  });

  it('resolves the exact versioned bundle when a version is requested and found directly', async () => {
    // versionedId is `${identity}-${version}` - no "v" prefix is inserted
    // programmatically, so with identity 'owner-repo' and version '3.0.0'
    // the queried id is 'owner-repo-3.0.0', not 'owner-repo-v3.0.0'.
    const requestedIds: string[] = [];
    const ports = makePorts({
      getBundleDetails: async (id) => {
        requestedIds.push(id);
        if (id === 'owner-repo-3.0.0') {
          return makeBundle({ id, version: '3.0.0' });
        }
        throw new Error('not found');
      }
    });

    await updateRegistryBundle('owner-repo-v1.0.0', '3.0.0', ports);

    expect(requestedIds).toEqual(['owner-repo-3.0.0']);
  });

  it('falls back to identity lookup when the exact versioned bundle id is not found, and verifies the version matches', async () => {
    // See the prior test's note on the exact (no "v" prefix) versionedId shape.
    const requestedVersionedId = 'owner-repo-3.0.0';
    let identityLookupId: string | undefined;
    const ports = makePorts({
      getBundleDetails: async (id) => {
        if (id === requestedVersionedId) {
          throw new Error('not found');
        }
        identityLookupId = id;
        return makeBundle({ id: 'owner-repo', version: '3.0.0' });
      }
    });

    const result = await updateRegistryBundle('owner-repo-v1.0.0', '3.0.0', ports);

    expect(identityLookupId).toBe('owner-repo');
    expect(result.version).toBe('2.0.0'); // from the default updateInstalledBundle mock
  });

  it('throws when the identity fallback bundle version does not match the requested version', async () => {
    const ports = makePorts({
      getBundleDetails: async (id) => {
        if (id === 'owner-repo-3.0.0') {
          throw new Error('not found');
        }
        return makeBundle({ id: 'owner-repo', version: '1.5.0' });
      }
    });

    await expect(updateRegistryBundle('owner-repo-v1.0.0', '3.0.0', ports))
      .rejects.toThrow("Requested version 3.0.0 not found for bundle 'owner-repo'");
  });

  it('resolves the latest bundle by identity when no version is requested', async () => {
    let requestedId: string | undefined;
    const ports = makePorts({
      getBundleDetails: async (id) => {
        requestedId = id;
        return makeBundle({ id: 'owner-repo', version: '2.0.0' });
      }
    });

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(requestedId).toBe('owner-repo');
  });

  it('falls back to the exact bundle id when identity lookup fails and no version is requested', async () => {
    const attempted: string[] = [];
    const ports = makePorts({
      getBundleDetails: async (id) => {
        attempted.push(id);
        if (id === 'owner-repo') {
          throw new Error('identity not found');
        }
        return makeBundle({ id });
      }
    });

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(attempted).toEqual(['owner-repo', 'owner-repo-v1.0.0']);
  });

  it('strips a GitHub version suffix using extractBundleIdentity semantics', async () => {
    let requestedId: string | undefined;
    const ports = makePorts({
      listInstalledBundles: async () => [makeInstalled({ bundleId: 'owner-repo-v1.2.3', sourceType: 'github' })],
      getBundleDetails: async (id) => {
        requestedId = id;
        return makeBundle({ id: 'owner-repo' });
      }
    });

    await updateRegistryBundle('owner-repo-v1.2.3', undefined, ports);

    expect(requestedId).toBe('owner-repo');
  });

  it('strips a version suffix for non-GitHub source types too (deliberate divergence from extractBundleIdentity)', async () => {
    let requestedId: string | undefined;
    const ports = makePorts({
      listInstalledBundles: async () => [makeInstalled({ bundleId: 'my-skill-1.2.3', sourceType: 'local-skills' })],
      getBundleDetails: async (id) => {
        requestedId = id;
        return makeBundle({ id: 'my-skill' });
      }
    });

    await updateRegistryBundle('my-skill-1.2.3', undefined, ports);

    expect(requestedId).toBe('my-skill');
  });

  it('continues with a reinstall instead of throwing/returning early when already at the resolved version', async () => {
    const ports = makePorts({
      listInstalledBundles: async () => [makeInstalled({ bundleId: 'owner-repo-v2.0.0', version: '2.0.0' })],
      getBundleDetails: async () => makeBundle({ id: 'owner-repo', version: '2.0.0' })
    });

    await expect(updateRegistryBundle('owner-repo-v2.0.0', undefined, ports)).resolves.toBeDefined();
  });

  it('throws when the resolved bundle has no matching source', async () => {
    const ports = makePorts({
      getBundleDetails: async () => makeBundle({ sourceId: 'missing-source' }),
      listSources: async () => [makeSource({ id: 'other-source' })]
    });

    await expect(updateRegistryBundle('owner-repo-v1.0.0', undefined, ports))
      .rejects.toThrow("Source 'missing-source' not found");
  });

  it('downloads the resolved bundle via the adapter for the matching source', async () => {
    const bundle = makeBundle({ id: 'owner-repo', sourceId: 'source-1' });
    let downloadedBundle: Bundle | undefined;
    const ports = makePorts({
      getBundleDetails: async () => bundle,
      getAdapter: () => ({
        type: 'github',
        source: makeSource(),
        fetchBundles: async () => [],
        downloadBundle: async (b) => {
          downloadedBundle = b;
          return Buffer.from('zip-bytes');
        },
        fetchMetadata: async () => ({ name: 'Source 1', description: 'Test source', bundleCount: 1, lastUpdated: '2024-01-01T00:00:00.000Z', version: '1.0.0' }),
        validate: async () => ({ valid: true, errors: [], warnings: [] }),
        requiresAuthentication: () => false,
        getManifestUrl: () => 'https://example.com/manifest',
        getDownloadUrl: () => 'https://example.com/download'
      })
    });

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(downloadedBundle).toEqual(bundle);
  });

  it('passes the current installation, resolved bundle, downloaded buffer, and source type to updateInstalledBundle', async () => {
    const current = makeInstalled({ bundleId: 'owner-repo-v1.0.0' });
    const bundle = makeBundle({ id: 'owner-repo', sourceId: 'source-1' });
    let received: [InstalledBundle, Bundle, Buffer, string] | undefined;
    const ports = makePorts({
      listInstalledBundles: async () => [current],
      getBundleDetails: async () => bundle,
      listSources: async () => [makeSource({ id: 'source-1', type: 'apm' })],
      updateInstalledBundle: async (c, b, buf, sourceType) => {
        received = [c, b, buf, sourceType];
        return makeInstalled();
      }
    });

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(received?.[0]).toEqual(current);
    expect(received?.[1]).toEqual(bundle);
    expect(received?.[3]).toBe('apm');
  });

  it('records the new installation for non-repository scope', async () => {
    let recorded: InstalledBundle | undefined;
    const ports = makePorts({
      listInstalledBundles: async () => [makeInstalled({ scope: 'workspace' })],
      recordInstallation: async (installation) => {
        recorded = installation;
      }
    });

    const result = await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(recorded).toEqual(result);
  });

  it('does not record the new installation for repository scope (lockfile-tracked instead)', async () => {
    let recordCalled = false;
    const ports = makePorts({
      listInstalledBundles: async () => [makeInstalled({ scope: 'repository' })],
      recordInstallation: async () => {
        recordCalled = true;
      }
    });

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(recordCalled).toBe(false);
  });

  it('removes the old installation record when the bundle id changed and scope is not repository', async () => {
    let removedArgs: [string, string] | undefined;
    const ports = makePorts({
      listInstalledBundles: async () => [makeInstalled({ bundleId: 'owner-repo-v1.0.0', scope: 'user' })],
      updateInstalledBundle: async () => makeInstalled({ bundleId: 'owner-repo-v2.0.0', version: '2.0.0' }),
      removeInstallation: async (id, scope) => {
        removedArgs = [id, scope];
      }
    });

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(removedArgs).toEqual(['owner-repo-v1.0.0', 'user']);
  });

  it('does not remove the old installation record when the bundle id is unchanged', async () => {
    let removeCalled = false;
    const ports = makePorts({
      listInstalledBundles: async () => [makeInstalled({ bundleId: 'stable-id' })],
      updateInstalledBundle: async () => makeInstalled({ bundleId: 'stable-id', version: '2.0.0' }),
      removeInstallation: async () => {
        removeCalled = true;
      }
    });

    await updateRegistryBundle('stable-id', undefined, ports);

    expect(removeCalled).toBe(false);
  });

  it('does not remove the old installation record for repository scope even when the bundle id changed', async () => {
    let removeCalled = false;
    const ports = makePorts({
      listInstalledBundles: async () => [makeInstalled({ bundleId: 'owner-repo-v1.0.0', scope: 'repository' })],
      updateInstalledBundle: async () => makeInstalled({ bundleId: 'owner-repo-v2.0.0', version: '2.0.0', scope: 'repository' }),
      removeInstallation: async () => {
        removeCalled = true;
      }
    });

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports);

    expect(removeCalled).toBe(false);
  });

  it('emits an info log when starting and when finishing successfully', async () => {
    const ports = makePorts();
    const events: string[] = [];

    await updateRegistryBundle('owner-repo-v1.0.0', undefined, ports, (event) => events.push(`${event.level}:${event.message}`));

    expect(events).toContain('info:Updating bundle: owner-repo-v1.0.0 to version: latest');
    expect(events.some((e) => e.startsWith("info:Bundle 'owner-repo-v1.0.0' updated from"))).toBe(true);
  });

  it('emits log events without throwing when onLog is omitted', async () => {
    const ports = makePorts();

    await expect(updateRegistryBundle('owner-repo-v1.0.0', undefined, ports)).resolves.toBeDefined();
  });
});
