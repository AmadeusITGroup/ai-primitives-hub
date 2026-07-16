/**
 * Tests for app/registry/uninstall-installed-bundle.ts.
 *
 * Ported behavior coverage from the extension's
 * `test/services/registry-manager.test.ts` /
 * `registry-manager.installationRecords.test.ts` `uninstallBundle()`
 * cases, translated into example-based Vitest cases now that the
 * orchestration is a standalone, port-driven function.
 */
import type {
  InstalledBundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import type {
  UninstallInstalledBundlePorts,
} from '../../src/registry';
import {
  uninstallInstalledBundle,
} from '../../src/registry';

function makeInstalled(overrides: Partial<InstalledBundle> = {}): InstalledBundle {
  return {
    bundleId: 'bundle-1',
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00.000Z',
    scope: 'user',
    installPath: '/mock/path',
    sourceId: 'source-1',
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
    type: 'github',
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

function makePorts(overrides: Partial<UninstallInstalledBundlePorts> = {}): UninstallInstalledBundlePorts {
  return {
    getInstalledBundle: async () => undefined,
    getRepositoryInstalledBundles: async () => [],
    listSources: async () => [],
    uninstall: async () => {},
    uninstallSkillSymlink: async () => {},
    removeInstallation: async () => {},
    ...overrides
  };
}

describe('uninstallInstalledBundle', () => {
  it('user/workspace scope locates the installed bundle via the storage port', async () => {
    const installed = makeInstalled({ scope: 'user' });
    let receivedArgs: [string, string] | undefined;
    const ports = makePorts({
      getInstalledBundle: async (bundleId, scope) => {
        receivedArgs = [bundleId, scope];
        return installed;
      },
      listSources: async () => [makeSource()]
    });

    const result = await uninstallInstalledBundle('bundle-1', 'user', ports);

    expect(result).toEqual(installed);
    expect(receivedArgs).toEqual(['bundle-1', 'user']);
  });

  it('repository scope locates the installed bundle via the repository port, without querying storage', async () => {
    const installed = makeInstalled({ bundleId: 'repo-bundle', scope: 'repository' });
    let storageCalled = false;
    const ports = makePorts({
      getInstalledBundle: async () => {
        storageCalled = true;
        return undefined;
      },
      getRepositoryInstalledBundles: async () => [installed],
      listSources: async () => [makeSource()]
    });

    const result = await uninstallInstalledBundle('repo-bundle', 'repository', ports);

    expect(result).toEqual(installed);
    expect(storageCalled).toBe(false);
  });

  it('throws a scope-specific error when the bundle is not installed in that scope', async () => {
    const ports = makePorts();

    await expect(uninstallInstalledBundle('missing-bundle', 'user', ports))
      .rejects.toThrow("Bundle 'missing-bundle' is not installed in user scope");
  });

  it('throws when the bundle is not found among repository-scoped installs', async () => {
    const ports = makePorts({
      getRepositoryInstalledBundles: async () => [makeInstalled({ bundleId: 'other-bundle', scope: 'repository' })]
    });

    await expect(uninstallInstalledBundle('missing-bundle', 'repository', ports))
      .rejects.toThrow("Bundle 'missing-bundle' is not installed in repository scope");
  });

  it('uses the generic uninstall port for a non-local-skills bundle', async () => {
    const installed = makeInstalled({ sourceType: 'github' });
    let uninstallCalled = false;
    let symlinkCalled = false;
    const ports = makePorts({
      getInstalledBundle: async () => installed,
      listSources: async () => [makeSource({ type: 'github' })],
      uninstall: async () => {
        uninstallCalled = true;
      },
      uninstallSkillSymlink: async () => {
        symlinkCalled = true;
      }
    });

    await uninstallInstalledBundle('bundle-1', 'user', ports);

    expect(uninstallCalled).toBe(true);
    expect(symlinkCalled).toBe(false);
  });

  it('uses the symlink uninstall port when the installation record itself is sourceType local-skills', async () => {
    const installed = makeInstalled({ sourceType: 'local-skills' });
    let uninstallCalled = false;
    let symlinkCalled = false;
    const ports = makePorts({
      getInstalledBundle: async () => installed,
      listSources: async () => [makeSource({ type: 'github' })],
      uninstall: async () => {
        uninstallCalled = true;
      },
      uninstallSkillSymlink: async () => {
        symlinkCalled = true;
      }
    });

    await uninstallInstalledBundle('bundle-1', 'user', ports);

    expect(symlinkCalled).toBe(true);
    expect(uninstallCalled).toBe(false);
  });

  it('uses the symlink uninstall port when the resolved source (not the record) is type local-skills', async () => {
    const installed = makeInstalled({ sourceType: undefined });
    let symlinkCalled = false;
    const ports = makePorts({
      getInstalledBundle: async () => installed,
      listSources: async () => [makeSource({ type: 'local-skills' })],
      uninstallSkillSymlink: async () => {
        symlinkCalled = true;
      }
    });

    await uninstallInstalledBundle('bundle-1', 'user', ports);

    expect(symlinkCalled).toBe(true);
  });

  it('skips source resolution entirely when the installation record has no sourceId', async () => {
    const installed = makeInstalled({ sourceId: undefined });
    let listSourcesCalled = false;
    const ports = makePorts({
      getInstalledBundle: async () => installed,
      listSources: async () => {
        listSourcesCalled = true;
        return [];
      }
    });

    await uninstallInstalledBundle('bundle-1', 'user', ports);

    expect(listSourcesCalled).toBe(false);
  });

  it('removes the installation record for user/workspace scope, keyed by the resolved bundleId', async () => {
    const installed = makeInstalled({ bundleId: 'resolved-id', scope: 'workspace' });
    let removeArgs: [string, string] | undefined;
    const ports = makePorts({
      getInstalledBundle: async () => installed,
      removeInstallation: async (bundleId, scope) => {
        removeArgs = [bundleId, scope];
      }
    });

    await uninstallInstalledBundle('bundle-1', 'workspace', ports);

    expect(removeArgs).toEqual(['resolved-id', 'workspace']);
  });

  it('does not remove an installation record for repository scope (already updated by the uninstall port itself)', async () => {
    const installed = makeInstalled({ bundleId: 'repo-bundle', scope: 'repository' });
    let removeCalled = false;
    const ports = makePorts({
      getRepositoryInstalledBundles: async () => [installed],
      removeInstallation: async () => {
        removeCalled = true;
      }
    });

    await uninstallInstalledBundle('repo-bundle', 'repository', ports);

    expect(removeCalled).toBe(false);
  });

  it('emits log events without throwing when onLog is omitted', async () => {
    const ports = makePorts({
      getInstalledBundle: async () => makeInstalled()
    });

    await expect(uninstallInstalledBundle('bundle-1', 'user', ports)).resolves.toBeDefined();
  });

  it('emits an info log when starting and a debug log for the local-skills symlink path', async () => {
    const installed = makeInstalled({ sourceType: 'local-skills' });
    const ports = makePorts({
      getInstalledBundle: async () => installed
    });
    const events: string[] = [];

    await uninstallInstalledBundle('bundle-1', 'user', ports, (event) => events.push(`${event.level}:${event.message}`));

    expect(events).toContain('info:Uninstalling bundle: bundle-1');
    expect(events.some((e) => e.startsWith('debug:Uninstalling local skill symlink'))).toBe(true);
  });
});
