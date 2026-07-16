/**
 * Tests for app/registry/list-installed-bundles.ts.
 *
 * Ported behavior coverage from the extension's
 * `test/services/registry-manager.listInstalledBundles.property.test.ts`
 * (Property 1: Repository Scope Queries Lockfile, Property 2: Combined
 * Scope Queries Both Sources), translated into example-based Vitest
 * cases now that the scope-branching logic is a standalone,
 * port-driven function.
 */
import type {
  InstalledBundle,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  ListInstalledBundlesPorts,
} from '../../src/registry';
import {
  listInstalledBundles,
} from '../../src/registry';

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

function makePorts(overrides: Partial<ListInstalledBundlesPorts> = {}): ListInstalledBundlesPorts {
  return {
    getInstalledBundles: async () => [],
    getRepositoryInstalledBundles: async () => [],
    ...overrides
  };
}

describe('listInstalledBundles', () => {
  it('repository scope returns only repository bundles, without querying storage', async () => {
    let storageCalled = false;
    const repoBundles = [makeInstalled({ bundleId: 'repo-1', scope: 'repository' })];
    const ports = makePorts({
      getInstalledBundles: async () => {
        storageCalled = true;
        return [makeInstalled({ bundleId: 'user-1', scope: 'user' })];
      },
      getRepositoryInstalledBundles: async () => repoBundles
    });

    const result = await listInstalledBundles('repository', ports);

    expect(result).toEqual(repoBundles);
    expect(storageCalled).toBe(false);
  });

  it('repository scope returns an empty array when there are no repository bundles', async () => {
    const ports = makePorts();

    await expect(listInstalledBundles('repository', ports)).resolves.toEqual([]);
  });

  it('user scope returns only storage bundles for that scope, without querying the repository', async () => {
    let repoCalled = false;
    const userBundles = [makeInstalled({ bundleId: 'user-1', scope: 'user' })];
    const ports = makePorts({
      getInstalledBundles: async (scope) => (scope === 'user' ? userBundles : []),
      getRepositoryInstalledBundles: async () => {
        repoCalled = true;
        return [];
      }
    });

    const result = await listInstalledBundles('user', ports);

    expect(result).toEqual(userBundles);
    expect(repoCalled).toBe(false);
  });

  it('workspace scope returns only storage bundles for that scope, without querying the repository', async () => {
    let repoCalled = false;
    const workspaceBundles = [makeInstalled({ bundleId: 'ws-1', scope: 'workspace' })];
    const ports = makePorts({
      getInstalledBundles: async (scope) => (scope === 'workspace' ? workspaceBundles : []),
      getRepositoryInstalledBundles: async () => {
        repoCalled = true;
        return [];
      }
    });

    const result = await listInstalledBundles('workspace', ports);

    expect(result).toEqual(workspaceBundles);
    expect(repoCalled).toBe(false);
  });

  it('no scope filter combines storage and repository bundles', async () => {
    const userBundles = [makeInstalled({ bundleId: 'user-1', scope: 'user' }), makeInstalled({ bundleId: 'ws-1', scope: 'workspace' })];
    const repoBundles = [makeInstalled({ bundleId: 'repo-1', scope: 'repository' })];
    const ports = makePorts({
      getInstalledBundles: async () => userBundles,
      getRepositoryInstalledBundles: async () => repoBundles
    });

    const result = await listInstalledBundles(undefined, ports);

    expect(result).toEqual([...userBundles, ...repoBundles]);
  });

  it('no scope filter passes the undefined scope through to the storage port', async () => {
    let receivedScope: string | undefined = 'unset';
    const ports = makePorts({
      getInstalledBundles: async (scope) => {
        receivedScope = scope;
        return [];
      }
    });

    await listInstalledBundles(undefined, ports);

    expect(receivedScope).toBeUndefined();
  });

  it('combined query handles an empty repository gracefully', async () => {
    const userBundles = [makeInstalled({ bundleId: 'user-1', scope: 'user' })];
    const ports = makePorts({
      getInstalledBundles: async () => userBundles
    });

    await expect(listInstalledBundles(undefined, ports)).resolves.toEqual(userBundles);
  });
});
