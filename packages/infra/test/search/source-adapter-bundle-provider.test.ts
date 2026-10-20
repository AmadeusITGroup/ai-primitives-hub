import type {
  Bundle,
  BundleExtractor,
  ExtractedFiles,
  SourceAdapter,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  SourceAdapterBundleProvider,
} from '../../src/harvest/bundle-providers/source-adapter-bundle-provider';

const source = {
  id: 'source-1',
  name: 'Source 1',
  type: 'local',
  url: 'file:///source-1',
  enabled: true,
  priority: 1
} as const;

const bundle: Bundle = {
  id: 'bundle-1',
  name: 'Bundle 1',
  version: '1.0.0',
  description: '',
  author: 'test',
  sourceId: source.id,
  environments: [],
  tags: [],
  lastUpdated: '2026-01-01T00:00:00Z',
  size: '1 KB',
  dependencies: [],
  license: 'MIT',
  manifestUrl: '',
  downloadUrl: ''
};

function createAdapter(): SourceAdapter {
  return {
    source,
    type: source.type,
    fetchBundles: async () => [bundle],
    downloadBundle: async () => Buffer.from('bundle-archive'),
    fetchMetadata: async () => ({ name: source.name, description: '', bundleCount: 1, lastUpdated: '', version: '1' }),
    validate: async () => ({ valid: true, errors: [], warnings: [] }),
    requiresAuthentication: () => false,
    getManifestUrl: () => '',
    getDownloadUrl: () => '',
    downloadReadme: async () => null
  };
}

function createExtractor(): BundleExtractor {
  const files: ExtractedFiles = new Map([
    ['deployment-manifest.yml', new TextEncoder().encode('id: bundle-1\nversion: 1.0.0\nname: Bundle 1\n')],
    ['prompts/hello.prompt.md', new TextEncoder().encode('# Hello')]
  ]);
  return {
    extract: async () => files
  };
}

describe('SourceAdapterBundleProvider', () => {
  it('translates source bundles into refs and reads archive files', async () => {
    const provider = new SourceAdapterBundleProvider({
      adapter: createAdapter(),
      extractor: createExtractor()
    });

    const refs = [];
    for await (const ref of provider.listBundles()) {
      refs.push(ref);
    }

    expect(refs).toEqual([{
      sourceId: 'source-1',
      sourceType: 'local',
      bundleId: 'bundle-1',
      bundleVersion: '1.0.0',
      installed: false
    }]);
    await expect(provider.readManifest(refs[0])).resolves.toMatchObject({ id: 'bundle-1', version: '1.0.0' });
    await expect(provider.readFile(refs[0], 'prompts/hello.prompt.md')).resolves.toBe('# Hello');
  });

  it('supports archives with a single wrapper directory', async () => {
    const files: ExtractedFiles = new Map([
      ['bundle-1/deployment-manifest.yml', new TextEncoder().encode('id: bundle-1\nversion: 1.0.0\n')],
      ['bundle-1/prompt.md', new TextEncoder().encode('content')]
    ]);
    const provider = new SourceAdapterBundleProvider({
      adapter: createAdapter(),
      extractor: { extract: async () => files }
    });
    const refs = [];
    for await (const item of provider.listBundles()) {
      refs.push(item);
    }

    await expect(provider.readFile(refs[0], 'prompt.md')).resolves.toBe('content');
  });

  it('projects installation state onto bundle refs', async () => {
    const provider = new SourceAdapterBundleProvider({
      adapter: createAdapter(),
      extractor: createExtractor(),
      isInstalled: (candidate) => candidate.id === 'bundle-1'
    });

    await expect(collect(provider.listBundles())).resolves.toEqual([expect.objectContaining({ installed: true })]);
  });

  it('rejects unsafe requested paths', async () => {
    const provider = new SourceAdapterBundleProvider({
      adapter: createAdapter(),
      extractor: createExtractor()
    });
    const [ref] = await collect(provider.listBundles());

    await expect(provider.readFile(ref, '../secrets')).rejects.toThrow(/unsafe bundle path/);
  });

  it('consolidates multiple versions of the same bundle and harvests only the latest version', async () => {
    const downloadedVersions: string[] = [];
    const multiVersionAdapter: SourceAdapter = {
      ...createAdapter(),
      fetchBundles: async () => [
        // Returned in descending order (newest first, oldest last) like ArtifactorySourceAdapter
        { ...bundle, id: 'bundle-1', version: '1.2.0' },
        { ...bundle, id: 'bundle-1', version: '1.1.0' },
        { ...bundle, id: 'bundle-1', version: '1.0.0' },
        // Returned in ascending order for a second bundle
        { ...bundle, id: 'bundle-2', version: '0.1.0' },
        { ...bundle, id: 'bundle-2', version: '0.2.0' }
      ],
      downloadBundle: async (candidate) => {
        downloadedVersions.push(`${candidate.id}@${candidate.version}`);
        return Buffer.from(`archive-${candidate.id}@${candidate.version}`);
      }
    };
    const provider = new SourceAdapterBundleProvider({
      adapter: multiVersionAdapter,
      extractor: {
        extract: async (bytes) => {
          const tag = new TextDecoder().decode(bytes);
          return new Map([
            ['deployment-manifest.yml', new TextEncoder().encode(`id: test\nversion: 1.0.0\n`)],
            ['prompts/hello.prompt.md', new TextEncoder().encode(`# ${tag}`)]
          ]);
        }
      }
    });

    const refs = await collect(provider.listBundles());

    expect(refs).toEqual([
      {
        sourceId: 'source-1',
        sourceType: 'local',
        bundleId: 'bundle-1',
        bundleVersion: '1.2.0',
        installed: false
      },
      {
        sourceId: 'source-1',
        sourceType: 'local',
        bundleId: 'bundle-2',
        bundleVersion: '0.2.0',
        installed: false
      }
    ]);

    const content1 = await provider.readFile(refs[0], 'prompts/hello.prompt.md');
    const content2 = await provider.readFile(refs[1], 'prompts/hello.prompt.md');
    expect(content1).toBe('# archive-bundle-1@1.2.0');
    expect(content2).toBe('# archive-bundle-2@0.2.0');
    expect(downloadedVersions).toEqual(['bundle-1@1.2.0', 'bundle-2@0.2.0']);
  });

  it('falls back to lastUpdated when versions cannot be compared semantically (including commit SHAs)', async () => {
    const nonSemverAdapter: SourceAdapter = {
      ...createAdapter(),
      fetchBundles: async () => [
        { ...bundle, id: 'bundle-1', version: '9f8e1a2b', lastUpdated: '2026-01-01T00:00:00Z' },
        { ...bundle, id: 'bundle-1', version: '1a2b3c4d', lastUpdated: '2026-02-01T00:00:00Z' }
      ],
      downloadBundle: async (candidate) => Buffer.from(`archive-${candidate.lastUpdated}`)
    };
    const provider = new SourceAdapterBundleProvider({
      adapter: nonSemverAdapter,
      extractor: {
        extract: async (bytes) => new Map([
          ['deployment-manifest.yml', new TextEncoder().encode('id: bundle-1\nversion: 1.0.0\n')],
          ['prompts/hello.prompt.md', bytes]
        ])
      }
    });

    const refs = await collect(provider.listBundles());
    expect(refs).toHaveLength(1);
    await expect(provider.readFile(refs[0], 'prompts/hello.prompt.md')).resolves.toBe('archive-2026-02-01T00:00:00Z');
  });
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) {
    result.push(item);
  }
  return result;
}
