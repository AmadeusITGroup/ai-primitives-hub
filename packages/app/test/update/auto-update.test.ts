/**
 * Tests for app/update/auto-update.ts.
 *
 * Ported behavior coverage from the extension's
 * `test/services/auto-update-service.test.ts`, translated into fakes
 * implementing `core`'s `BundleOperations`/`SourceOperations`/
 * `UpdateNotifier`/`UpdatePreferenceStore` ports instead of sinon-
 * stubbed `RegistryManager`/`RegistryStorage`/`BundleUpdateNotifications`
 * instances.
 */
import type {
  Bundle,
  BundleOperations,
  InstalledBundle,
  RegistrySource,
  SourceOperations,
  UpdateNotifier,
  UpdatePreferenceStore,
} from '@ai-primitives-hub/core';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  AutoUpdateCore,
} from '../../src/update';

function makeInstalledBundle(overrides: Partial<InstalledBundle> = {}): InstalledBundle {
  return {
    bundleId: 'bundle-1',
    version: '1.0.0',
    installedAt: '2024-01-01T00:00:00.000Z',
    scope: 'user',
    installPath: '/mock/path',
    manifest: {} as never,
    ...overrides
  };
}

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-1',
    name: 'Bundle 1',
    version: '1.0.0',
    description: 'Test',
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

class FakeNotifier implements UpdateNotifier {
  public completed: { bundleId: string; previousVersion: string; targetVersion: string }[] = [];
  public failures: { bundleId: string; error: string }[] = [];
  public batchSummaries: { successful: string[]; failed: { bundleId: string; error: string }[] }[] = [];

  public async showAutoUpdateComplete(bundleId: string, previousVersion: string, targetVersion: string): Promise<void> {
    this.completed.push({ bundleId, previousVersion, targetVersion });
  }

  public async showUpdateFailure(bundleId: string, error: string): Promise<void> {
    this.failures.push({ bundleId, error });
  }

  public async showBatchUpdateSummary(successful: string[], failed: { bundleId: string; error: string }[]): Promise<void> {
    this.batchSummaries.push({ successful, failed });
  }
}

class FakePreferenceStore implements UpdatePreferenceStore {
  private readonly prefs = new Map<string, boolean>();

  public async getUpdatePreference(bundleId: string): Promise<boolean> {
    return this.prefs.get(bundleId) ?? false;
  }

  public async setUpdatePreference(bundleId: string, autoUpdate: boolean): Promise<void> {
    this.prefs.set(bundleId, autoUpdate);
  }

  public async getUpdatePreferences() {
    const result: Record<string, { autoUpdate: boolean }> = {};
    for (const [bundleId, autoUpdate] of this.prefs) {
      result[bundleId] = { autoUpdate };
    }
    return result;
  }
}

describe('AutoUpdateCore.autoUpdateBundle', () => {
  let notifier: FakeNotifier;
  let preferences: FakePreferenceStore;

  beforeEach(() => {
    notifier = new FakeNotifier();
    preferences = new FakePreferenceStore();
  });

  it('updates the bundle and reports success', async () => {
    let listCalls = 0;
    const bundleOps: BundleOperations = {
      updateBundle: async () => {},
      listInstalledBundles: async () => {
        listCalls++;
        return [makeInstalledBundle({ version: listCalls === 1 ? '1.0.0' : '2.0.0' })];
      },
      getBundleDetails: async () => makeBundle()
    };
    const sourceOps: SourceOperations = { listSources: async () => [], syncSource: async () => {} };
    const core = new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences });

    await core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false });

    expect(notifier.completed).toEqual([{ bundleId: 'bundle-1', previousVersion: '1.0.0', targetVersion: '2.0.0' }]);
    expect(notifier.failures).toEqual([]);
  });

  it('rolls back and reports failure when the update fails to verify', async () => {
    const bundleOps: BundleOperations = {
      updateBundle: async () => {},
      // Version never actually changes -> verifyUpdate always fails -> rollback also "succeeds" at 1.0.0
      listInstalledBundles: async () => [makeInstalledBundle({ version: '1.0.0' })],
      getBundleDetails: async () => makeBundle()
    };
    const sourceOps: SourceOperations = { listSources: async () => [], syncSource: async () => {} };
    const core = new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences });

    await expect(core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false }))
      .rejects.toThrow('Update verification failed');

    expect(notifier.failures).toHaveLength(1);
    expect(notifier.failures[0].bundleId).toBe('bundle-1');
    expect(notifier.failures[0].error).toContain('Rolled back to version 1.0.0');
  });

  it('reports rollback failure distinctly when rollback itself cannot verify', async () => {
    const bundleOps: BundleOperations = {
      updateBundle: async (_bundleId, version) => {
        if (version === '1.0.0') {
          throw new Error('rollback update failed');
        }
      },
      listInstalledBundles: async () => [makeInstalledBundle({ version: '1.0.0' })],
      getBundleDetails: async () => makeBundle()
    };
    const sourceOps: SourceOperations = { listSources: async () => [], syncSource: async () => {} };
    const core = new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences });

    await expect(core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false }))
      .rejects.toThrow();

    expect(notifier.failures[0].error).toContain('Rollback failed');
  });

  it('rejects a second concurrent update for the same bundle', async () => {
    let resolveUpdate!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    });
    const bundleOps: BundleOperations = {
      updateBundle: async () => pending,
      listInstalledBundles: async () => [makeInstalledBundle()],
      getBundleDetails: async () => makeBundle()
    };
    const sourceOps: SourceOperations = { listSources: async () => [], syncSource: async () => {} };
    const core = new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences });

    const first = core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false });
    expect(core.isUpdateInProgress('bundle-1')).toBe(true);

    await expect(core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false }))
      .rejects.toThrow('already in progress');

    resolveUpdate();
    await first.catch(() => {});
    expect(core.isUpdateInProgress('bundle-1')).toBe(false);
  });

  it('validates required options', async () => {
    const bundleOps: BundleOperations = {
      updateBundle: async () => {},
      listInstalledBundles: async () => [],
      getBundleDetails: async () => makeBundle()
    };
    const sourceOps: SourceOperations = { listSources: async () => [], syncSource: async () => {} };
    const core = new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences });

    await expect(core.autoUpdateBundle({ bundleId: '', targetVersion: '2.0.0', showProgress: false }))
      .rejects.toThrow('Bundle ID is required');
  });
});

describe('AutoUpdateCore source syncing', () => {
  let notifier: FakeNotifier;
  let preferences: FakePreferenceStore;

  beforeEach(() => {
    notifier = new FakeNotifier();
    preferences = new FakePreferenceStore();
  });

  const coreWithSource = (source: RegistrySource | undefined, syncSource: SourceOperations['syncSource']): { core: AutoUpdateCore; syncCalls: string[] } => {
    const syncCalls: string[] = [];
    const bundleOps: BundleOperations = {
      updateBundle: async () => {},
      listInstalledBundles: async () => [makeInstalledBundle({ version: '2.0.0' })],
      getBundleDetails: async () => makeBundle({ sourceId: source?.id ?? 'missing' })
    };
    const sourceOps: SourceOperations = {
      listSources: async () => (source ? [source] : []),
      syncSource: async (id) => {
        syncCalls.push(id);
        return syncSource(id);
      }
    };
    return { core: new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences }), syncCalls };
  };

  it('syncs the source when it is a github release source', async () => {
    const source: RegistrySource = { id: 'gh-1', name: 'GH', type: 'github', url: 'u', enabled: true, priority: 1 };
    const { core, syncCalls } = coreWithSource(source, async () => {});

    await core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false });

    expect(syncCalls).toEqual(['gh-1']);
  });

  it('does not sync non-github sources', async () => {
    const source: RegistrySource = { id: 'ac-1', name: 'AC', type: 'awesome-copilot', url: 'u', enabled: true, priority: 1 };
    const { core, syncCalls } = coreWithSource(source, async () => {});

    await core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false });

    expect(syncCalls).toEqual([]);
  });

  it('continues the update even when source sync fails', async () => {
    const source: RegistrySource = { id: 'gh-1', name: 'GH', type: 'github', url: 'u', enabled: true, priority: 1 };
    const { core } = coreWithSource(source, async () => {
      throw new Error('sync failed');
    });

    await expect(core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false }))
      .resolves.toBeUndefined();
    expect(notifier.completed).toHaveLength(1);
  });

  it('continues the update when the bundle source cannot be found', async () => {
    const { core } = coreWithSource(undefined, async () => {});

    await expect(core.autoUpdateBundle({ bundleId: 'bundle-1', targetVersion: '2.0.0', showProgress: false }))
      .resolves.toBeUndefined();
    expect(notifier.completed).toHaveLength(1);
  });
});

describe('AutoUpdateCore.autoUpdateBundles', () => {
  it('updates only auto-update-enabled bundles and reports a batch summary', async () => {
    const notifier = new FakeNotifier();
    const preferences = new FakePreferenceStore();
    const updatedIds: string[] = [];
    const bundleOps: BundleOperations = {
      updateBundle: async (bundleId) => {
        updatedIds.push(bundleId);
      },
      listInstalledBundles: async () => [makeInstalledBundle({ bundleId: 'bundle-1', version: '2.0.0' })],
      getBundleDetails: async () => makeBundle()
    };
    const sourceOps: SourceOperations = { listSources: async () => [], syncSource: async () => {} };
    const core = new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences });

    await core.autoUpdateBundles([
      { bundleId: 'bundle-1', currentVersion: '1.0.0', latestVersion: '2.0.0', releaseDate: '', downloadUrl: '', autoUpdateEnabled: true },
      { bundleId: 'bundle-2', currentVersion: '1.0.0', latestVersion: '2.0.0', releaseDate: '', downloadUrl: '', autoUpdateEnabled: false }
    ]);

    expect(updatedIds).toEqual(['bundle-1']);
    expect(notifier.batchSummaries).toEqual([{ successful: ['bundle-1'], failed: [] }]);
  });

  it('rejects a non-array argument', async () => {
    const notifier = new FakeNotifier();
    const preferences = new FakePreferenceStore();
    const bundleOps: BundleOperations = {
      updateBundle: async () => {},
      listInstalledBundles: async () => [],
      getBundleDetails: async () => makeBundle()
    };
    const sourceOps: SourceOperations = { listSources: async () => [], syncSource: async () => {} };
    const core = new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences });

    await expect(core.autoUpdateBundles('not-an-array' as never)).rejects.toThrow(TypeError);
  });
});

describe('AutoUpdateCore preference delegation', () => {
  it('isAutoUpdateEnabled/setAutoUpdate/getAllAutoUpdatePreferences delegate to the preference store', async () => {
    const notifier = new FakeNotifier();
    const preferences = new FakePreferenceStore();
    const bundleOps: BundleOperations = {
      updateBundle: async () => {},
      listInstalledBundles: async () => [],
      getBundleDetails: async () => makeBundle()
    };
    const sourceOps: SourceOperations = { listSources: async () => [], syncSource: async () => {} };
    const core = new AutoUpdateCore({ bundleOps, sourceOps, notifier, preferences });

    expect(await core.isAutoUpdateEnabled('bundle-1')).toBe(false);
    await core.setAutoUpdate('bundle-1', true);
    expect(await core.isAutoUpdateEnabled('bundle-1')).toBe(true);
    expect(await core.getAllAutoUpdatePreferences()).toEqual({ 'bundle-1': true });
  });
});
