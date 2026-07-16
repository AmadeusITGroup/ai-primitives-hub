/**
 * Tests for app/registry/search-registry-bundles.ts.
 *
 * No reference test suite exists for this module (it has no reference
 * branch counterpart at all — see the module's own header comment),
 * so this is new, from-scratch coverage mirroring the extension's
 * pre-port `RegistryManager.searchBundles`/`sortBundles` behavior:
 * cache-first per-source fetch, sourceId vs. enabled-only source
 * selection, per-source fetch-failure isolation, version
 * consolidation (+ its own failure fallback), text/tags/author/
 * environment filters, sortBy, and offset/limit pagination.
 */
import type {
  Bundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  LogEvent,
  SearchRegistryBundlesPorts,
} from '../../src/registry';
import {
  searchRegistryBundles,
} from '../../src/registry';

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-1',
    name: 'Bundle One',
    version: '1.0.0',
    description: 'A test bundle',
    author: 'author-1',
    sourceId: 'source-1',
    environments: ['vscode'],
    tags: ['test'],
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
    name: 'Source One',
    type: 'github',
    url: 'https://github.com/test/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

function makePorts(overrides: Partial<SearchRegistryBundlesPorts> = {}): SearchRegistryBundlesPorts {
  return {
    listSources: vi.fn().mockResolvedValue([]),
    getCachedSourceBundles: vi.fn().mockResolvedValue([]),
    cacheSourceBundles: vi.fn().mockResolvedValue(undefined),
    getAdapter: vi.fn(),
    consolidateBundles: vi.fn((bundles: Bundle[]) => bundles),
    ...overrides
  };
}

describe('searchRegistryBundles', () => {
  it('returns cached bundles without calling the adapter on a cache hit', async () => {
    const source = makeSource();
    const bundle = makeBundle();
    const getAdapter = vi.fn();
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([bundle]),
      getAdapter
    });

    const results = await searchRegistryBundles({}, ports);

    expect(results).toEqual([bundle]);
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('fetches from the adapter and caches the result on a cache miss', async () => {
    const source = makeSource();
    const bundle = makeBundle();
    const fetchBundles = vi.fn().mockResolvedValue([bundle]);
    const cacheSourceBundles = vi.fn().mockResolvedValue(undefined);
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([]),
      getAdapter: vi.fn().mockReturnValue({ fetchBundles }),
      cacheSourceBundles
    });

    const results = await searchRegistryBundles({}, ports);

    expect(fetchBundles).toHaveBeenCalledOnce();
    expect(cacheSourceBundles).toHaveBeenCalledWith('source-1', [bundle]);
    expect(results).toEqual([bundle]);
  });

  it('does not call the adapter on a cache miss when cacheOnly is true', async () => {
    const source = makeSource();
    const getAdapter = vi.fn();
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([]),
      getAdapter
    });

    const results = await searchRegistryBundles({ cacheOnly: true }, ports);

    expect(results).toEqual([]);
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('searches only the requested source when sourceId is set, even if it is disabled', async () => {
    const enabledSource = makeSource({ id: 'enabled-source', enabled: true });
    const disabledSource = makeSource({ id: 'disabled-source', enabled: false });
    const getCachedSourceBundles = vi.fn()
      .mockImplementation((sourceId: string) => Promise.resolve(sourceId === 'disabled-source' ? [makeBundle({ id: 'from-disabled' })] : []));
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([enabledSource, disabledSource]),
      getCachedSourceBundles
    });

    const results = await searchRegistryBundles({ sourceId: 'disabled-source' }, ports);

    expect(results.map((b) => b.id)).toEqual(['from-disabled']);
    expect(getCachedSourceBundles).toHaveBeenCalledOnce();
    expect(getCachedSourceBundles).toHaveBeenCalledWith('disabled-source');
  });

  it('skips disabled sources when no sourceId is given', async () => {
    const enabledSource = makeSource({ id: 'enabled-source', enabled: true });
    const disabledSource = makeSource({ id: 'disabled-source', enabled: false });
    const getCachedSourceBundles = vi.fn().mockResolvedValue([]);
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([enabledSource, disabledSource]),
      getCachedSourceBundles
    });

    await searchRegistryBundles({}, ports);

    expect(getCachedSourceBundles).toHaveBeenCalledOnce();
    expect(getCachedSourceBundles).toHaveBeenCalledWith('enabled-source');
  });

  it('aggregates bundles from multiple sources', async () => {
    const sourceA = makeSource({ id: 'source-a' });
    const sourceB = makeSource({ id: 'source-b' });
    const bundleA = makeBundle({ id: 'bundle-a', sourceId: 'source-a' });
    const bundleB = makeBundle({ id: 'bundle-b', sourceId: 'source-b' });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([sourceA, sourceB]),
      getCachedSourceBundles: vi.fn()
        .mockImplementation((sourceId: string) => Promise.resolve(sourceId === 'source-a' ? [bundleA] : [bundleB]))
    });

    const results = await searchRegistryBundles({}, ports);

    expect(results.map((b) => b.id).toSorted()).toEqual(['bundle-a', 'bundle-b']);
  });

  it('logs and skips a source whose cache lookup throws, without failing the whole search', async () => {
    const goodSource = makeSource({ id: 'good-source' });
    const badSource = makeSource({ id: 'bad-source' });
    const goodBundle = makeBundle({ id: 'good-bundle', sourceId: 'good-source' });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([badSource, goodSource]),
      getCachedSourceBundles: vi.fn()
        .mockImplementation((sourceId: string) => (sourceId === 'bad-source' ? Promise.reject(new Error('boom')) : Promise.resolve([goodBundle])))
    });
    const events: LogEvent[] = [];

    const results = await searchRegistryBundles({}, ports, (event) => events.push(event));

    expect(results).toEqual([goodBundle]);
    expect(events.some((e) => e.level === 'error' && e.message.includes('bad-source'))).toBe(true);
  });

  it('passes the aggregated bundle list to consolidateBundles', async () => {
    const source = makeSource();
    const bundle = makeBundle();
    const consolidateBundles = vi.fn((bundles: Bundle[]) => bundles);
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([bundle]),
      consolidateBundles
    });

    await searchRegistryBundles({}, ports);

    expect(consolidateBundles).toHaveBeenCalledWith([bundle]);
  });

  it('falls back to unconsolidated bundles and logs an error when consolidateBundles throws', async () => {
    const source = makeSource();
    const bundle = makeBundle();
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([bundle]),
      consolidateBundles: vi.fn(() => {
        throw new Error('consolidation failed');
      })
    });
    const events: LogEvent[] = [];

    const results = await searchRegistryBundles({}, ports, (event) => events.push(event));

    expect(results).toEqual([bundle]);
    expect(events.some((e) => e.level === 'error' && e.message.includes('Version consolidation failed'))).toBe(true);
  });

  it('filters by exact id match even when name/description do not match text', async () => {
    const source = makeSource();
    const bundle = makeBundle({ id: 'exact-id', name: 'Unrelated Name', description: 'Unrelated description' });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([bundle])
    });

    const results = await searchRegistryBundles({ text: 'exact-id' }, ports);

    expect(results).toEqual([bundle]);
  });

  it('filters by case-insensitive name/description substring match', async () => {
    const source = makeSource();
    const matching = makeBundle({ id: 'a', name: 'React Toolkit', description: 'desc' });
    const nonMatching = makeBundle({ id: 'b', name: 'Vue Toolkit', description: 'desc' });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([matching, nonMatching])
    });

    const results = await searchRegistryBundles({ text: 'react' }, ports);

    expect(results.map((b) => b.id)).toEqual(['a']);
  });

  it('filters by tags, matching if any query tag is present', async () => {
    const source = makeSource();
    const matching = makeBundle({ id: 'a', tags: ['frontend', 'react'] });
    const nonMatching = makeBundle({ id: 'b', tags: ['backend'] });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([matching, nonMatching])
    });

    const results = await searchRegistryBundles({ tags: ['react', 'vue'] }, ports);

    expect(results.map((b) => b.id)).toEqual(['a']);
  });

  it('filters by exact author match', async () => {
    const source = makeSource();
    const matching = makeBundle({ id: 'a', author: 'alice' });
    const nonMatching = makeBundle({ id: 'b', author: 'bob' });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([matching, nonMatching])
    });

    const results = await searchRegistryBundles({ author: 'alice' }, ports);

    expect(results.map((b) => b.id)).toEqual(['a']);
  });

  it('filters by environment membership', async () => {
    const source = makeSource();
    const matching = makeBundle({ id: 'a', environments: ['vscode', 'windsurf'] });
    const nonMatching = makeBundle({ id: 'b', environments: ['claude-code'] });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([matching, nonMatching])
    });

    const results = await searchRegistryBundles({ environment: 'windsurf' }, ports);

    expect(results.map((b) => b.id)).toEqual(['a']);
  });

  it('applies multiple filters together (ANDed)', async () => {
    const source = makeSource();
    const matching = makeBundle({ id: 'a', author: 'alice', tags: ['react'] });
    const wrongAuthor = makeBundle({ id: 'b', author: 'bob', tags: ['react'] });
    const wrongTag = makeBundle({ id: 'c', author: 'alice', tags: ['vue'] });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([matching, wrongAuthor, wrongTag])
    });

    const results = await searchRegistryBundles({ author: 'alice', tags: ['react'] }, ports);

    expect(results.map((b) => b.id)).toEqual(['a']);
  });

  it('sorts by downloads descending, treating missing downloads as 0', async () => {
    const source = makeSource();
    const low = makeBundle({ id: 'low', downloads: 5 });
    const high = makeBundle({ id: 'high', downloads: 50 });
    const none = makeBundle({ id: 'none' });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([low, none, high])
    });

    const results = await searchRegistryBundles({ sortBy: 'downloads' }, ports);

    expect(results.map((b) => b.id)).toEqual(['high', 'low', 'none']);
  });

  it('sorts by rating descending, treating missing rating as 0', async () => {
    const source = makeSource();
    const low = makeBundle({ id: 'low', rating: 2 });
    const high = makeBundle({ id: 'high', rating: 5 });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([low, high])
    });

    const results = await searchRegistryBundles({ sortBy: 'rating' }, ports);

    expect(results.map((b) => b.id)).toEqual(['high', 'low']);
  });

  it('sorts by recent (lastUpdated) descending', async () => {
    const source = makeSource();
    const older = makeBundle({ id: 'older', lastUpdated: '2023-01-01T00:00:00.000Z' });
    const newer = makeBundle({ id: 'newer', lastUpdated: '2024-06-01T00:00:00.000Z' });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([older, newer])
    });

    const results = await searchRegistryBundles({ sortBy: 'recent' }, ports);

    expect(results.map((b) => b.id)).toEqual(['newer', 'older']);
  });

  it('leaves order unchanged for sortBy "relevance"', async () => {
    const source = makeSource();
    const first = makeBundle({ id: 'first', downloads: 1 });
    const second = makeBundle({ id: 'second', downloads: 99 });
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue([first, second])
    });

    const results = await searchRegistryBundles({ sortBy: 'relevance' }, ports);

    expect(results.map((b) => b.id)).toEqual(['first', 'second']);
  });

  it('returns all results unpaginated when neither offset nor limit is set', async () => {
    const source = makeSource();
    const bundles = Array.from({ length: 5 }, (_, i) => makeBundle({ id: `b${i}` }));
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue(bundles)
    });

    const results = await searchRegistryBundles({}, ports);

    expect(results).toHaveLength(5);
  });

  it('paginates using explicit offset and limit', async () => {
    const source = makeSource();
    const bundles = Array.from({ length: 5 }, (_, i) => makeBundle({ id: `b${i}` }));
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue(bundles)
    });

    const results = await searchRegistryBundles({ offset: 1, limit: 2 }, ports);

    expect(results.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('defaults limit to 50 when only offset is set', async () => {
    const source = makeSource();
    const bundles = Array.from({ length: 60 }, (_, i) => makeBundle({ id: `b${i}` }));
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue(bundles)
    });

    const results = await searchRegistryBundles({ offset: 10 }, ports);

    expect(results).toHaveLength(50);
    expect(results[0].id).toBe('b10');
  });

  it('defaults offset to 0 when only limit is set', async () => {
    const source = makeSource();
    const bundles = Array.from({ length: 5 }, (_, i) => makeBundle({ id: `b${i}` }));
    const ports = makePorts({
      listSources: vi.fn().mockResolvedValue([source]),
      getCachedSourceBundles: vi.fn().mockResolvedValue(bundles)
    });

    const results = await searchRegistryBundles({ limit: 2 }, ports);

    expect(results.map((b) => b.id)).toEqual(['b0', 'b1']);
  });
});
