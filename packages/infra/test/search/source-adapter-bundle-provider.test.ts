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
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) {
    result.push(item);
  }
  return result;
}
