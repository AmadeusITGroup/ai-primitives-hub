/**
 * Tests for app/registry/resolve-installation-bundle.ts.
 *
 * Ported behavior coverage from the extension's private
 * `RegistryManager.resolveInstallationBundle` chain
 * (`tryGetExactVersionedBundle`/`resolveByIdentity`/`determineSearchId`/
 * `applyVersionOverride`), translated into example-based Vitest cases
 * now that the chain is a standalone, port-driven function.
 */
import type {
  Bundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  BundleVersion,
  ResolveInstallationBundlePorts,
} from '../../src/registry';
import {
  resolveInstallationBundle,
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

function makeBundleVersion(overrides: Partial<BundleVersion> = {}): BundleVersion {
  return {
    version: '2.0.0',
    bundleId: 'owner-repo-v2.0.0',
    publishedAt: '2024-02-01T00:00:00.000Z',
    downloadUrl: 'https://example.com/v2/download',
    manifestUrl: 'https://example.com/v2/manifest',
    ...overrides
  };
}

function makePorts(overrides: Partial<ResolveInstallationBundlePorts> = {}): ResolveInstallationBundlePorts {
  return {
    getBundleDetails: async () => makeBundle(),
    listSources: async () => [],
    getCachedSourceBundles: async () => [],
    getBundleVersion: () => undefined,
    ...overrides
  };
}

describe('resolveInstallationBundle', () => {
  it('resolves a plain bundle ID with no version directly via getBundleDetails', async () => {
    const bundle = makeBundle({ id: 'bundle-1' });
    const ports = makePorts({
      getBundleDetails: async (id) => (id === 'bundle-1' ? bundle : Promise.reject(new Error('not found')))
    });

    const result = await resolveInstallationBundle('bundle-1', { scope: 'user' }, ports);

    expect(result).toEqual(bundle);
  });

  it('returns an already-versioned bundle ID directly when its version matches the request, without a second lookup', async () => {
    const bundle = makeBundle({ id: 'owner-repo-v1.0.0', version: '1.0.0' });
    let callCount = 0;
    const ports = makePorts({
      getBundleDetails: async () => {
        callCount += 1;
        return bundle;
      }
    });

    const result = await resolveInstallationBundle('owner-repo-v1.0.0', { scope: 'user', version: '1.0.0' }, ports);

    expect(result).toEqual(bundle);
    expect(callCount).toBe(1);
  });

  it('falls back to identity-based search when the versioned ID lookup returns a version mismatch', async () => {
    const mismatchedBundle = makeBundle({ id: 'owner-repo-v1.0.0', version: '0.9.0', sourceId: 'gh-source' });
    const identityBundle = makeBundle({ id: 'owner-repo', version: '1.0.0', sourceId: 'gh-source' });
    const ports = makePorts({
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getCachedSourceBundles: async () => [makeBundle({ id: 'owner-repo-v1.0.0', sourceId: 'gh-source' })],
      getBundleDetails: async (id) => (id === 'owner-repo-v1.0.0' ? mismatchedBundle : identityBundle)
    });

    const result = await resolveInstallationBundle('owner-repo-v1.0.0', { scope: 'user', version: '1.0.0' }, ports);

    expect(result).toEqual(identityBundle);
  });

  it('falls back to identity-based search when the exact versioned ID is not found at all', async () => {
    const identityBundle = makeBundle({ id: 'owner-repo', version: '1.0.0', sourceId: 'gh-source' });
    const ports = makePorts({
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getCachedSourceBundles: async () => [makeBundle({ id: 'owner-repo-v1.0.0', sourceId: 'gh-source' })],
      getBundleDetails: async (id) => (id === 'owner-repo-v1.0.0' ? Promise.reject(new Error('404')) : identityBundle)
    });

    const result = await resolveInstallationBundle('owner-repo-v1.0.0', { scope: 'user', version: '1.0.0' }, ports);

    expect(result).toEqual(identityBundle);
  });

  it('resolves the search ID to a source-derived identity when a cached source bundle matches and a version is requested', async () => {
    const identityBundle = makeBundle({ id: 'owner-repo', sourceId: 'gh-source' });
    let receivedSearchId: string | undefined;
    const ports = makePorts({
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getCachedSourceBundles: async () => [makeBundle({ id: 'owner-repo-v1.0.0' })],
      getBundleDetails: async (id) => {
        receivedSearchId = id;
        if (id === 'owner-repo-v1.0.0') {
          return Promise.reject(new Error('not found'));
        }
        return identityBundle;
      }
    });

    await resolveInstallationBundle('owner-repo-v1.0.0', { scope: 'user', version: '1.0.0' }, ports);

    expect(receivedSearchId).toBe('owner-repo');
  });

  it('uses the raw bundle ID as the search ID when no source has a matching cached bundle', async () => {
    let receivedSearchId: string | undefined;
    const ports = makePorts({
      listSources: async () => [makeSource()],
      getCachedSourceBundles: async () => [],
      getBundleDetails: async (id) => {
        receivedSearchId = id;
        return makeBundle();
      }
    });

    await resolveInstallationBundle('unresolvable-id', { scope: 'user', version: '1.0.0' }, ports);

    expect(receivedSearchId).toBe('unresolvable-id');
  });

  it('uses the raw bundle ID as the search ID when no version is requested at all', async () => {
    let receivedSearchId: string | undefined;
    const ports = makePorts({
      getBundleDetails: async (id) => {
        receivedSearchId = id;
        return makeBundle();
      }
    });

    await resolveInstallationBundle('plain-id', { scope: 'user' }, ports);

    expect(receivedSearchId).toBe('plain-id');
  });

  it('applies a specific version override when the version consolidator has that version', async () => {
    const baseBundle = makeBundle({ id: 'owner-repo', version: '1.0.0', sourceId: 'gh-source' });
    const specificVersion = makeBundleVersion({ version: '2.0.0', bundleId: 'owner-repo-v2.0.0' });
    const ports = makePorts({
      getBundleDetails: async () => baseBundle,
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getBundleVersion: () => specificVersion
    });

    const result = await resolveInstallationBundle('owner-repo', { scope: 'user', version: '2.0.0' }, ports);

    expect(result.id).toBe('owner-repo-v2.0.0');
    expect(result.version).toBe('2.0.0');
    expect(result.downloadUrl).toBe(specificVersion.downloadUrl);
    expect(result.manifestUrl).toBe(specificVersion.manifestUrl);
    expect(result.lastUpdated).toBe(specificVersion.publishedAt);
  });

  it('falls back to the latest bundle when the requested version is not found in the consolidator', async () => {
    const baseBundle = makeBundle({ id: 'owner-repo', version: '1.0.0', sourceId: 'gh-source' });
    const ports = makePorts({
      getBundleDetails: async () => baseBundle,
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getBundleVersion: () => undefined
    });

    const result = await resolveInstallationBundle('owner-repo', { scope: 'user', version: '9.9.9' }, ports);

    expect(result).toEqual(baseBundle);
  });

  it('falls back to the latest bundle when the resolved bundle has no matching source', async () => {
    const baseBundle = makeBundle({ id: 'owner-repo', sourceId: 'missing-source' });
    let versionLookupCalled = false;
    const ports = makePorts({
      getBundleDetails: async () => baseBundle,
      listSources: async () => [],
      getBundleVersion: () => {
        versionLookupCalled = true;
        return undefined;
      }
    });

    const result = await resolveInstallationBundle('owner-repo', { scope: 'user', version: '1.0.0' }, ports);

    expect(result).toEqual(baseBundle);
    expect(versionLookupCalled).toBe(false);
  });

  it('emits diagnostic log events without throwing when onLog is omitted', async () => {
    const ports = makePorts({
      getBundleDetails: async () => Promise.reject(new Error('not found'))
    });

    await expect(resolveInstallationBundle('owner-repo-v1.0.0', { scope: 'user', version: '1.0.0' }, ports))
      .rejects.toThrow();
  });
});
