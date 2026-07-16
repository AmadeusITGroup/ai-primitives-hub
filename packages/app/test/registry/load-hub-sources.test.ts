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
