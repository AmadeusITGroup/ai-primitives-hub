import AdmZip from 'adm-zip';
import type { RegistrySource } from '@ai-primitives-hub/core';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { AzureDevOpsAdapter } from '../../src/adapters/azure-devops-adapter';
import { FakeAzureDevOpsApi } from '../helpers/fake-azure-devops-api';
import { FixedClock } from '../helpers/fixed-clock';

// ---------------------------------------------------------------------------
// URL constants matching the adapter's construction for myorg/myproject/myrepo
// ---------------------------------------------------------------------------

const ITEMS_BASE =
  'https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/items';

const COLLECTIONS_LIST_URL =
  `${ITEMS_BASE}?scopePath=/collections&recursionLevel=oneLevel` +
  `&versionDescriptor.version=main&api-version=7.1`;

const COMMITS_URL =
  'https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/commits' +
  '?searchCriteria.itemVersion.version=main&$top=1&api-version=7.1';

const REPO_URL =
  'https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo?api-version=7.1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'ado-test',
    name: 'ADO Test',
    type: 'azure-devops',
    url: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function makeAdapter(
  api: FakeAzureDevOpsApi = new FakeAzureDevOpsApi(),
  source: RegistrySource = makeSource(),
  clock: FixedClock = new FixedClock(0),
): AzureDevOpsAdapter {
  return new AzureDevOpsAdapter(source, api, clock);
}

interface AdoItemStub {
  path: string;
  isFolder: boolean;
  objectId: string;
  url: string;
}

function makeItemsResponse(paths: string[]): { value: AdoItemStub[] } {
  return {
    value: paths.map((path, i) => ({
      path,
      isFolder: false,
      objectId: `sha${i}`,
      url: `${ITEMS_BASE}?path=${encodeURIComponent(path)}&api-version=7.1`,
    })),
  };
}

function collectionYaml(overrides: Record<string, unknown> = {}): string {
  const c = {
    id: 'my-bundle',
    name: 'My Bundle',
    description: 'A test collection',
    version: '1.0.0',
    tags: ['azure', 'testing'],
    items: [{ path: 'prompts/foo.prompt.md', kind: 'prompt' }],
    ...overrides,
  };
  return yaml.dump(c);
}

/** URL the adapter uses to getText a collection YAML for the given path. */
function collectionTextUrl(path: string, branch = 'main'): string {
  return `${ITEMS_BASE}?path=${path}&versionDescriptor.version=${branch}&api-version=7.1`;
}

/** URL the adapter uses to download a single file by its repo path. */
function fileDownloadUrl(path: string, branch = 'main'): string {
  return `${ITEMS_BASE}?path=/${path}&versionDescriptor.version=${branch}&api-version=7.1`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AzureDevOpsAdapter', () => {
  describe('constructor', () => {
    it('accepts a valid dev.azure.com URL', () => {
      expect(() => makeAdapter()).not.toThrow();
    });

    it('throws when given a non-ADO URL', () => {
      expect(() =>
        makeAdapter(new FakeAzureDevOpsApi(), makeSource({ url: 'https://github.com/owner/repo' }))
      ).toThrow('Invalid Azure DevOps URL for source');
    });
  });

  describe('getManifestUrl / getDownloadUrl', () => {
    it('builds the ADO Items API URL with the default branch and collectionsPath', () => {
      const adapter = makeAdapter();
      const expected =
        `${ITEMS_BASE}?path=/collections/my-bundle.collection.yml` +
        `&versionDescriptor.version=main&api-version=7.1`;
      expect(adapter.getManifestUrl('my-bundle')).toBe(expected);
      expect(adapter.getDownloadUrl('my-bundle')).toBe(expected);
    });

    it('reflects a branch override in both URLs', () => {
      const adapter = makeAdapter(
        new FakeAzureDevOpsApi(),
        makeSource({ config: { branch: 'develop' } })
      );
      expect(adapter.getManifestUrl('my-bundle')).toContain('versionDescriptor.version=develop');
      expect(adapter.getDownloadUrl('my-bundle')).toContain('versionDescriptor.version=develop');
    });

    it('reflects a collectionsPath override in both URLs', () => {
      const adapter = makeAdapter(
        new FakeAzureDevOpsApi(),
        makeSource({ config: { collectionsPath: 'bundles' } })
      );
      expect(adapter.getManifestUrl('my-bundle')).toContain('path=/bundles/my-bundle.collection.yml');
    });
  });

  describe('requiresAuthentication', () => {
    it('defaults to false when the source is not marked private', () => {
      expect(makeAdapter().requiresAuthentication()).toBe(false);
    });

    it('is true when the source is marked private', () => {
      expect(makeAdapter(new FakeAzureDevOpsApi(), makeSource({ private: true })).requiresAuthentication()).toBe(true);
    });
  });

  describe('fetchBundles', () => {
    it('builds a bundle from a discovered .collection.yml item', async () => {
      const collPath = '/collections/my-bundle.collection.yml';
      const api = new FakeAzureDevOpsApi()
        .seedJson(COLLECTIONS_LIST_URL, makeItemsResponse([collPath]))
        .seedText(collectionTextUrl(collPath), collectionYaml())
        .seedJson(COMMITS_URL, { value: [{ commitId: 'abc123' }] });

      const [bundle] = await makeAdapter(api, makeSource(), new FixedClock(1_700_000_000_000)).fetchBundles();

      expect(bundle).toMatchObject({
        id: 'my-bundle',
        name: 'My Bundle',
        description: 'A test collection',
        version: '1.0.0',
        tags: ['azure', 'testing'],
        environments: ['cloud', 'testing'],
        sourceId: 'ado-test',
        license: 'MIT',
        size: '1 items',
        manifestUrl: `${ITEMS_BASE}?path=/collections/my-bundle.collection.yml&versionDescriptor.version=main&api-version=7.1`,
        downloadUrl: `${ITEMS_BASE}?path=/collections/my-bundle.collection.yml&versionDescriptor.version=main&api-version=7.1`,
      });
      expect(bundle.lastUpdated).toBe(new Date(1_700_000_000_000).toISOString());
      expect(bundle.readmeRevision).toBe('abc123');
    });

    it('attaches a content breakdown and mcpServers for the Marketplace UI', async () => {
      const collPath = '/collections/a.collection.yml';
      const yamlContent = yaml.dump({
        id: 'a',
        name: 'A',
        description: 'desc',
        items: [
          { path: 'prompts/x.prompt.md', kind: 'prompt' },
          { path: 'agents/y.agent.md', kind: 'agent' },
        ],
        mcpServers: { 'my-server': { command: 'node' } },
      });
      const api = new FakeAzureDevOpsApi()
        .seedJson(COLLECTIONS_LIST_URL, makeItemsResponse([collPath]))
        .seedText(collectionTextUrl(collPath), yamlContent)
        .seedJson(COMMITS_URL, { value: [{ commitId: 'head' }] });

      const [bundle] = await makeAdapter(api).fetchBundles();

      expect((bundle as unknown as { breakdown: Record<string, number> }).breakdown).toEqual({
        prompts: 1,
        instructions: 0,
        chatmodes: 0,
        agents: 1,
        skills: 0,
        mcpServers: 1,
      });
      expect((bundle as unknown as { mcpServers: unknown }).mcpServers).toEqual({ 'my-server': { command: 'node' } });
    });

    it('silently skips a .collection.yml whose getText call throws', async () => {
      const api = new FakeAzureDevOpsApi()
        .seedJson(COLLECTIONS_LIST_URL, makeItemsResponse([
          '/collections/good.collection.yml',
          '/collections/bad.collection.yml',
        ]))
        .seedText(collectionTextUrl('/collections/good.collection.yml'), collectionYaml({ id: 'good' }))
        // bad.collection.yml intentionally left unseeded — getText will throw
        .seedJson(COMMITS_URL, { value: [{ commitId: 'head' }] });

      const bundles = await makeAdapter(api).fetchBundles();
      expect(bundles.map((b) => b.id)).toEqual(['good']);
    });

    it('returns [] when the items listing contains no .collection.yml files', async () => {
      const api = new FakeAzureDevOpsApi()
        .seedJson(COLLECTIONS_LIST_URL, { value: [] })
        .seedJson(COMMITS_URL, { value: [{ commitId: 'head' }] });

      expect(await makeAdapter(api).fetchBundles()).toEqual([]);
    });

    it('ignores non-.collection.yml files in the listing', async () => {
      const api = new FakeAzureDevOpsApi()
        .seedJson(COLLECTIONS_LIST_URL, makeItemsResponse([
          '/collections/my-bundle.collection.yml',
          '/collections/README.md',
        ]))
        .seedText(collectionTextUrl('/collections/my-bundle.collection.yml'), collectionYaml())
        .seedJson(COMMITS_URL, { value: [{ commitId: 'head' }] });

      const bundles = await makeAdapter(api).fetchBundles();
      expect(bundles).toHaveLength(1);
    });

    it('returns cached results within the 5-minute TTL', async () => {
      const collPath = '/collections/my-bundle.collection.yml';
      const api = new FakeAzureDevOpsApi()
        .seedJson(COLLECTIONS_LIST_URL, makeItemsResponse([collPath]))
        .seedText(collectionTextUrl(collPath), collectionYaml())
        .seedJson(COMMITS_URL, { value: [{ commitId: 'head' }] });

      const clock = new FixedClock(0);
      const adapter = makeAdapter(api, makeSource(), clock);
      const first = await adapter.fetchBundles();

      // Second call with empty API (no URLs seeded) — must hit the cache
      const emptyApi = new FakeAzureDevOpsApi();
      const adapterWithEmptyApi = new AzureDevOpsAdapter(makeSource(), emptyApi, clock);
      // Use the same adapter instance for the cache test
      const second = await adapter.fetchBundles();
      expect(second).toBe(first); // same reference — cached
    });

    it('uses versionDescriptor.version from the branch override', async () => {
      const source = makeSource({ config: { branch: 'develop' } });
      const devListUrl = COLLECTIONS_LIST_URL.replace('version=main', 'version=develop');
      const devCollPath = '/collections/my-bundle.collection.yml';
      const devCommitsUrl = COMMITS_URL.replace('version=main', 'version=develop');
      const api = new FakeAzureDevOpsApi()
        .seedJson(devListUrl, makeItemsResponse([devCollPath]))
        .seedText(
          collectionTextUrl(devCollPath, 'develop'),
          collectionYaml()
        )
        .seedJson(devCommitsUrl, { value: [{ commitId: 'dev-head' }] });

      const bundles = await makeAdapter(api, source).fetchBundles();
      expect(bundles).toHaveLength(1);
    });

    it('wraps a listing failure with a descriptive error', async () => {
      await expect(makeAdapter().fetchBundles()).rejects.toThrow('Failed to list Azure DevOps collections');
    });
  });

  describe('downloadBundle', () => {
    it('produces a valid ZIP buffer for a prompt item', async () => {
      const collPath = '/collections/my-bundle.collection.yml';
      const collUrl = collectionTextUrl(collPath);
      const fileBytes = new TextEncoder().encode('# foo');
      const api = new FakeAzureDevOpsApi()
        .seedText(collUrl, collectionYaml({ items: [{ path: 'prompts/foo.prompt.md', kind: 'prompt' }] }))
        .seedBytes(fileDownloadUrl('prompts/foo.prompt.md'), fileBytes);

      const adapter = makeAdapter(api);
      const zip = await adapter.downloadBundle({ downloadUrl: adapter.getManifestUrl('my-bundle') } as never);

      // ZIP local-file-header magic: "PK\x03\x04"
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(zip.length).toBeGreaterThan(0);
    });

    it('embeds a flat deployment-manifest.yml with no metadata/common/bundle_settings blocks', async () => {
      const collPath = '/collections/my-bundle.collection.yml';
      const fileBytes = new TextEncoder().encode('# foo');
      const api = new FakeAzureDevOpsApi()
        .seedText(
          collectionTextUrl(collPath),
          collectionYaml({ items: [{ path: 'prompts/foo.prompt.md', kind: 'prompt' }] })
        )
        .seedBytes(fileDownloadUrl('prompts/foo.prompt.md'), fileBytes);

      const zip = await makeAdapter(api).downloadBundle({ downloadUrl: makeAdapter().getManifestUrl('my-bundle') } as never);

      const admZip = new AdmZip(zip);
      const manifestEntry = admZip.getEntry('deployment-manifest.yml');
      expect(manifestEntry).not.toBeNull();
      const manifest = yaml.load(admZip.readAsText(manifestEntry!)) as Record<string, unknown>;

      expect(manifest['id']).toBe('my-bundle');
      expect(manifest['name']).toBe('My Bundle');
      expect(manifest['version']).toBe('1.0.0');
      expect(manifest['license']).toBe('MIT');
      expect((manifest['prompts'] as { type: string }[])[0].type).toBe('prompt');
      expect(manifest).not.toHaveProperty('metadata');
      expect(manifest).not.toHaveProperty('common');
      expect(manifest).not.toHaveProperty('bundle_settings');
    });

    it('fetches all files in a skill item directory, stripping the leading slash', async () => {
      const collPath = '/collections/skills-bundle.collection.yml';
      const skillDirUrl =
        `${ITEMS_BASE}?scopePath=/skills/my-skill&recursionLevel=full` +
        `&versionDescriptor.version=main&api-version=7.1`;
      const skillItemUrl = `${ITEMS_BASE}?path=%2Fskills%2Fmy-skill%2FSKILL.md&api-version=7.1`;
      const api = new FakeAzureDevOpsApi()
        .seedText(
          collectionTextUrl(collPath),
          yaml.dump({
            id: 'skills-bundle',
            name: 'Skills Bundle',
            description: 'desc',
            items: [{ path: 'skills/my-skill/SKILL.md', kind: 'skill' }],
          })
        )
        .seedJson(skillDirUrl, makeItemsResponse(['/skills/my-skill/SKILL.md']))
        .seedBytes(skillItemUrl, new TextEncoder().encode('# skill'));

      const adapter = makeAdapter(api);
      const zip = await adapter.downloadBundle({
        downloadUrl: adapter.getManifestUrl('skills-bundle'),
      } as never);

      const admZip = new AdmZip(zip);
      const entries = admZip.getEntries().map((e) => e.entryName);
      expect(entries).toContain('skills/my-skill/SKILL.md');
      expect(entries.find((e) => e.startsWith('/'))).toBeUndefined();
    });

    it('rejects with a descriptive error when downloadUrl has no path= param', async () => {
      const adapter = makeAdapter();
      await expect(
        adapter.downloadBundle({ downloadUrl: 'https://dev.azure.com/no-path-param' } as never)
      ).rejects.toThrow('Cannot determine collection path from downloadUrl');
    });
  });

  describe('fetchMetadata', () => {
    it('returns the source name and bundle count', async () => {
      const api = new FakeAzureDevOpsApi()
        .seedJson(COLLECTIONS_LIST_URL, makeItemsResponse([
          '/collections/a.collection.yml',
          '/collections/b.collection.yml',
        ]));

      const metadata = await makeAdapter(api, makeSource(), new FixedClock(1_700_000_000_000)).fetchMetadata();
      expect(metadata).toEqual({
        name: 'myorg/myproject/myrepo',
        description: 'Azure DevOps Collections Repository',
        bundleCount: 2,
        lastUpdated: new Date(1_700_000_000_000).toISOString(),
        version: '1.0.0',
      });
    });
  });

  describe('validate', () => {
    it('is valid when the repo exists and collections are found', async () => {
      const api = new FakeAzureDevOpsApi()
        .seedJson(REPO_URL, {})
        .seedJson(COLLECTIONS_LIST_URL, makeItemsResponse(['/collections/a.collection.yml']));

      expect(await makeAdapter(api).validate()).toEqual({
        valid: true,
        errors: [],
        warnings: [],
        bundlesFound: 1,
      });
    });

    it('is invalid when the repo cannot be reached', async () => {
      // REPO_URL left unseeded — getJson throws 404
      const result = await makeAdapter().validate();
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Azure DevOps repository validation failed');
    });

    it('is invalid when the collections directory does not exist', async () => {
      const api = new FakeAzureDevOpsApi().seedJson(REPO_URL, {});
      // COLLECTIONS_LIST_URL left unseeded

      const result = await makeAdapter(api).validate();
      expect(result).toEqual({
        valid: false,
        errors: [`No collections directory found at 'collections'`],
        warnings: [],
        bundlesFound: 0,
      });
    });

    it('is invalid when the collections directory has no .collection.yml files', async () => {
      const api = new FakeAzureDevOpsApi()
        .seedJson(REPO_URL, {})
        .seedJson(COLLECTIONS_LIST_URL, { value: [] });

      const result = await makeAdapter(api).validate();
      expect(result).toEqual({
        valid: false,
        errors: [`No .collection.yml files found in collections/ directory`],
        warnings: [],
        bundlesFound: 0,
      });
    });

    it('reflects the collectionsPath override in the missing-dir error message', async () => {
      const api = new FakeAzureDevOpsApi().seedJson(REPO_URL, {});
      const adapter = makeAdapter(api, makeSource({ config: { collectionsPath: 'bundles' } }));

      const result = await adapter.validate();
      expect(result.errors[0]).toBe(`No collections directory found at 'bundles'`);
    });
  });

  describe('clearCache', () => {
    it('forces a re-fetch on the next fetchBundles call even within the TTL', async () => {
      const collPath = '/collections/my-bundle.collection.yml';
      const api = new FakeAzureDevOpsApi()
        .seedJson(COLLECTIONS_LIST_URL, makeItemsResponse([collPath]))
        .seedText(collectionTextUrl(collPath), collectionYaml())
        .seedJson(COMMITS_URL, { value: [{ commitId: 'head' }] });

      const clock = new FixedClock(0);
      const adapter = makeAdapter(api, makeSource(), clock);

      const first = await adapter.fetchBundles();
      expect(first).toHaveLength(1);

      // Without clearCache, a second call within the TTL returns the cache
      const second = await adapter.fetchBundles();
      expect(second).toBe(first);

      // After clearCache, the next call re-fetches (same api still has URLs seeded)
      adapter.clearCache();
      const third = await adapter.fetchBundles();
      expect(third).not.toBe(first); // new array — re-fetched
      expect(third).toHaveLength(1);
    });
  });
});
