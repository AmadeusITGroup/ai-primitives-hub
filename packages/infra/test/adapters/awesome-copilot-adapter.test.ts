import type {
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AwesomeCopilotAdapter,
} from '../../src/adapters/awesome-copilot-adapter';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  FixedClock,
} from '../helpers/fixed-clock';
import {
  RecordingGitHubApi,
} from '../helpers/recording-github-api';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'awesome-copilot-test',
    name: 'Awesome Copilot Test',
    type: 'awesome-copilot',
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

const COLLECTIONS_LIST_PATH = '/repos/owner/repo/contents/collections?ref=main';
const RAW_REPO_BASE = 'https://raw.githubusercontent.com/owner/repo/main';
const RAW_BASE = `${RAW_REPO_BASE}/collections`;

function collectionYaml(overrides: Record<string, unknown> = {}): string {
  const collection = {
    id: 'azure-cloud-development',
    name: 'Azure & Cloud Development',
    description: 'Comprehensive Azure tools',
    version: '2.0.0',
    author: 'jdoe',
    tags: ['azure', 'testing'],
    items: [
      { path: 'prompts/foo.prompt.md', kind: 'prompt' },
      { path: 'instructions/bar.instructions.md', kind: 'instruction' }
    ],
    ...overrides
  };
  return [
    `id: ${collection.id}`,
    `name: ${collection.name}`,
    `description: ${collection.description}`,
    `version: ${collection.version}`,
    `author: ${collection.author}`,
    `tags: [${collection.tags.join(', ')}]`,
    'items:',
    ...(collection.items as { path: string; kind: string }[]).map((item) => `  - path: ${item.path}\n    kind: ${item.kind}`)
  ].join('\n');
}

describe('AwesomeCopilotAdapter', () => {
  describe('getManifestUrl / getDownloadUrl', () => {
    it('builds the raw content URL for a collection file using the default branch/collectionsPath', () => {
      const adapter = new AwesomeCopilotAdapter(makeSource(), new FakeGitHubApi(), new FixedClock(0));
      expect(adapter.getManifestUrl('azure-cloud-development')).toBe(`${RAW_BASE}/azure-cloud-development.collection.yml`);
      expect(adapter.getDownloadUrl('azure-cloud-development')).toBe(`${RAW_BASE}/azure-cloud-development.collection.yml`);
    });

    it('respects a configured branch and collectionsPath', () => {
      const adapter = new AwesomeCopilotAdapter(
        makeSource({ config: { branch: 'dev', collectionsPath: 'my-collections' } }),
        new FakeGitHubApi(),
        new FixedClock(0)
      );
      expect(adapter.getManifestUrl('bundle-a')).toBe(
        'https://raw.githubusercontent.com/owner/repo/dev/my-collections/bundle-a.collection.yml'
      );
    });
  });

  describe('requiresAuthentication', () => {
    it('defaults to false when the source is not marked private', () => {
      const adapter = new AwesomeCopilotAdapter(makeSource(), new FakeGitHubApi(), new FixedClock(0));
      expect(adapter.requiresAuthentication()).toBe(false);
    });
  });

  describe('fetchBundles', () => {
    it('builds a bundle from a discovered .collection.yml file', async () => {
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [
          { name: 'azure-cloud-development.collection.yml', path: 'collections/azure-cloud-development.collection.yml', type: 'file' },
          { name: 'README.md', path: 'collections/README.md', type: 'file' },
          { name: 'nested', path: 'collections/nested', type: 'dir' }
        ])
        .seedText(`${RAW_BASE}/azure-cloud-development.collection.yml`, collectionYaml());

      const adapter = new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(1_700_000_000_000));
      const bundles = await adapter.fetchBundles();

      expect(bundles).toHaveLength(1);
      expect(bundles[0]).toMatchObject({
        id: 'azure-cloud-development',
        name: 'Azure & Cloud Development',
        version: '2.0.0',
        description: 'Comprehensive Azure tools',
        author: 'jdoe',
        sourceId: 'awesome-copilot-test',
        tags: ['azure', 'testing'],
        environments: ['cloud', 'testing'],
        size: '2 items',
        license: 'MIT',
        manifestUrl: `${RAW_BASE}/azure-cloud-development.collection.yml`,
        downloadUrl: `${RAW_BASE}/azure-cloud-development.collection.yml`
      });
      expect(bundles[0].lastUpdated).toBe(new Date(1_700_000_000_000).toISOString());
    });

    it('attaches a content breakdown + mcpServers to the bundle for the Marketplace content-breakdown UI', async () => {
      const yamlContent = [
        'id: a',
        'name: A',
        'description: desc',
        'items:',
        '  - path: prompts/x.prompt.md',
        '    kind: prompt',
        '  - path: agents/y.agent.md',
        '    kind: agent',
        'mcpServers:',
        '  example-server:',
        '    command: node'
      ].join('\n');
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [{ name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' }])
        .seedText(`${RAW_BASE}/a.collection.yml`, yamlContent);

      const bundles = await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).fetchBundles();

      expect((bundles[0] as unknown as { breakdown: Record<string, number> }).breakdown).toEqual({
        prompts: 1,
        instructions: 0,
        chatmodes: 0,
        agents: 1,
        skills: 0,
        mcpServers: 1
      });
      expect((bundles[0] as unknown as { mcpServers: unknown }).mcpServers).toEqual({ 'example-server': { command: 'node' } });
    });

    it('does not attach mcpServers (but still attaches a zero-count breakdown) when the collection declares none', async () => {
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [{ name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' }])
        .seedText(`${RAW_BASE}/a.collection.yml`, collectionYaml());

      const bundles = await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).fetchBundles();

      expect(bundles[0]).not.toHaveProperty('mcpServers');
      expect((bundles[0] as unknown as { breakdown: Record<string, number> }).breakdown.mcpServers).toBe(0);
    });

    it('defaults version to 1.0.0 and author to the repo owner when the collection omits them', async () => {
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [{ name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' }])
        .seedText(
          `${RAW_BASE}/a.collection.yml`,
          ['id: a', 'name: A', 'description: desc', 'items:', '  - path: prompts/x.prompt.md', '    kind: prompt'].join('\n')
        );

      const bundles = await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).fetchBundles();

      expect(bundles[0]).toMatchObject({ version: '1.0.0', author: 'owner' });
    });

    it('infers multiple environments from multiple recognized tags, deduplicated', async () => {
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [{ name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' }])
        .seedText(`${RAW_BASE}/a.collection.yml`, collectionYaml({ tags: ['azure', 'aws', 'frontend'] }));

      const bundles = await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).fetchBundles();

      expect(bundles[0].environments.toSorted()).toEqual(['cloud', 'web']);
    });

    it('falls back to ["general"] when no tag maps to a known environment', async () => {
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [{ name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' }])
        .seedText(`${RAW_BASE}/a.collection.yml`, collectionYaml({ tags: ['unrecognized-tag'] }));

      const bundles = await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).fetchBundles();

      expect(bundles[0].environments).toEqual(['general']);
    });

    it('skips a collection file that fails to parse instead of failing the whole fetch', async () => {
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [
          { name: 'good.collection.yml', path: 'collections/good.collection.yml', type: 'file' },
          { name: 'bad.collection.yml', path: 'collections/bad.collection.yml', type: 'file' }
        ])
        .seedText(`${RAW_BASE}/good.collection.yml`, collectionYaml({ id: 'good' }))
        .seedText(`${RAW_BASE}/bad.collection.yml`, 'id: [this is not: valid yaml');

      const bundles = await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).fetchBundles();

      expect(bundles.map((b) => b.id)).toEqual(['good']);
    });

    it('processes every collection across the fetch-concurrency batch boundary', async () => {
      const collectionCount = 12; // > COLLECTION_FETCH_CONCURRENCY (5)
      const api = new FakeGitHubApi();
      const entries = Array.from({ length: collectionCount }, (_, i) => {
        const name = `bundle-${i}.collection.yml`;
        api.seedText(`${RAW_BASE}/${name}`, collectionYaml({ id: `bundle-${i}` }));
        return { name, path: `collections/${name}`, type: 'file' };
      });
      api.seedJson(COLLECTIONS_LIST_PATH, entries);

      const bundles = await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).fetchBundles();

      expect(bundles).toHaveLength(collectionCount);
      expect(new Set(bundles.map((b) => b.id)).size).toBe(collectionCount);
    });

    it('caches results within the TTL and re-fetches once the TTL has elapsed', async () => {
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [{ name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' }])
        .seedText(`${RAW_BASE}/a.collection.yml`, collectionYaml());
      const recordingApi = new RecordingGitHubApi(api);
      const clock = new FixedClock(0);

      const adapter = new AwesomeCopilotAdapter(makeSource(), recordingApi, clock);
      await adapter.fetchBundles();
      await adapter.fetchBundles();
      expect(recordingApi.countOf('getJson')).toBe(1);

      clock.advance(5 * 60 * 1000 + 1);
      await adapter.fetchBundles();
      expect(recordingApi.countOf('getJson')).toBe(2);
    });

    it('clearCache forces a re-fetch on the next call even within the TTL', async () => {
      const api = new FakeGitHubApi()
        .seedJson(COLLECTIONS_LIST_PATH, [{ name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' }])
        .seedText(`${RAW_BASE}/a.collection.yml`, collectionYaml());
      const recordingApi = new RecordingGitHubApi(api);

      const adapter = new AwesomeCopilotAdapter(makeSource(), recordingApi, new FixedClock(0));
      await adapter.fetchBundles();
      expect(recordingApi.countOf('getJson')).toBe(1);

      adapter.clearCache();
      await adapter.fetchBundles();
      expect(recordingApi.countOf('getJson')).toBe(2);
    });

    it('wraps a collection-listing failure with a descriptive error', async () => {
      await expect(new AwesomeCopilotAdapter(makeSource(), new FakeGitHubApi(), new FixedClock(0)).fetchBundles()).rejects.toThrow(
        'Failed to list awesome-copilot collections'
      );
    });
  });

  describe('downloadBundle', () => {
    it('produces a real ZIP archive from a re-fetched collection', async () => {
      const api = new FakeGitHubApi()
        .seedText(`${RAW_BASE}/azure-cloud-development.collection.yml`, collectionYaml())
        .seedBytes(`${RAW_REPO_BASE}/prompts/foo.prompt.md`, new TextEncoder().encode('# foo'))
        .seedBytes(`${RAW_REPO_BASE}/instructions/bar.instructions.md`, new TextEncoder().encode('# bar'));

      const adapter = new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0));
      const zip = await adapter.downloadBundle({ downloadUrl: `${RAW_BASE}/azure-cloud-development.collection.yml` } as never);

      // ZIP local-file-header magic number: "PK\x03\x04".
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
      expect(zip.length).toBeGreaterThan(0);
    });

    it('fetches every file in a skill item\'s directory, preserving their paths', async () => {
      const skillCollectionYaml = [
        'id: skills-bundle',
        'name: Skills Bundle',
        'description: desc',
        'items:',
        '  - path: skills/my-skill/SKILL.md',
        '    kind: skill'
      ].join('\n');
      const api = new FakeGitHubApi()
        .seedText(`${RAW_BASE}/skills-bundle.collection.yml`, skillCollectionYaml)
        .seedJson('/repos/owner/repo/contents/skills/my-skill?ref=main', [
          { name: 'SKILL.md', path: 'skills/my-skill/SKILL.md', type: 'file' },
          { name: 'helper.py', path: 'skills/my-skill/helper.py', type: 'file' }
        ])
        .seedBytes(`${RAW_REPO_BASE}/skills/my-skill/SKILL.md`, new TextEncoder().encode('# skill'))
        .seedBytes(`${RAW_REPO_BASE}/skills/my-skill/helper.py`, new TextEncoder().encode('print(1)'));
      const recordingApi = new RecordingGitHubApi(api);

      const adapter = new AwesomeCopilotAdapter(makeSource(), recordingApi, new FixedClock(0));
      await adapter.downloadBundle({ downloadUrl: `${RAW_BASE}/skills-bundle.collection.yml` } as never);

      const downloadedPaths = recordingApi.calls.filter((call) => call.method === 'download').map((call) => call.pathOrUrl);
      expect(downloadedPaths).toEqual(
        expect.arrayContaining([`${RAW_REPO_BASE}/skills/my-skill/SKILL.md`, `${RAW_REPO_BASE}/skills/my-skill/helper.py`])
      );
    });

    it('wraps a failure with a descriptive error', async () => {
      const adapter = new AwesomeCopilotAdapter(makeSource(), new FakeGitHubApi(), new FixedClock(0));
      await expect(adapter.downloadBundle({ downloadUrl: `${RAW_BASE}/missing.collection.yml` } as never)).rejects.toThrow(
        'Failed to download bundle'
      );
    });
  });

  describe('fetchMetadata', () => {
    it('reports the repo name and collection count', async () => {
      const api = new FakeGitHubApi().seedJson(COLLECTIONS_LIST_PATH, [
        { name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' },
        { name: 'b.collection.yml', path: 'collections/b.collection.yml', type: 'file' }
      ]);
      const metadata = await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(1_700_000_000_000)).fetchMetadata();

      expect(metadata).toEqual({
        name: 'owner/repo',
        description: 'Awesome Copilot collections from https://github.com/owner/repo',
        bundleCount: 2,
        lastUpdated: new Date(1_700_000_000_000).toISOString(),
        version: '1.0.0'
      });
    });

    it('wraps a failure with a descriptive error', async () => {
      await expect(new AwesomeCopilotAdapter(makeSource(), new FakeGitHubApi(), new FixedClock(0)).fetchMetadata()).rejects.toThrow(
        'Failed to fetch metadata'
      );
    });
  });

  describe('validate', () => {
    it('is valid when at least one collection file is found', async () => {
      const api = new FakeGitHubApi().seedJson(COLLECTIONS_LIST_PATH, [
        { name: 'a.collection.yml', path: 'collections/a.collection.yml', type: 'file' }
      ]);
      expect(await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).validate()).toEqual({
        valid: true,
        errors: [],
        warnings: [],
        bundlesFound: 1
      });
    });

    it('is invalid when no collection files are found', async () => {
      const api = new FakeGitHubApi().seedJson(COLLECTIONS_LIST_PATH, []);
      expect(await new AwesomeCopilotAdapter(makeSource(), api, new FixedClock(0)).validate()).toEqual({
        valid: false,
        errors: ['No .collection.yml files found in collections directory'],
        warnings: [],
        bundlesFound: 0
      });
    });

    it('is invalid when the collections directory cannot be reached', async () => {
      const result = await new AwesomeCopilotAdapter(makeSource(), new FakeGitHubApi(), new FixedClock(0)).validate();
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Failed to validate repository');
    });
  });
});
