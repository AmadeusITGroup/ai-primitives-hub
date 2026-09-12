/**
 * Tests for registry/load-hub-sources.ts (Stage 2: source-loading/dedup).
 */
import type {
  HubSource,
  LogEvent,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  generateSourceId,
} from '@ai-primitives-hub/core';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  findDuplicateSource,
  loadHubSources,
  loadHubSourcesProgressively,
} from '../../src/registry/load-hub-sources';

function makeHubSource(overrides: Partial<HubSource> = {}): HubSource {
  return {
    id: 'source-1',
    name: 'Source 1',
    type: 'awesome-copilot',
    url: 'https://github.com/github/awesome-copilot',
    enabled: true,
    priority: 1,
    config: { branch: 'main', collectionsPath: 'collections' },
    ...overrides
  };
}

function makeRegistrySource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'existing-source',
    name: 'Existing Source',
    type: 'awesome-copilot',
    url: 'https://github.com/github/awesome-copilot',
    enabled: true,
    priority: 1,
    config: { branch: 'main', collectionsPath: 'collections' },
    ...overrides
  };
}

function makePorts(
  initial: RegistrySource[] = [],
  installedBundleSourceIds: string[] = []
): {
  listSources: ReturnType<typeof vi.fn>;
  addSource: ReturnType<typeof vi.fn>;
  updateSource: ReturnType<typeof vi.fn>;
  removeSource: ReturnType<typeof vi.fn>;
  listInstalledBundles: ReturnType<typeof vi.fn>;
  sources: RegistrySource[];
} {
  const sources = [...initial];
  const installed = installedBundleSourceIds.map((sourceId, index) => ({
    bundleId: `bundle-${index}`,
    sourceId
  }));
  return {
    sources,
    listSources: vi.fn(async () => [...sources]),
    addSource: vi.fn(async (source: RegistrySource) => {
      sources.push(source);
    }),
    updateSource: vi.fn(async (id: string, updates: Partial<RegistrySource>) => {
      const index = sources.findIndex((s) => s.id === id);
      if (index !== -1) {
        sources[index] = { ...sources[index], ...updates };
      }
    }),
    removeSource: vi.fn(async (id: string) => {
      const index = sources.findIndex((s) => s.id === id);
      if (index !== -1) {
        sources.splice(index, 1);
      }
    }),
    listInstalledBundles: vi.fn(async () => [...installed])
  };
}

/**
 * Capture every log event a sync emits, so assertions can count events by
 * level and inspect their content.
 * @returns The captured events array and the `onLog` sink to pass to the sync.
 */
function collectEvents(): { events: LogEvent[]; onLog: (event: LogEvent) => void } {
  const events: LogEvent[] = [];
  return { events, onLog: (event) => events.push(event) };
}

describe('findDuplicateSource', () => {
  it('matches when type, url, branch, and collectionsPath are identical', () => {
    const existing = [makeRegistrySource()];
    const result = findDuplicateSource(makeHubSource(), existing);
    expect(result).toBe(existing[0]);
  });

  it('does not match a different branch', () => {
    const existing = [makeRegistrySource({ config: { branch: 'main', collectionsPath: 'collections' } })];
    const result = findDuplicateSource(
      makeHubSource({ config: { branch: 'develop', collectionsPath: 'collections' } }),
      existing
    );
    expect(result).toBeUndefined();
  });

  it('does not match a different collectionsPath', () => {
    const existing = [makeRegistrySource({ config: { branch: 'main', collectionsPath: 'collections' } })];
    const result = findDuplicateSource(
      makeHubSource({ config: { branch: 'main', collectionsPath: 'prompts' } }),
      existing
    );
    expect(result).toBeUndefined();
  });

  it('does not match a different url or type', () => {
    const existing = [makeRegistrySource()];
    expect(findDuplicateSource(makeHubSource({ url: 'https://github.com/org/other' }), existing)).toBeUndefined();
    expect(findDuplicateSource(makeHubSource({ type: 'github' }), existing)).toBeUndefined();
  });

  it('defaults missing branch/collectionsPath to main/collections on both sides', () => {
    const existing = [makeRegistrySource({ config: undefined })];
    const result = findDuplicateSource(makeHubSource({ config: undefined }), existing);
    expect(result).toBe(existing[0]);
  });

  it('does not match Artifactory sources with different index files', () => {
    const existing = [makeRegistrySource({
      type: 'artifactory',
      url: 'https://artifactory.example/repository',
      config: { indexFile: 'index-v1.json' }
    })];
    expect(findDuplicateSource(makeHubSource({
      type: 'artifactory',
      url: 'https://artifactory.example/repository',
      config: { indexFile: 'catalog.json' }
    }), existing)).toBeUndefined();
  });
});

describe('loadHubSources', () => {
  let ports: ReturnType<typeof makePorts>;

  beforeEach(() => {
    ports = makePorts();
  });

  it('includes an Artifactory indexFile in the generated source identity', async () => {
    const source = makeHubSource({
      type: 'artifactory',
      url: 'https://artifactory.example/repository',
      config: { indexFile: 'catalog.json' }
    });

    await loadHubSources('hub-a', [source], ports);

    expect(ports.addSource).toHaveBeenCalledWith(expect.objectContaining({
      id: generateSourceId('artifactory', source.url, { indexFile: 'catalog.json' })
    }));
  });

  it('adds enabled sources as new RegistrySource entries', async () => {
    const source = makeHubSource();
    const result = await loadHubSources('hub-a', [source], ports);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 0 });
    expect(ports.addSource).toHaveBeenCalledWith(expect.objectContaining({
      id: generateSourceId('awesome-copilot', source.url, { branch: 'main', collectionsPath: 'collections' }),
      name: 'Source 1',
      hubId: 'hub-a'
    }));
  });

  it('skips disabled sources', async () => {
    const result = await loadHubSources('hub-a', [makeHubSource({ enabled: false })], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
    expect(ports.addSource).not.toHaveBeenCalled();
  });

  it('updates an existing source with the same generated id instead of duplicating', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);

    const result = await loadHubSources('hub-a', [{ ...source, name: 'Renamed' }], ports);

    expect(result).toEqual({ added: 0, updated: 1, skipped: 0, removed: 0 });
    expect(ports.sources).toHaveLength(1);
    expect(ports.sources[0].name).toBe('Renamed');
  });

  it('skips a true duplicate (same url/type/branch/collectionsPath under a different id)', async () => {
    const existing = makeRegistrySource({ id: 'manually-added' });
    ports = makePorts([existing]);

    const result = await loadHubSources('hub-a', [makeHubSource()], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
    expect(ports.sources).toHaveLength(1);
  });

  it('allows the same url with a different branch as a distinct source', async () => {
    ports = makePorts([makeRegistrySource()]);

    const result = await loadHubSources(
      'hub-a',
      [makeHubSource({ id: 'source-develop', config: { branch: 'develop', collectionsPath: 'collections' } })],
      ports
    );

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 0 });
    expect(ports.sources).toHaveLength(2);
  });

  it('continues loading remaining sources when one addSource call fails', async () => {
    ports.addSource = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Source validation failed: HTTP 404'))
      .mockResolvedValueOnce(undefined);

    const sources = [
      makeHubSource({ id: 's1', url: 'https://github.com/org/one' }),
      makeHubSource({ id: 's2', url: 'https://github.com/org/two' }),
      makeHubSource({ id: 's3', url: 'https://github.com/org/three' })
    ];

    const result = await loadHubSources('hub-a', sources, ports);

    expect(result).toEqual({ added: 2, updated: 0, skipped: 1, removed: 0 });
  });

  it('adds sources concurrently without exceeding the configured limit', async () => {
    let activeAdds = 0;
    let maxActiveAdds = 0;
    let startedAdds = 0;
    let releaseAdds: (() => void) | undefined;
    const addsReleased = new Promise<void>((resolve) => {
      releaseAdds = resolve;
    });
    let firstBatchStarted: (() => void) | undefined;
    const firstBatchReady = new Promise<void>((resolve) => {
      firstBatchStarted = resolve;
    });

    ports.addSource = vi.fn(async () => {
      activeAdds++;
      startedAdds++;
      maxActiveAdds = Math.max(maxActiveAdds, activeAdds);
      if (startedAdds === 2) {
        firstBatchStarted?.();
      }
      await addsReleased;
      activeAdds--;
    });

    const sources = [
      makeHubSource({ id: 's1', url: 'https://github.com/org/one' }),
      makeHubSource({ id: 's2', url: 'https://github.com/org/two' }),
      makeHubSource({ id: 's3', url: 'https://github.com/org/three' })
    ];

    const loading = loadHubSources('hub-a', sources, ports, undefined, { concurrency: 2 });
    await firstBatchReady;

    expect(startedAdds).toBe(2);
    expect(maxActiveAdds).toBe(2);

    releaseAdds?.();
    await loading;

    expect(startedAdds).toBe(3);
    expect(maxActiveAdds).toBe(2);
  });

  it('notifies only after a source is added successfully', async () => {
    const addedSources: string[] = [];
    ports.addSource = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Source validation failed'));

    const result = await loadHubSources(
      'hub-a',
      [
        makeHubSource({ id: 's1', url: 'https://github.com/org/one' }),
        makeHubSource({ id: 's2', url: 'https://github.com/org/two' })
      ],
      ports,
      undefined,
      {
        concurrency: 2,
        onSourceAdded: (source) => addedSources.push(source.id)
      }
    );

    expect(result).toEqual({ added: 1, updated: 0, skipped: 1, removed: 0 });
    expect(addedSources).toEqual([
      generateSourceId('awesome-copilot', 'https://github.com/org/one', {
        branch: 'main',
        collectionsPath: 'collections'
      })
    ]);
  });

  it('propagates a listSources failure', async () => {
    ports.listSources = vi.fn().mockRejectedValue(new Error('storage unavailable'));

    await expect(loadHubSources('hub-a', [makeHubSource()], ports)).rejects.toThrow('storage unavailable');
  });

  it('emits log events through the onLog callback', async () => {
    const events: string[] = [];
    await loadHubSources('hub-a', [makeHubSource()], ports, (event) => events.push(event.message));

    expect(events.some((m) => m.includes('Found 1 sources in hub hub-a'))).toBe(true);
    expect(events.some((m) => m.includes('Adding new hub source'))).toBe(true);
    expect(events.some((m) => m.includes('Hub source loading complete for hub-a: 1 added, 0 updated, 0 skipped, 0 removed'))).toBe(true);
  });

  it('prunes an orphaned source when a hub collection URL is renamed', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);
    expect(ports.sources).toHaveLength(1);

    // Simulate a repository rename: same logical source, new URL -> new sourceId.
    const renamed = makeHubSource({ url: 'https://github.com/github/awesome-copilot-renamed' });
    const result = await loadHubSources('hub-a', [renamed], ports);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 1 });
    expect(ports.sources).toHaveLength(1);
    expect(ports.sources[0].url).toBe('https://github.com/github/awesome-copilot-renamed');
    expect(ports.removeSource).toHaveBeenCalledTimes(1);
  });

  it('does not touch manually-added sources (no hubId) or sources from other hubs', async () => {
    const manual = makeRegistrySource({ id: 'manual', url: 'https://github.com/org/manual', hubId: undefined });
    const otherHub = makeRegistrySource({ id: 'other', url: 'https://github.com/org/other', hubId: 'hub-b' });
    ports = makePorts([manual, otherHub]);

    const result = await loadHubSources('hub-a', [makeHubSource()], ports);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 0 });
    expect(ports.removeSource).not.toHaveBeenCalled();
    expect(ports.sources.map((s) => s.id)).toEqual(expect.arrayContaining(['manual', 'other']));
  });

  it('prunes an orphan whose collection was removed from the hub config entirely', async () => {
    const stale = makeRegistrySource({ id: 'stale', url: 'https://github.com/org/stale', hubId: 'hub-a' });
    ports = makePorts([stale]);

    const result = await loadHubSources('hub-a', [], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 0, removed: 1 });
    expect(ports.sources).toHaveLength(0);
  });

  it('does not prune a previously-synced source that is later disabled in the hub config', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);
    expect(ports.sources).toHaveLength(1);

    const result = await loadHubSources('hub-a', [{ ...source, enabled: false }], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
    expect(ports.removeSource).not.toHaveBeenCalled();
    expect(ports.sources).toHaveLength(1);
  });

  it('skips orphan pruning entirely when any addSource fails this sync', async () => {
    const stale = makeRegistrySource({ id: 'stale', url: 'https://github.com/org/stale', hubId: 'hub-a' });
    ports = makePorts([stale]);
    ports.addSource = vi.fn().mockRejectedValue(new Error('Source validation failed: HTTP 503'));

    const result = await loadHubSources('hub-a', [makeHubSource()], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
    expect(ports.removeSource).not.toHaveBeenCalled();
    expect(ports.sources.map((s) => s.id)).toContain('stale');
  });

  it('keeps an orphaned source that still has installed bundles referencing it when remapBundleSource is not provided', async () => {
    const stale = makeRegistrySource({ id: 'stale', url: 'https://github.com/org/stale', hubId: 'hub-a' });
    ports = makePorts([stale], ['stale']);

    const result = await loadHubSources('hub-a', [], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 0, removed: 0 });
    expect(ports.removeSource).not.toHaveBeenCalled();
    expect(ports.sources.map((s) => s.id)).toContain('stale');
  });

  it('remaps and removes an orphan with installed consumers when remapBundleSource is provided and a replacement exists', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);
    expect(ports.sources).toHaveLength(1);

    const oldSourceId = ports.sources[0].id;

    // Seed installed bundles referencing the old source
    ports.listInstalledBundles = vi.fn(async () => [{ bundleId: 'bundle-0', sourceId: oldSourceId }]);
    const remapFn = vi.fn(async () => {});
    (ports as Record<string, unknown>).remapBundleSource = remapFn;

    // Rename URL -> new sourceId, old one becomes orphan with consumers
    const renamed = makeHubSource({ url: 'https://github.com/github/awesome-copilot-renamed' });
    const result = await loadHubSources('hub-a', [renamed], ports);

    const renamedId = generateSourceId('awesome-copilot', renamed.url, {
      branch: 'main',
      collectionsPath: 'collections'
    });
    expect(remapFn).toHaveBeenCalledWith(oldSourceId, renamedId);
    expect(result.removed).toBe(1);
    expect(ports.sources.every((s) => s.url === 'https://github.com/github/awesome-copilot-renamed')).toBe(true);
  });

  it('keeps an orphan when remapBundleSource fails (does not strand bundles)', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);
    const oldSourceId = ports.sources[0].id;

    ports.listInstalledBundles = vi.fn(async () => [{ bundleId: 'bundle-0', sourceId: oldSourceId }]);
    const remapFn = vi.fn(async () => {
      throw new Error('lockfile write failed');
    });
    (ports as Record<string, unknown>).remapBundleSource = remapFn;

    const renamed = makeHubSource({ url: 'https://github.com/github/awesome-copilot-renamed' });
    const result = await loadHubSources('hub-a', [renamed], ports);

    expect(result.removed).toBe(0);
    expect(ports.sources.map((s) => s.id)).toContain(oldSourceId);
  });

  it('prunes an orphan with no installed consumers even when listInstalledBundles is provided', async () => {
    const stale = makeRegistrySource({ id: 'stale', url: 'https://github.com/org/stale', hubId: 'hub-a' });
    ports = makePorts([stale], ['some-other-source']);

    const result = await loadHubSources('hub-a', [], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 0, removed: 1 });
    expect(ports.removeSource).toHaveBeenCalledWith('stale');
    expect(ports.sources).toHaveLength(0);
  });

  describe('hubSourceId sticker persistence', () => {
    it('stores the declaration id as hubSourceId on a newly added source', async () => {
      const declaration = makeHubSource({ id: 'stable-sticker' });

      const result = await loadHubSources('hub-a', [declaration], ports);

      expect(result).toEqual({ added: 1, updated: 0, skipped: 0, removed: 0 });
      expect(ports.addSource).toHaveBeenCalledWith(expect.objectContaining({
        hubId: 'hub-a',
        hubSourceId: 'stable-sticker'
      }));
      expect(ports.sources[0].hubSourceId).toBe('stable-sticker');
    });

    it('backfills hubSourceId on a source that was persisted without it', async () => {
      const declaration = makeHubSource({ id: 'stable-sticker' });
      const storedId = generateSourceId(declaration.type, declaration.url, {
        branch: 'main',
        collectionsPath: 'collections'
      });
      const stored = makeRegistrySource({ id: storedId, hubId: 'hub-a' });
      expect(stored.hubSourceId).toBeUndefined();
      ports = makePorts([stored]);

      const result = await loadHubSources('hub-a', [declaration], ports);

      expect(result).toEqual({ added: 0, updated: 1, skipped: 0, removed: 0 });
      expect(ports.updateSource).toHaveBeenCalledWith(
        storedId,
        expect.objectContaining({ hubSourceId: 'stable-sticker' })
      );
      expect(ports.sources[0].hubSourceId).toBe('stable-sticker');
    });

    it('stores no hubSourceId key when the declaration carries no id', async () => {
      const declaration = makeHubSource({ id: undefined as unknown as string });

      await loadHubSources('hub-a', [declaration], ports);

      const addedSource = ports.addSource.mock.calls[0][0] as RegistrySource;
      expect(Object.hasOwn(addedSource, 'hubSourceId')).toBe(false);
      expect(Object.hasOwn(ports.sources[0], 'hubSourceId')).toBe(false);
    });

    it('writes no hubSourceId key on update when the declaration carries no id', async () => {
      const declaration = makeHubSource({ id: undefined as unknown as string });
      const storedId = generateSourceId(declaration.type, declaration.url, {
        branch: 'main',
        collectionsPath: 'collections'
      });
      ports = makePorts([makeRegistrySource({ id: storedId, hubId: 'hub-a' })]);

      await loadHubSources('hub-a', [declaration], ports);

      const updates = ports.updateSource.mock.calls[0][1] as Partial<RegistrySource>;
      expect(Object.hasOwn(updates, 'hubSourceId')).toBe(false);
      expect(Object.hasOwn(ports.sources[0], 'hubSourceId')).toBe(false);
    });
  });

  describe('replacement eligibility (only sources registered this cycle)', () => {
    it('never selects a disabled sibling declaration as the replacement', async () => {
      const orphan = makeRegistrySource({
        id: 'orphan-old',
        name: 'Alpha (pre-rename)',
        url: 'https://github.com/org/alpha-old',
        hubId: 'hub-a',
        hubSourceId: 'src-alpha'
      });
      ports = makePorts([orphan], ['orphan-old']);
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;

      const disabledSibling = makeHubSource({
        id: 'src-beta',
        name: 'Beta',
        url: 'https://github.com/org/beta',
        enabled: false
      });

      const result = await loadHubSources('hub-a', [disabledSibling], ports);

      // A disabled declaration is never written to storage, so its generated id
      // must not be a remap target: remapping onto it would point installed
      // bundles at a source id storage never received.
      expect(remapFn).not.toHaveBeenCalled();
      expect(ports.removeSource).not.toHaveBeenCalled();
      expect(result.removed).toBe(0);
      expect(ports.sources.map((s) => s.id)).toContain('orphan-old');
    });

    it('never selects a declaration whose addSource rejected, and suspends all orphan handling for that sync', async () => {
      const orphan = makeRegistrySource({
        id: 'orphan-old',
        name: 'Alpha (pre-rename)',
        url: 'https://github.com/org/alpha-old',
        hubId: 'hub-a',
        hubSourceId: 'src-alpha'
      });
      const consumerFreeOrphan = makeRegistrySource({
        id: 'orphan-free',
        name: 'Gamma (pre-rename)',
        url: 'https://github.com/org/gamma-old',
        hubId: 'hub-a',
        hubSourceId: 'src-gamma'
      });
      ports = makePorts([orphan, consumerFreeOrphan], ['orphan-old']);
      ports.addSource = vi.fn().mockRejectedValue(new Error('Source validation failed: HTTP 503'));
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;

      const renamedAlpha = makeHubSource({
        id: 'src-alpha',
        name: 'Alpha',
        url: 'https://github.com/org/alpha-new'
      });

      const result = await loadHubSources('hub-a', [renamedAlpha], ports);

      expect(remapFn).not.toHaveBeenCalled();
      expect(ports.removeSource).not.toHaveBeenCalled();
      // Orphan evaluation itself is suspended, not just the removal.
      expect(ports.listInstalledBundles).not.toHaveBeenCalled();
      expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
      expect(ports.sources.map((s) => s.id)).toEqual(
        expect.arrayContaining(['orphan-old', 'orphan-free'])
      );
    });

    it('keeps a matched duplicate protected from pruning', async () => {
      const duplicate = makeRegistrySource({
        id: 'manually-added',
        name: 'Alpha (manual)',
        url: 'https://github.com/org/alpha',
        hubId: 'hub-a',
        config: { branch: 'main', collectionsPath: 'collections' }
      });
      ports = makePorts([duplicate]);
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;

      const declaration = makeHubSource({
        id: 'src-alpha',
        name: 'Alpha',
        url: 'https://github.com/org/alpha'
      });

      const result = await loadHubSources('hub-a', [declaration], ports);

      expect(result).toEqual({ added: 0, updated: 0, skipped: 1, removed: 0 });
      expect(ports.removeSource).not.toHaveBeenCalled();
      expect(remapFn).not.toHaveBeenCalled();
      expect(ports.sources.map((s) => s.id)).toEqual(['manually-added']);
    });
  });

  describe('replacement selection on a multi-source hub', () => {
    const storedIdFor = (url: string): string => generateSourceId('awesome-copilot', url, {
      branch: 'main',
      collectionsPath: 'collections'
    });

    const ALPHA_URL = 'https://github.com/org/alpha';
    const BETA_URL = 'https://github.com/org/beta';
    const GAMMA_OLD_URL = 'https://github.com/org/gamma-old';
    const GAMMA_NEW_URL = 'https://github.com/org/gamma-new';

    it('remaps the renamed source onto its own new id, never onto a sibling', async () => {
      const alphaId = storedIdFor(ALPHA_URL);
      const betaId = storedIdFor(BETA_URL);
      const gammaOldId = storedIdFor(GAMMA_OLD_URL);
      const gammaNewId = storedIdFor(GAMMA_NEW_URL);

      ports = makePorts(
        [
          makeRegistrySource({
            id: alphaId,
            name: 'Alpha',
            url: ALPHA_URL,
            hubId: 'hub-a',
            hubSourceId: 'src-alpha'
          }),
          makeRegistrySource({
            id: betaId,
            name: 'Beta',
            url: BETA_URL,
            hubId: 'hub-a',
            hubSourceId: 'src-beta'
          }),
          makeRegistrySource({
            id: gammaOldId,
            name: 'Gamma (pre-rename)',
            url: GAMMA_OLD_URL,
            hubId: 'hub-a',
            hubSourceId: 'src-gamma'
          })
        ],
        [gammaOldId]
      );
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;

      // Only gamma is renamed: its `id` stays `src-gamma`, its `url` changes.
      const result = await loadHubSources(
        'hub-a',
        [
          makeHubSource({ id: 'src-alpha', name: 'Alpha', url: ALPHA_URL }),
          makeHubSource({ id: 'src-beta', name: 'Beta', url: BETA_URL }),
          makeHubSource({ id: 'src-gamma', name: 'Gamma', url: GAMMA_NEW_URL })
        ],
        ports
      );

      expect(remapFn).toHaveBeenCalledTimes(1);
      expect(remapFn).toHaveBeenCalledWith(gammaOldId, gammaNewId);

      // No sibling id may ever be handed to the remap as the replacement.
      const replacementIds = remapFn.mock.calls.map((call) => (call as unknown as string[])[1]);
      expect(replacementIds).not.toContain(alphaId);
      expect(replacementIds).not.toContain(betaId);

      expect(result).toEqual({ added: 1, updated: 2, skipped: 0, removed: 1 });
      expect(ports.removeSource).toHaveBeenCalledWith(gammaOldId);
      expect(ports.sources.map((s) => s.id).toSorted()).toEqual([alphaId, betaId, gammaNewId].toSorted());
    });
  });

  describe('keep-alive when the match is not provable', () => {
    /**
     * The remediation every keep-alive warning must end with, so the reader
     * learns the convention that prevents the situation from recurring.
     */
    const REMEDIATION = 'keep a source\'s `id` stable when changing its `url`';

    const storedIdFor = (url: string): string => generateSourceId('awesome-copilot', url, {
      branch: 'main',
      collectionsPath: 'collections'
    });

    const ORPHAN_ID = 'orphan-old';
    const ORPHAN_NAME = 'Alpha (pre-rename)';

    /** The two installed records that make the orphan un-deletable. */
    const CONSUMER_COUNT = 2;

    const makeOrphan = (overrides: Partial<RegistrySource> = {}): RegistrySource => makeRegistrySource({
      id: ORPHAN_ID,
      name: ORPHAN_NAME,
      url: 'https://github.com/org/alpha-old',
      hubId: 'hub-a',
      hubSourceId: 'src-alpha',
      ...overrides
    });

    /**
     * Assert the single keep-alive warning for `orphanId` carries every
     * diagnostic fragment Requirement 3.6 demands.
     * @param events Log events captured from the sync.
     * @param reasonMarker The keep-alive reason marker expected in the message.
     */
    const expectSingleKeepAliveWarning = (events: LogEvent[], reasonMarker: string): void => {
      const warnings = events.filter(
        (event) => event.level === 'warn' && event.message.includes(ORPHAN_ID)
      );

      expect(warnings).toHaveLength(1);
      const { message } = warnings[0];
      expect(message).toContain(ORPHAN_ID);
      expect(message).toContain(ORPHAN_NAME);
      expect(message).toContain(String(CONSUMER_COUNT));
      expect(message).toContain(reasonMarker);
      expect(message).toContain(REMEDIATION);
    };

    /**
     * Assert the orphan survived the sync untouched: still stored, excluded
     * from `removed`, and with no installed record repointed.
     * @param result The sync result counts.
     * @param activePorts The ports used for the sync.
     */
    const expectOrphanKeptAlive = async (
      result: Awaited<ReturnType<typeof loadHubSources>>,
      activePorts: ReturnType<typeof makePorts>
    ): Promise<void> => {
      expect(activePorts.sources.map((s) => s.id)).toContain(ORPHAN_ID);
      expect(activePorts.removeSource).not.toHaveBeenCalledWith(ORPHAN_ID);
      expect(result.removed).toBe(0);

      const installed = await activePorts.listInstalledBundles();
      expect(installed.filter((b: { sourceId: string }) => b.sourceId === ORPHAN_ID))
        .toHaveLength(CONSUMER_COUNT);
    };

    it('keeps the orphan alive and warns with a no-candidate reason when nothing matches its sticker', async () => {
      ports = makePorts([makeOrphan()], [ORPHAN_ID, ORPHAN_ID]);
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;
      const { events, onLog } = collectEvents();

      // A sibling declaration carrying a different sticker: registered this
      // cycle, but no evidence that it replaces the orphan.
      const result = await loadHubSources(
        'hub-a',
        [makeHubSource({ id: 'src-beta', name: 'Beta', url: 'https://github.com/org/beta' })],
        ports,
        onLog
      );

      expect(remapFn).not.toHaveBeenCalled();
      await expectOrphanKeptAlive(result, ports);
      expectSingleKeepAliveWarning(events, 'no-candidate');
    });

    it('keeps the orphan alive and warns with an ambiguous-candidates reason when two declarations share its sticker', async () => {
      ports = makePorts([makeOrphan()], [ORPHAN_ID, ORPHAN_ID]);
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;
      const { events, onLog } = collectEvents();

      const result = await loadHubSources(
        'hub-a',
        [
          makeHubSource({ id: 'src-alpha', name: 'Alpha one', url: 'https://github.com/org/alpha-one' }),
          makeHubSource({ id: 'src-alpha', name: 'Alpha two', url: 'https://github.com/org/alpha-two' })
        ],
        ports,
        onLog
      );

      expect(remapFn).not.toHaveBeenCalled();
      await expectOrphanKeptAlive(result, ports);
      expectSingleKeepAliveWarning(events, 'ambiguous-candidates');
    });

    it('keeps the orphan alive and warns with a missing-sticker reason when the orphan carries no hubSourceId', async () => {
      ports = makePorts([makeOrphan({ hubSourceId: undefined })], [ORPHAN_ID, ORPHAN_ID]);
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;
      const { events, onLog } = collectEvents();

      const result = await loadHubSources(
        'hub-a',
        [makeHubSource({ id: 'src-alpha', name: 'Alpha', url: 'https://github.com/org/alpha-new' })],
        ports,
        onLog
      );

      expect(remapFn).not.toHaveBeenCalled();
      await expectOrphanKeptAlive(result, ports);
      expectSingleKeepAliveWarning(events, 'missing-sticker');
    });

    it('keeps the orphan alive and warns with a remap-failed reason when the remap port rejects', async () => {
      ports = makePorts([makeOrphan()], [ORPHAN_ID, ORPHAN_ID]);
      const remapFn = vi.fn(async () => {
        throw new Error('lockfile write failed');
      });
      (ports as Record<string, unknown>).remapBundleSource = remapFn;
      const { events, onLog } = collectEvents();

      const renamed = makeHubSource({
        id: 'src-alpha',
        name: 'Alpha',
        url: 'https://github.com/org/alpha-new'
      });
      const result = await loadHubSources('hub-a', [renamed], ports, onLog);

      expect(remapFn).toHaveBeenCalledWith(ORPHAN_ID, storedIdFor(renamed.url));
      await expectOrphanKeptAlive(result, ports);
      expectSingleKeepAliveWarning(events, 'remap-failed');
    });

    it('keeps the orphan alive and warns with a port-absent reason when remapBundleSource is not wired', async () => {
      ports = makePorts([makeOrphan()], [ORPHAN_ID, ORPHAN_ID]);
      const { events, onLog } = collectEvents();

      const result = await loadHubSources(
        'hub-a',
        [makeHubSource({ id: 'src-alpha', name: 'Alpha', url: 'https://github.com/org/alpha-new' })],
        ports,
        onLog
      );

      await expectOrphanKeptAlive(result, ports);
      expectSingleKeepAliveWarning(events, 'port-absent');
    });
  });

  describe('reporting a successful remap', () => {
    const ORPHAN_ID = 'orphan-old';
    const ORPHAN_STICKER = 'src-alpha';
    const RENAMED_URL = 'https://github.com/org/alpha-new';

    /** The installed records the remap moves onto the replacement. */
    const CONSUMER_COUNT = 2;

    it('emits exactly one info event naming the record count, both source ids, and the matched sticker', async () => {
      const orphan = makeRegistrySource({
        id: ORPHAN_ID,
        name: 'Alpha (pre-rename)',
        url: 'https://github.com/org/alpha-old',
        hubId: 'hub-a',
        hubSourceId: ORPHAN_STICKER
      });
      ports = makePorts([orphan], [ORPHAN_ID, ORPHAN_ID]);
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;
      const { events, onLog } = collectEvents();

      const renamed = makeHubSource({
        id: ORPHAN_STICKER,
        name: 'Alpha',
        url: RENAMED_URL
      });
      const replacementId = generateSourceId(renamed.type, RENAMED_URL, {
        branch: 'main',
        collectionsPath: 'collections'
      });

      const result = await loadHubSources('hub-a', [renamed], ports, onLog);

      // Guard the premise: this only reports on the success path.
      expect(remapFn).toHaveBeenCalledWith(ORPHAN_ID, replacementId);
      expect(result.removed).toBe(1);

      // The report is the only info line that names the retired source id.
      const reports = events.filter(
        (event) => event.level === 'info' && event.message.includes(ORPHAN_ID)
      );
      expect(reports).toHaveLength(1);

      const { message } = reports[0];
      expect(message).toContain(String(CONSUMER_COUNT));
      expect(message).toContain(ORPHAN_ID);
      expect(message).toContain(replacementId);
      expect(message).toContain(ORPHAN_STICKER);
    });
  });

  describe('determinism and isolation guards', () => {
    const storedIdFor = (url: string): string => generateSourceId('awesome-copilot', url, {
      branch: 'main',
      collectionsPath: 'collections'
    });

    const ALPHA_URL = 'https://github.com/org/alpha';
    const BETA_URL = 'https://github.com/org/beta';
    const GAMMA_OLD_URL = 'https://github.com/org/gamma-old';
    const GAMMA_NEW_URL = 'https://github.com/org/gamma-new';

    /**
     * The stored-source set for a three-source hub whose gamma entry was
     * renamed, with installed bundles pinned to the pre-rename gamma id.
     * @returns A fresh set of stored sources (the sync mutates them).
     */
    const makeRenamedHubStore = (): RegistrySource[] => [
      makeRegistrySource({
        id: storedIdFor(ALPHA_URL),
        name: 'Alpha',
        url: ALPHA_URL,
        hubId: 'hub-a',
        hubSourceId: 'src-alpha'
      }),
      makeRegistrySource({
        id: storedIdFor(BETA_URL),
        name: 'Beta',
        url: BETA_URL,
        hubId: 'hub-a',
        hubSourceId: 'src-beta'
      }),
      makeRegistrySource({
        id: storedIdFor(GAMMA_OLD_URL),
        name: 'Gamma (pre-rename)',
        url: GAMMA_OLD_URL,
        hubId: 'hub-a',
        hubSourceId: 'src-gamma'
      })
    ];

    const renamedHubDeclarations = (): HubSource[] => [
      makeHubSource({ id: 'src-alpha', name: 'Alpha', url: ALPHA_URL }),
      makeHubSource({ id: 'src-beta', name: 'Beta', url: BETA_URL }),
      makeHubSource({ id: 'src-gamma', name: 'Gamma', url: GAMMA_NEW_URL })
    ];

    /**
     * Run one sync of the renamed three-source hub at a given concurrency.
     * @param concurrency The `concurrency` option to pass to the sync.
     * @returns The replacement id handed to `remapBundleSource`.
     */
    const replacementIdAtConcurrency = async (concurrency: number): Promise<string> => {
      const gammaOldId = storedIdFor(GAMMA_OLD_URL);
      const runPorts = makePorts(makeRenamedHubStore(), [gammaOldId]);
      const remapFn = vi.fn(async () => {});
      (runPorts as Record<string, unknown>).remapBundleSource = remapFn;

      await loadHubSources('hub-a', renamedHubDeclarations(), runPorts, undefined, { concurrency });

      expect(remapFn).toHaveBeenCalledTimes(1);
      const [oldId, newId] = remapFn.mock.calls[0] as unknown as [string, string];
      expect(oldId).toBe(gammaOldId);
      return newId;
    };

    it('selects the same replacement id at concurrency greater than 1 as at concurrency 1', async () => {
      const sequential = await replacementIdAtConcurrency(1);
      const parallel = await replacementIdAtConcurrency(4);

      expect(parallel).toBe(sequential);
      expect(sequential).toBe(storedIdFor(GAMMA_NEW_URL));
    });

    it('removes a consumer-free orphan without invoking the remap port', async () => {
      const stale = makeRegistrySource({
        id: 'stale',
        name: 'Stale',
        url: 'https://github.com/org/stale',
        hubId: 'hub-a',
        hubSourceId: 'src-stale'
      });
      ports = makePorts([stale], []);
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;

      const result = await loadHubSources('hub-a', [], ports);

      expect(remapFn).not.toHaveBeenCalled();
      expect(ports.removeSource).toHaveBeenCalledWith('stale');
      expect(result.removed).toBe(1);
      expect(ports.sources).toHaveLength(0);
    });

    it('leaves a source with no hubId and a source owned by another hub byte-identical across a sync', async () => {
      const manual = makeRegistrySource({
        id: 'manual',
        name: 'Manual',
        url: 'https://github.com/org/manual',
        hubId: undefined,
        hubSourceId: 'src-gamma'
      });
      const otherHub = makeRegistrySource({
        id: 'other-hub-source',
        name: 'Other hub',
        url: 'https://github.com/org/other',
        hubId: 'hub-b',
        hubSourceId: 'src-gamma'
      });
      // Installed bundles reference both, and both carry the sticker of the
      // renamed declaration: neither may be treated as this hub's orphan.
      ports = makePorts([...makeRenamedHubStore(), manual, otherHub], [
        storedIdFor(GAMMA_OLD_URL),
        'manual',
        'other-hub-source'
      ]);
      const remapFn = vi.fn(async () => {});
      (ports as Record<string, unknown>).remapBundleSource = remapFn;

      const before = structuredClone(
        ports.sources.filter((s) => s.id === 'manual' || s.id === 'other-hub-source')
      );

      await loadHubSources('hub-a', renamedHubDeclarations(), ports);

      const after = ports.sources.filter((s) => s.id === 'manual' || s.id === 'other-hub-source');
      expect(after).toEqual(before);
      expect(ports.removeSource).not.toHaveBeenCalledWith('manual');
      expect(ports.removeSource).not.toHaveBeenCalledWith('other-hub-source');
      expect(ports.updateSource).not.toHaveBeenCalledWith('manual', expect.anything());
      expect(ports.updateSource).not.toHaveBeenCalledWith('other-hub-source', expect.anything());

      const remappedOldIds = remapFn.mock.calls.map((call) => (call as unknown as string[])[0]);
      expect(remappedOldIds).not.toContain('manual');
      expect(remappedOldIds).not.toContain('other-hub-source');
    });
  });
});

describe('loadHubSourcesProgressively', () => {
  let ports: ReturnType<typeof makePorts>;

  beforeEach(() => {
    ports = makePorts();
  });

  it('enqueues each newly added source for syncSource', async () => {
    const synced: string[] = [];
    const { onComplete } = loadHubSourcesProgressively(
      'hub-a',
      [
        makeHubSource({ id: 's1', url: 'https://github.com/org/one' }),
        makeHubSource({ id: 's2', url: 'https://github.com/org/two' })
      ],
      ports,
      undefined,
      {
        concurrency: 2,
        syncSource: async (id) => {
          synced.push(id);
        }
      }
    );

    await onComplete();

    expect(synced).toHaveLength(2);
    const addedIds = ports.sources.map((s) => s.id);
    expect(synced.toSorted()).toEqual(addedIds.toSorted());
  });

  it('onFirstSettled resolves after the first sync settles', async () => {
    let releaseFirst!: () => void;
    const firstBlocker = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const syncCalls: string[] = [];

    const { onFirstSettled, onComplete } = loadHubSourcesProgressively(
      'hub-a',
      [makeHubSource({ id: 's1', url: 'https://github.com/org/one' })],
      ports,
      undefined,
      {
        syncSource: async (id) => {
          syncCalls.push(id);
          await firstBlocker;
        }
      }
    );

    let firstSettled = false;
    const firstSettledPromise = onFirstSettled().then(() => {
      firstSettled = true;
    });

    await Promise.resolve();
    expect(firstSettled).toBe(false);

    releaseFirst();
    await firstSettledPromise;
    expect(firstSettled).toBe(true);

    await onComplete();
  });

  it('does not resolve onFirstSettled while a registered source is still syncing', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { onFirstSettled, onComplete } = loadHubSourcesProgressively(
      'hub-a',
      [makeHubSource()],
      ports,
      undefined,
      {
        syncSource: async () => blocker
      }
    );

    let firstSettled = false;
    const firstSettledPromise = onFirstSettled().then(() => {
      firstSettled = true;
    });

    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(firstSettled).toBe(false);

    release();
    await firstSettledPromise;
    await onComplete();
  });

  it('onComplete resolves only after all registrations and syncs finish', async () => {
    const releases: (() => void)[] = [];
    let allSyncsStarted!: () => void;
    const allSyncsStartedPromise = new Promise<void>((r) => {
      allSyncsStarted = r;
    });

    const { onComplete } = loadHubSourcesProgressively(
      'hub-a',
      [
        makeHubSource({ id: 's1', url: 'https://github.com/org/one' }),
        makeHubSource({ id: 's2', url: 'https://github.com/org/two' })
      ],
      ports,
      undefined,
      {
        concurrency: 2,
        syncSource: () => new Promise<void>((r) => {
          releases.push(r);
          if (releases.length === 2) {
            allSyncsStarted();
          }
        })
      }
    );

    // Wait until both background syncs have started (i.e. registration is done)
    await allSyncsStartedPromise;

    let completed = false;
    const completedPromise = onComplete().then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);

    releases[0]();
    await Promise.resolve();
    expect(completed).toBe(false);

    releases[1]();
    await completedPromise;
    expect(completed).toBe(true);
  });

  it('onFirstSettled resolves when registration finishes with no enabled sources', async () => {
    // Zero sources means no syncs are ever enqueued; onFirstSettled must not hang.
    const { onFirstSettled, onComplete } = loadHubSourcesProgressively(
      'hub-a',
      [makeHubSource({ enabled: false })],
      ports,
      undefined,
      {
        syncSource: async () => {
          // never called
        }
      }
    );

    // Should resolve without hanging (registration finishes, zero syncs)
    await onFirstSettled();
    await onComplete();
  });

  it('passes through a caller-supplied onSourceAdded hook alongside the sync enqueue', async () => {
    const notified: string[] = [];
    const synced: string[] = [];

    const { onComplete } = loadHubSourcesProgressively(
      'hub-a',
      [makeHubSource()],
      ports,
      undefined,
      {
        onSourceAdded: (source) => {
          notified.push(source.id);
        },
        syncSource: async (id) => {
          synced.push(id);
        }
      }
    );

    await onComplete();

    expect(notified).toHaveLength(1);
    expect(synced).toHaveLength(1);
    expect(notified[0]).toBe(synced[0]);
  });

  it('does not enqueue disabled sources for sync', async () => {
    const synced: string[] = [];

    const { onComplete } = loadHubSourcesProgressively(
      'hub-a',
      [makeHubSource({ enabled: false })],
      ports,
      undefined,
      {
        syncSource: async (id) => {
          synced.push(id);
        }
      }
    );

    await onComplete();

    expect(synced).toHaveLength(0);
  });
});
