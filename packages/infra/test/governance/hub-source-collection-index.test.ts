import type {
  Bundle,
  HubCollectionInventory,
  RegistrySource,
  SourceAdapter,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  AwesomeCopilotAdapter,
} from '../../src/adapters/awesome-copilot-adapter';
import {
  LocalAwesomeCopilotAdapter,
} from '../../src/adapters/local-awesome-copilot-adapter';
import {
  HubSourceCollectionIndex,
} from '../../src/governance/hub-source-collection-index';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  FixedClock,
} from '../helpers/fixed-clock';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

function source(id: string, type: RegistrySource['type'] = 'awesome-copilot', overrides: Partial<RegistrySource> = {}): RegistrySource {
  return { id, type, name: id, url: 'https://github.com/owner/repo', enabled: true, priority: 0, ...overrides };
}

function bundle(id: string, overrides: Partial<Bundle> = {}): Bundle {
  return {
    id, name: id, version: '1.0.0', description: 'A collection', author: 'owner', sourceId: 'adapter-source',
    environments: [], tags: [], lastUpdated: new Date(0).toISOString(), size: '0 items', dependencies: [], license: 'MIT',
    repository: 'https://github.com/owner/repo', manifestUrl: `collections/${id}.collection.yml`, downloadUrl: '', ...overrides
  };
}

function adapter(registrySource: RegistrySource, bundles: Bundle[] = []) {
  return {
    source: registrySource, type: registrySource.type,
    fetchBundles: vi.fn<SourceAdapter['fetchBundles']>().mockResolvedValue(bundles),
    fetchBundlesStrict: vi.fn<NonNullable<SourceAdapter['fetchBundlesStrict']>>().mockResolvedValue(bundles),
    downloadBundle: vi.fn(), fetchMetadata: vi.fn(), validate: vi.fn(), requiresAuthentication: vi.fn(),
    getManifestUrl: vi.fn(), getDownloadUrl: vi.fn(), downloadReadme: vi.fn()
  } satisfies SourceAdapter;
}

function releases() {
  return {
    listCollections: vi.fn<(repository: string, sourceId: string) => Promise<HubCollectionInventory>>()
      .mockResolvedValue({ collections: [], unverifiedSources: [] })
  };
}

function expectUnverified(inventory: HubCollectionInventory, sourceId: string): void {
  // Each unverified source explains why and how to fix it, without credentials, tokens or raw error text.
  expect(inventory.unverifiedSources).toEqual([expect.objectContaining({ sourceId, message: expect.any(String) })]);
  const { message, hint } = inventory.unverifiedSources[0];
  expect(`${message} ${hint ?? ''}`).toMatch(/fix|retry|check/i);
  expect(JSON.stringify(inventory.unverifiedSources)).not.toMatch(/user:SECRET|token=SECRET|sensitive|SECRET@/);
}

describe('HubSourceCollectionIndex', () => {
  it('returns an empty verified inventory when no sources are configured', async () => {
    const adapterForSource = vi.fn();
    const lookup = releases();
    expect(await new HubSourceCollectionIndex([], adapterForSource, lookup).read()).toEqual({ collections: [], unverifiedSources: [] });
    expect(adapterForSource).not.toHaveBeenCalled();
    expect(lookup.listCollections).not.toHaveBeenCalled();
  });

  it('fails unverified rather than reading a tolerant-only legacy catalog', async () => {
    const awesome = source('legacy');
    const legacy = { ...adapter(awesome, [bundle('possibly-incomplete')]), fetchBundlesStrict: undefined };
    const inventory = await new HubSourceCollectionIndex([awesome], () => legacy, releases()).read();
    expect(inventory.collections).toEqual([]);
    expectUnverified(inventory, awesome.id);
    expect(legacy.fetchBundles).not.toHaveBeenCalled();
  });

  it('walks enabled sources sorted by id without mutating the caller array', async () => {
    const sources = Object.freeze([source('z'), source('a', 'local-awesome-copilot')]);
    const adapterForSource = vi.fn((value: RegistrySource) => adapter(value, [bundle(value.id)]));
    const inventory = await new HubSourceCollectionIndex(sources, adapterForSource, releases()).read();
    expect(adapterForSource.mock.calls.map(([value]) => value.id)).toEqual(['a', 'z']);
    expect(inventory.collections.map((value) => value.sourceId)).toEqual(['a', 'z']);
    expect(sources.map((value) => value.id)).toEqual(['z', 'a']);
    expect(inventory.unverifiedSources).toEqual([]);
    for (const result of adapterForSource.mock.results) {
      expect(result.value.fetchBundlesStrict).toHaveBeenCalledExactlyOnceWith();
      expect(result.value.fetchBundles).not.toHaveBeenCalled();
    }
  });

  it('never accesses disabled sources or non-collection source types', async () => {
    const sources = [
      source('disabled-github', 'github', { enabled: false }),
      source('disabled-awesome', 'awesome-copilot', { enabled: false }),
      source('disabled-local-awesome', 'local-awesome-copilot', { enabled: false }),
      ...(['skills', 'local-skills', 'apm', 'local-apm', 'azure-devops', 'local'] as const).map((type) => source(type, type))
    ];
    const adapterForSource = vi.fn();
    const lookup = releases();
    expect(await new HubSourceCollectionIndex(sources, adapterForSource, lookup).read()).toEqual({ collections: [], unverifiedSources: [] });
    expect(adapterForSource).not.toHaveBeenCalled();
    expect(lookup.listCollections).not.toHaveBeenCalled();
  });

  it('uses the canonical GitHub inventory instead of namespaced release bundle ids', async () => {
    const github = source('github-source', 'github');
    const collection = { id: 'raw-id', name: 'Raw Name', sourceId: github.id, repository: github.url, file: 'release-manifest.yml' };
    const lookup = releases();
    lookup.listCollections.mockResolvedValue({ collections: [collection], unverifiedSources: [] });
    const adapterForSource = vi.fn();
    expect(await new HubSourceCollectionIndex([github], adapterForSource, lookup).read()).toEqual({ collections: [collection], unverifiedSources: [] });
    expect(lookup.listCollections).toHaveBeenCalledExactlyOnceWith(github.url, github.id, { idsOnly: false });
    expect(adapterForSource).not.toHaveBeenCalled();
  });

  it('preserves raw awesome collection ids, names and repository/file provenance', async () => {
    const awesome = source('awesome');
    const raw = bundle('owner-repo-raw-v1.0.0', { name: 'Canonical Name', manifestUrl: 'custom/definition.collection.yml' });
    const inventory = await new HubSourceCollectionIndex([awesome], () => adapter(awesome, [raw]), releases()).read();
    expect(inventory).toEqual({
      collections: [{ id: raw.id, name: raw.name, sourceId: awesome.id, repository: raw.repository, file: raw.manifestUrl }],
      unverifiedSources: []
    });
  });

  it('retains the configured repository when an adapter omits it', async () => {
    const awesome = source('awesome');
    const inventory = await new HubSourceCollectionIndex([awesome], () => adapter(awesome, [bundle('raw', { repository: undefined })]), releases()).read();
    expect(inventory.collections[0].repository).toBe(awesome.url);
  });

  it('deduplicates versions within one source while preserving the same identity across sources', async () => {
    const sources = [source('first'), source('second', 'local-awesome-copilot')];
    const inventory = await new HubSourceCollectionIndex(sources, (value) => adapter(value, [
      bundle('shared', { version: '1.0.0' }), bundle('shared', { version: '2.0.0' })
    ]), releases()).read();
    expect(inventory.collections.map(({ id, sourceId }) => ({ id, sourceId }))).toEqual([
      { id: 'shared', sourceId: 'first' }, { id: 'shared', sourceId: 'second' }
    ]);
    expect(inventory.unverifiedSources).toEqual([]);
  });

  it('deduplicates repeated GitHub collection identities within a source', async () => {
    const github = source('github-source', 'github');
    const collection = { id: 'raw', sourceId: github.id, repository: github.url };
    const lookup = releases();
    lookup.listCollections.mockResolvedValue({ collections: [collection, collection], unverifiedSources: [] });
    expect((await new HubSourceCollectionIndex([github], vi.fn(), lookup).read()).collections).toEqual([collection]);
  });

  it.each(['factory', 'catalog', 'github'] as const)('keeps other sources when the %s boundary fails without leaking errors', async (boundary) => {
    const failed = source('a-failed', boundary === 'github' ? 'github' : 'awesome-copilot', { url: 'https://user:SECRET@github.com/owner/repo?token=SECRET' });
    const healthy = source('z-healthy');
    const lookup = releases();
    lookup.listCollections.mockRejectedValue(new Error(`SECRET token=SECRET ${failed.url}`));
    const failedAdapter = adapter(failed);
    vi.mocked(failedAdapter.fetchBundlesStrict).mockRejectedValue(new Error(`SECRET token=SECRET ${failed.url}`));
    const adapterForSource = (value: RegistrySource) => {
      if (value.id === healthy.id) {
        return adapter(value, [bundle('healthy')]);
      }
      if (boundary === 'factory') {
        throw new Error(`SECRET token=SECRET ${failed.url}`);
      }
      return failedAdapter;
    };
    const inventory = await new HubSourceCollectionIndex([healthy, failed], adapterForSource, lookup).read();
    expect(inventory.collections.map((value) => value.id)).toEqual(['healthy']);
    expectUnverified(inventory, failed.id);
  });

  it('preserves a partial GitHub inventory but sanitizes its unverified diagnostic', async () => {
    const github = source('github-source', 'github');
    const collection = { id: 'verified', sourceId: github.id, repository: github.url };
    const lookup = releases();
    lookup.listCollections.mockResolvedValue({
      collections: [collection], unverifiedSources: [{ sourceId: github.id, message: 'SECRET https://user:SECRET@github.com token=SECRET' }]
    });
    const inventory = await new HubSourceCollectionIndex([github], vi.fn(), lookup).read();
    expect(inventory.collections).toEqual([collection]);
    // Lookup text is passed through so reports can say why, but credentials and tokens are stripped.
    expect(inventory.unverifiedSources).toEqual([expect.objectContaining({ sourceId: github.id })]);
    expect(inventory.unverifiedSources[0].message).not.toMatch(/user:SECRET|SECRET@|token=SECRET/);
    expect(inventory.unverifiedSources[0].message).toContain('token=[redacted]');
  });

  it.each([undefined, null, 42, '', '   ', ['invalid']])('marks an invalid raw collection id (%j) as unverified', async (id) => {
    const awesome = source('awesome');
    const malformed = { ...bundle('placeholder'), id } as unknown as Bundle;
    const inventory = await new HubSourceCollectionIndex([awesome], () => adapter(awesome, [bundle('good'), malformed]), releases()).read();
    expect(inventory.collections).toEqual([]);
    expectUnverified(inventory, awesome.id);
  });

  it('does not let a duplicate version hide an invalid id later in the same catalog', async () => {
    const awesome = source('awesome');
    const malformed = { ...bundle('good'), id: null } as unknown as Bundle;
    const inventory = await new HubSourceCollectionIndex([awesome], () => adapter(awesome, [bundle('good'), bundle('good'), malformed]), releases()).read();
    expect(inventory.collections).toEqual([]);
    expectUnverified(inventory, awesome.id);
  });

  it('rejects a malformed adapter catalog instead of treating it as empty', async () => {
    const awesome = source('awesome');
    const malformedAdapter = adapter(awesome);
    vi.mocked(malformedAdapter.fetchBundlesStrict).mockResolvedValue(null);
    const inventory = await new HubSourceCollectionIndex([awesome], () => malformedAdapter, releases()).read();
    expect(inventory.collections).toEqual([]);
    expectUnverified(inventory, awesome.id);
  });

  it.each([
    null,
    { collections: [], unverifiedSources: null },
    { collections: [{ id: 42 }], unverifiedSources: [] }
  ])('rejects a malformed GitHub inventory (%j)', async (value) => {
    const github = source('github-source', 'github');
    const lookup = releases();
    lookup.listCollections.mockResolvedValue(value as unknown as HubCollectionInventory);
    const inventory = await new HubSourceCollectionIndex([github], vi.fn(), lookup).read();
    expect(inventory.collections).toEqual([]);
    expectUnverified(inventory, github.id);
  });
});

const LIST_PATH = '/repos/owner/repo/contents/collections?ref=main';
const RAW_BASE = 'https://raw.githubusercontent.com/owner/repo/main/collections';
const LOCAL_ROOT = '/collections-root';

function collectionYaml(id: string): string {
  return `id: ${id}\nname: ${id}\ndescription: A collection\nitems: []\n`;
}

function seedRemote(api: FakeGitHubApi, ids: string[]): void {
  api.seedJson(LIST_PATH, ids.map((id) => ({ name: `${id}.collection.yml`, path: `collections/${id}.collection.yml`, type: 'file' })));
  for (const id of ids) {
    api.seedText(`${RAW_BASE}/${id}.collection.yml`, collectionYaml(id));
  }
}

describe('strict collection catalog integration', () => {
  it.each(['awesome-copilot', 'local-awesome-copilot'] as const)('reports malformed %s catalogs that the default fetch still tolerates', async (type) => {
    const registrySource = source('catalog', type, { url: type === 'awesome-copilot' ? 'https://github.com/owner/repo' : LOCAL_ROOT });
    let catalog: AwesomeCopilotAdapter | LocalAwesomeCopilotAdapter;
    if (type === 'awesome-copilot') {
      const api = new FakeGitHubApi();
      seedRemote(api, ['good', 'bad']);
      api.seedText(`${RAW_BASE}/bad.collection.yml`, 'id: [SECRET: invalid yaml');
      catalog = new AwesomeCopilotAdapter(registrySource, api, new FixedClock(0));
    } else {
      const fs = new InMemoryFileSystem();
      fs.seed(`${LOCAL_ROOT}/collections/good.collection.yml`, collectionYaml('good'));
      fs.seed(`${LOCAL_ROOT}/collections/bad.collection.yml`, 'id: [SECRET: invalid yaml');
      catalog = new LocalAwesomeCopilotAdapter(registrySource, fs);
    }
    const tolerant = await catalog.fetchBundles();
    expect(tolerant.map((value) => value.id)).toEqual(['good']);
    await expect(catalog.fetchBundles({ strict: true })).rejects.toThrow();
    const inventory = await new HubSourceCollectionIndex([registrySource], () => catalog, releases()).read();
    expect(inventory.collections).toEqual([]);
    expectUnverified(inventory, registrySource.id);
    expect((await catalog.fetchBundles({ strict: false })).map((value) => value.id)).toEqual(['good']);
  });

  it('does not seed the tolerant cache with a successful strict fetch', async () => {
    const api = new FakeGitHubApi();
    seedRemote(api, ['first']);
    const catalog = new AwesomeCopilotAdapter(source('catalog'), api, new FixedClock(0));
    expect((await catalog.fetchBundles({ strict: true })).map((value) => value.id)).toEqual(['first']);
    seedRemote(api, ['second']);
    expect((await catalog.fetchBundles()).map((value) => value.id)).toEqual(['second']);
  });

  it('neither reads nor overwrites an existing tolerant cache on successful strict fetches', async () => {
    const api = new FakeGitHubApi();
    seedRemote(api, ['cached']);
    const catalog = new AwesomeCopilotAdapter(source('catalog'), api, new FixedClock(0));
    const cached = await catalog.fetchBundles();
    seedRemote(api, ['fresh']);
    expect((await catalog.fetchBundles({ strict: true })).map((value) => value.id)).toEqual(['fresh']);
    expect(await catalog.fetchBundles()).toBe(cached);
  });

  it('rejects a remote collection download failure in strict mode', async () => {
    const api = new FakeGitHubApi().seedJson(LIST_PATH, [{ name: 'missing.collection.yml', path: 'collections/missing.collection.yml', type: 'file' }]);
    const catalog = new AwesomeCopilotAdapter(source('catalog'), api, new FixedClock(0));
    expect(await catalog.fetchBundles()).toEqual([]);
    await expect(catalog.fetchBundles({ strict: true })).rejects.toThrow();
  });

  it('detects malformed remote data after the fetch-concurrency batch boundary', async () => {
    const api = new FakeGitHubApi();
    seedRemote(api, ['one', 'two', 'three', 'four', 'five', 'bad']);
    api.seedText(`${RAW_BASE}/bad.collection.yml`, 'id: [invalid yaml');
    const catalog = new AwesomeCopilotAdapter(source('catalog'), api, new FixedClock(0));
    expect(await catalog.fetchBundles()).toHaveLength(5);
    await expect(catalog.fetchBundles({ strict: true })).rejects.toThrow();
  });
});
