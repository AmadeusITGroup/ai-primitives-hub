/**
 * Tests for app/registry/detect-updates.ts.
 *
 * Ported behavior coverage from the extension's implicit coverage of
 * `RegistryManager.checkUpdates` (exercised indirectly via
 * `test/services/update-checker.property.test.ts` and
 * `test/services/auto-update-service.test.ts`, which stub
 * `RegistryManager.checkUpdates` rather than testing its internals
 * directly) — translated into direct, example-based Vitest cases now
 * that the raw diff logic is a standalone, port-driven function.
 */
import type {
  Bundle,
  InstalledBundle,
  RegistrySource,
  UpdateDetectionReader,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  detectBundleUpdates,
} from '../../src/registry';
import type {
  LogEvent,
} from '../../src/update';

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-1',
    name: 'Bundle 1',
    version: '2.0.0',
    description: 'Test bundle',
    author: 'test',
    sourceId: 'source-1',
    environments: [],
    tags: [],
    lastUpdated: '2024-01-01T00:00:00.000Z',
    size: '1KB',
    dependencies: [],
    license: 'MIT',
    manifestUrl: 'https://example.com/manifest.yml',
    downloadUrl: 'https://example.com/bundle.zip',
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

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'source-1',
    name: 'Source 1',
    type: 'local',
    url: 'https://example.com',
    enabled: true,
    priority: 1,
    ...overrides
  };
}

function makePorts(overrides: Partial<UpdateDetectionReader> = {}): UpdateDetectionReader {
  return {
    getInstalledBundles: async () => [],
    getBundleDetails: async () => makeBundle(),
    listSources: async () => [],
    getInstalledBundle: async () => undefined,
    ...overrides
  };
}

describe('detectBundleUpdates', () => {
  it('returns no updates when the installed version matches the latest version', async () => {
    const ports = makePorts({
      getInstalledBundles: async () => [makeInstalled({ version: '2.0.0' })],
      getBundleDetails: async () => makeBundle({ version: '2.0.0' })
    });

    await expect(detectBundleUpdates(ports)).resolves.toEqual([]);
  });

  it('returns an update when the installed version differs from the latest version', async () => {
    const ports = makePorts({
      getInstalledBundles: async () => [makeInstalled({ bundleId: 'bundle-1', version: '1.0.0' })],
      getBundleDetails: async () => makeBundle({ version: '2.0.0' })
    });

    await expect(detectBundleUpdates(ports)).resolves.toEqual([
      { bundleId: 'bundle-1', currentVersion: '1.0.0', latestVersion: '2.0.0' }
    ]);
  });

  it('falls back to the GitHub identity when the versioned bundle ID is not directly resolvable', async () => {
    const installed = makeInstalled({ bundleId: 'owner-repo-v1.0.0', version: '1.0.0', sourceId: 'gh-source' });
    const ports = makePorts({
      getInstalledBundles: async () => [installed],
      getBundleDetails: async (id) => {
        if (id === 'owner-repo-v1.0.0') {
          throw new Error('not found');
        }
        expect(id).toBe('owner-repo');
        return makeBundle({ id, version: '2.0.0' });
      },
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getInstalledBundle: async (bundleId, scope) => (scope === 'user' ? installed : undefined)
    });

    await expect(detectBundleUpdates(ports)).resolves.toEqual([
      { bundleId: 'owner-repo-v1.0.0', currentVersion: '1.0.0', latestVersion: '2.0.0' }
    ]);
  });

  it('tries the workspace scope when the bundle is not found in the user scope', async () => {
    const installed = makeInstalled({ bundleId: 'owner-repo-v1.0.0', version: '1.0.0', sourceId: 'gh-source', scope: 'workspace' });
    const seenScopes: string[] = [];
    const ports = makePorts({
      getInstalledBundles: async () => [installed],
      getBundleDetails: async (id) => {
        if (id === 'owner-repo-v1.0.0') {
          throw new Error('not found');
        }
        return makeBundle({ id, version: '2.0.0' });
      },
      listSources: async () => [makeSource({ id: 'gh-source', type: 'github' })],
      getInstalledBundle: async (bundleId, scope) => {
        seenScopes.push(scope);
        return scope === 'workspace' ? installed : undefined;
      }
    });

    await detectBundleUpdates(ports);

    expect(seenScopes).toEqual(['user', 'workspace']);
  });

  it('skips a bundle and logs an error when its source is not GitHub (no identity fallback)', async () => {
    const installed = makeInstalled({ bundleId: 'local-bundle', version: '1.0.0', sourceId: 'local-source' });
    const events: LogEvent[] = [];
    const ports = makePorts({
      getInstalledBundles: async () => [installed],
      getBundleDetails: async () => {
        throw new Error('not found');
      },
      listSources: async () => [makeSource({ id: 'local-source', type: 'local' })],
      getInstalledBundle: async () => installed
    });

    const updates = await detectBundleUpdates(ports, (e) => events.push(e));

    expect(updates).toEqual([]);
    expect(events.some((e) => e.level === 'error' && e.message.includes('local-bundle'))).toBe(true);
  });

  it('continues checking remaining bundles when one bundle fails unexpectedly', async () => {
    const good = makeInstalled({ bundleId: 'good-bundle', version: '1.0.0' });
    const bad = makeInstalled({ bundleId: 'bad-bundle', version: '1.0.0' });
    const ports = makePorts({
      getInstalledBundles: async () => [bad, good],
      getBundleDetails: async (id) => {
        if (id === 'bad-bundle') {
          throw new Error('boom');
        }
        return makeBundle({ id, version: '2.0.0' });
      },
      listSources: async () => [],
      getInstalledBundle: async () => undefined
    });

    const updates = await detectBundleUpdates(ports);

    expect(updates).toEqual([{ bundleId: 'good-bundle', currentVersion: '1.0.0', latestVersion: '2.0.0' }]);
  });

  it('emits info log events at the start and end of the check', async () => {
    const events: LogEvent[] = [];
    const ports = makePorts();

    await detectBundleUpdates(ports, (e) => events.push(e));

    expect(events.some((e) => e.level === 'info' && e.message.includes('Checking for bundle updates'))).toBe(true);
    expect(events.some((e) => e.level === 'info' && e.message.includes('Found 0 bundle updates'))).toBe(true);
  });

  it('works without an onLog callback', async () => {
    const ports = makePorts({
      getInstalledBundles: async () => [makeInstalled({ version: '1.0.0' })],
      getBundleDetails: async () => makeBundle({ version: '2.0.0' })
    });

    await expect(detectBundleUpdates(ports)).resolves.toEqual([
      { bundleId: 'bundle-1', currentVersion: '1.0.0', latestVersion: '2.0.0' }
    ]);
  });
});
