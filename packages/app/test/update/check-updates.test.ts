/**
 * Tests for app/update/check-updates.ts.
 *
 * Ported behavior coverage from the extension's
 * `test/services/update-checker.property.test.ts` (cache/bypass/GitHub-
 * only-sync properties), translated into example-based Vitest cases
 * since `UpdateCheckerCore` now depends only on `core` port shapes, not
 * a concrete `RegistryManager`/`RegistryStorage`.
 */
import type {
  Bundle,
  BundleUpdate,
  UpdateRegistryReader,
} from '@ai-primitives-hub/core';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type {
  LogEvent,
  UpdatePreferenceReader,
  UpdateResultCache,
} from '../../src/update';
import {
  UpdateCheckerCore,
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

class FakeCache implements UpdateResultCache {
  private stored: { results: import('@ai-primitives-hub/core').UpdateCheckResult[]; valid: boolean } | null = null;

  public async get() {
    return this.stored && this.stored.valid ? this.stored.results : null;
  }

  public async set(results: import('@ai-primitives-hub/core').UpdateCheckResult[]) {
    this.stored = { results, valid: true };
  }

  public isValid(): boolean {
    return this.stored?.valid ?? false;
  }

  public invalidate(): void {
    if (this.stored) {
      this.stored.valid = false;
    }
  }
}

function makeRegistry(overrides: Partial<UpdateRegistryReader> = {}): UpdateRegistryReader {
  return {
    listSources: async () => [],
    syncSource: async () => {},
    getBundleDetails: async () => makeBundle(),
    checkUpdates: async () => [],
    ...overrides
  };
}

const preferences: UpdatePreferenceReader = {
  getUpdatePreference: async () => false
};

describe('UpdateCheckerCore.checkForUpdates', () => {
  let cache: FakeCache;

  beforeEach(() => {
    cache = new FakeCache();
  });

  it('returns cached results without querying the registry when cache is valid', async () => {
    let checkUpdatesCalls = 0;
    const registry = makeRegistry({
      checkUpdates: async () => {
        checkUpdatesCalls++;
        return [];
      }
    });
    const checker = new UpdateCheckerCore({ registry, preferences, cache });

    await checker.checkForUpdates(false);
    expect(checkUpdatesCalls).toBe(1);

    const second = await checker.checkForUpdates(false);
    expect(checkUpdatesCalls).toBe(1);
    expect(second).toEqual([]);
  });

  it('bypassing the cache always re-queries the registry', async () => {
    let checkUpdatesCalls = 0;
    const registry = makeRegistry({
      checkUpdates: async () => {
        checkUpdatesCalls++;
        return [];
      }
    });
    const checker = new UpdateCheckerCore({ registry, preferences, cache });

    await checker.checkForUpdates(false);
    await checker.checkForUpdates(true);
    expect(checkUpdatesCalls).toBe(2);
  });

  it('enriches a raw BundleUpdate with bundle metadata and the auto-update preference', async () => {
    const update: BundleUpdate = { bundleId: 'bundle-1', currentVersion: '1.0.0', latestVersion: '2.0.0', changelog: 'notes' };
    const registry = makeRegistry({
      checkUpdates: async () => [update],
      getBundleDetails: async (id) => makeBundle({ id, lastUpdated: '2024-06-01T00:00:00.000Z', downloadUrl: 'https://x/y.zip' })
    });
    const checker = new UpdateCheckerCore({
      registry,
      preferences: { getUpdatePreference: async () => true },
      cache
    });

    const results = await checker.checkForUpdates(true);

    expect(results).toEqual([{
      bundleId: 'bundle-1',
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      releaseNotes: 'notes',
      releaseDate: '2024-06-01T00:00:00.000Z',
      downloadUrl: 'https://x/y.zip',
      autoUpdateEnabled: true
    }]);
  });

  it('syncs only github-type sources, not other source types', async () => {
    const synced: string[] = [];
    const registry = makeRegistry({
      listSources: async () => [
        { id: 'gh-1', name: 'GH', type: 'github', url: 'u', enabled: true, priority: 1 },
        { id: 'ac-1', name: 'AC', type: 'awesome-copilot', url: 'u', enabled: true, priority: 1 },
        { id: 'local-1', name: 'Local', type: 'local', url: 'u', enabled: true, priority: 1 }
      ] as never,
      syncSource: async (id: string) => {
        synced.push(id);
      }
    });
    const checker = new UpdateCheckerCore({ registry, preferences, cache });

    await checker.checkForUpdates(true);

    expect(synced).toEqual(['gh-1']);
  });

  it('continues the check when a single source sync fails', async () => {
    const registry = makeRegistry({
      listSources: async () => [
        { id: 'gh-1', name: 'GH', type: 'github', url: 'u', enabled: true, priority: 1 }
      ] as never,
      syncSource: async () => {
        throw new Error('network timeout');
      },
      checkUpdates: async () => []
    });
    const checker = new UpdateCheckerCore({ registry, preferences, cache });

    await expect(checker.checkForUpdates(true)).resolves.toEqual([]);
  });

  it('skips a bundle whose enrichment fails with a network/notfound/authentication error', async () => {
    const update: BundleUpdate = { bundleId: 'flaky', currentVersion: '1.0.0', latestVersion: '2.0.0' };
    const registry = makeRegistry({
      checkUpdates: async () => [update],
      getBundleDetails: async () => {
        throw new Error('request not found (404)');
      }
    });
    const checker = new UpdateCheckerCore({ registry, preferences, cache });

    const results = await checker.checkForUpdates(true);
    expect(results).toEqual([]);
  });

  it('rethrows on an unexpected enrichment error', async () => {
    const update: BundleUpdate = { bundleId: 'broken', currentVersion: '1.0.0', latestVersion: '2.0.0' };
    const registry = makeRegistry({
      checkUpdates: async () => [update],
      getBundleDetails: async () => {
        throw new Error('boom');
      }
    });
    const checker = new UpdateCheckerCore({ registry, preferences, cache });

    await expect(checker.checkForUpdates(true)).rejects.toThrow('Failed to enrich update results: boom');
  });

  it('throws when the registry returns malformed update data', async () => {
    const registry = makeRegistry({
      checkUpdates: async () => [{ bundleId: 'x' }] as never
    });
    const checker = new UpdateCheckerCore({ registry, preferences, cache });

    await expect(checker.checkForUpdates(true)).rejects.toThrow('Invalid update data received from registry manager');
  });

  it('emits log events through onLog', async () => {
    const events: LogEvent[] = [];
    const registry = makeRegistry();
    const checker = new UpdateCheckerCore({ registry, preferences, cache, onLog: (e) => events.push(e) });

    await checker.checkForUpdates(true);

    expect(events.some((e) => e.message.includes('Checking for bundle updates'))).toBe(true);
  });
});

describe('UpdateCheckerCore.getCachedResults', () => {
  it('returns whatever the cache currently holds', async () => {
    const cache = new FakeCache();
    const checker = new UpdateCheckerCore({ registry: makeRegistry(), preferences, cache });

    expect(await checker.getCachedResults()).toBeNull();

    await cache.set([]);
    expect(await checker.getCachedResults()).toEqual([]);
  });
});
