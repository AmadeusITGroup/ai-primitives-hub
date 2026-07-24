/**
 * Tests for registry/load-hub-sources.ts (Stage 2: source-loading/dedup).
 */
import type {
  HubSource,
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

function makePorts(initial: RegistrySource[] = []): {
  listSources: ReturnType<typeof vi.fn>;
  addSource: ReturnType<typeof vi.fn>;
  updateSource: ReturnType<typeof vi.fn>;
  sources: RegistrySource[];
} {
  const sources = [...initial];
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
    })
  };
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
});

describe('loadHubSources', () => {
  let ports: ReturnType<typeof makePorts>;

  beforeEach(() => {
    ports = makePorts();
  });

  it('adds enabled sources as new RegistrySource entries', async () => {
    const source = makeHubSource();
    const result = await loadHubSources('hub-a', [source], ports);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(ports.addSource).toHaveBeenCalledWith(expect.objectContaining({
      id: generateSourceId('awesome-copilot', source.url, { branch: 'main', collectionsPath: 'collections' }),
      name: 'Source 1',
      hubId: 'hub-a'
    }));
  });

  it('skips disabled sources', async () => {
    const result = await loadHubSources('hub-a', [makeHubSource({ enabled: false })], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(ports.addSource).not.toHaveBeenCalled();
  });

  it('updates an existing source with the same generated id instead of duplicating', async () => {
    const source = makeHubSource();
    await loadHubSources('hub-a', [source], ports);

    const result = await loadHubSources('hub-a', [{ ...source, name: 'Renamed' }], ports);

    expect(result).toEqual({ added: 0, updated: 1, skipped: 0 });
    expect(ports.sources).toHaveLength(1);
    expect(ports.sources[0].name).toBe('Renamed');
  });

  it('skips a true duplicate (same url/type/branch/collectionsPath under a different id)', async () => {
    const existing = makeRegistrySource({ id: 'manually-added' });
    ports = makePorts([existing]);

    const result = await loadHubSources('hub-a', [makeHubSource()], ports);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(ports.sources).toHaveLength(1);
  });

  it('allows the same url with a different branch as a distinct source', async () => {
    ports = makePorts([makeRegistrySource()]);

    const result = await loadHubSources(
      'hub-a',
      [makeHubSource({ id: 'source-develop', config: { branch: 'develop', collectionsPath: 'collections' } })],
      ports
    );

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0 });
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

    expect(result).toEqual({ added: 2, updated: 0, skipped: 1 });
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

    expect(result).toEqual({ added: 1, updated: 0, skipped: 1 });
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
    expect(events.some((m) => m.includes('Hub source loading complete for hub-a: 1 added, 0 updated, 0 skipped'))).toBe(true);
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
