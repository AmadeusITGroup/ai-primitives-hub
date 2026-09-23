import type {
  Bundle,
  SourceAdapter,
} from '@ai-primitives-hub/core';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  hydrateSourceReadmes,
  README_DOWNLOAD_CONCURRENCY,
  reuseCachedSourceReadmes,
} from '../../src/registry';

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-1',
    name: 'Bundle One',
    version: '1.0.0',
    description: 'A test bundle',
    author: 'author',
    sourceId: 'source-1',
    environments: ['vscode'],
    tags: [],
    lastUpdated: '2026-01-01T00:00:00.000Z',
    size: '1 KB',
    dependencies: [],
    license: 'MIT',
    manifestUrl: 'https://example.test/manifest',
    downloadUrl: 'https://example.test/bundle.zip',
    readmeUrl: 'https://example.test/README.md',
    readmeRevision: 'revision-1',
    ...overrides
  };
}

function makeAdapter(downloadReadme: SourceAdapter['downloadReadme']): SourceAdapter {
  return { downloadReadme } as SourceAdapter;
}

describe('README source hydration', () => {
  it('reuses cached README content only when revisions match', () => {
    const matching = makeBundle();
    const changed = makeBundle({ id: 'bundle-2', readmeRevision: 'revision-2' });
    reuseCachedSourceReadmes([matching, changed], [
      makeBundle({ readme: '# Cached' }),
      makeBundle({ id: 'bundle-2', readme: '# Stale', readmeRevision: 'revision-1' })
    ]);

    expect(matching.readme).toBe('# Cached');
    expect(changed.readme).toBeUndefined();
  });

  it('hydrates missing READMEs, caches the enriched bundles, and reports progress', async () => {
    const bundles = [makeBundle(), makeBundle({ id: 'bundle-2' })];
    const cacheSourceBundles = vi.fn().mockResolvedValue(undefined);
    const onReadmesDownloaded = vi.fn();
    const onReadmesComplete = vi.fn();
    await hydrateSourceReadmes('source-1', bundles, makeAdapter(async (bundle) => `# ${bundle.id}`), {
      cacheSourceBundles,
      onReadmesDownloaded,
      onReadmesComplete
    });

    expect(bundles.map((bundle) => bundle.readme)).toEqual(['# bundle-1', '# bundle-2']);
    expect(cacheSourceBundles).toHaveBeenCalledWith('source-1', bundles);
    expect(onReadmesDownloaded).toHaveBeenCalledWith({ sourceId: 'source-1', bundleIds: ['bundle-1', 'bundle-2'] });
    expect(onReadmesComplete).toHaveBeenCalledWith({ sourceId: 'source-1', succeeded: ['bundle-1', 'bundle-2'], failed: [] });
  });

  it('continues after failed README downloads', async () => {
    const bundles = [makeBundle(), makeBundle({ id: 'bundle-2' })];
    const onReadmesComplete = vi.fn();
    await hydrateSourceReadmes('source-1', bundles, makeAdapter(async (bundle) => {
      if (bundle.id === 'bundle-2') {
        throw new Error('network failure');
      }
      return '# Available';
    }), {
      cacheSourceBundles: vi.fn().mockResolvedValue(undefined),
      onReadmesComplete
    });

    expect(bundles[0].readme).toBe('# Available');
    expect(bundles[1].readme).toBeUndefined();
    expect(onReadmesComplete).toHaveBeenCalledWith({ sourceId: 'source-1', succeeded: ['bundle-1'], failed: ['bundle-2'] });
  });

  it('limits each download batch to the configured concurrency', async () => {
    const bundles = Array.from({ length: README_DOWNLOAD_CONCURRENCY + 1 }, (_, index) => makeBundle({ id: `bundle-${index}` }));
    let active = 0;
    let maximumActive = 0;
    const pending: (() => void)[] = [];
    const downloadReadme = vi.fn(() => new Promise<string>((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      pending.push(() => {
        active -= 1;
        resolve('# README');
      });
    }));

    const hydration = hydrateSourceReadmes('source-1', bundles, makeAdapter(downloadReadme), {
      cacheSourceBundles: vi.fn().mockResolvedValue(undefined)
    });
    await vi.waitFor(() => expect(pending).toHaveLength(README_DOWNLOAD_CONCURRENCY));
    pending.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.splice(0).forEach((resolve) => resolve());
    await hydration;

    expect(maximumActive).toBe(README_DOWNLOAD_CONCURRENCY);
  });
});
