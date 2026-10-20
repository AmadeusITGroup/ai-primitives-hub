import type {
  RegistrySource,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';
import {
  GitHubReleaseLookup,
} from '../../src/governance/github-release-lookup';
import {
  HubSourceCollectionIndex,
} from '../../src/governance/hub-source-collection-index';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';

afterEach(() => vi.useRealTimers());

it('reads collection sources through a bounded worker pool with stable evidence ordering', async () => {
  vi.useFakeTimers();
  const sources: RegistrySource[] = Array.from({ length: 9 }, (_, index) => ({
    id: `source-${index}`, name: 'Source', type: 'github', url: `https://github.com/owner/repo-${index}`, enabled: true, priority: 0
  }));
  let active = 0;
  let peak = 0;
  const listCollections = vi.fn(async (_repository: string, sourceId: string) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    active--;
    return { collections: [{ id: 'shared', sourceId }], unverifiedSources: [] };
  });
  const pending = new HubSourceCollectionIndex(sources, vi.fn(), { listCollections }, undefined, { concurrency: 4 }).read();
  await vi.advanceTimersByTimeAsync(300);
  expect(listCollections).toHaveBeenCalledTimes(9);
  expect(peak).toBe(4);
  expect((await pending).collections.map((collection) => collection.sourceId)).toEqual(sources.map((source) => source.id));
});

it('reads all release manifests in bounded parallel batches, retaining unreadable evidence', async () => {
  vi.useFakeTimers();
  const api = new FakeGitHubApi().seedJson('/repos/owner/repo/releases?per_page=100&page=1',
    Array.from({ length: 21 }, (_, index) => ({ tag_name: `v${index}`, draft: false, prerelease: false,
      published_at: '2026-01-01T00:00:00Z', assets: [
        { name: 'deployment-manifest.yml', url: `https://api.github.com/repos/owner/repo/releases/assets/${index + 1}` },
        { name: 'bundle.zip', url: 'https://api.github.com/repos/owner/repo/releases/assets/100' }
      ] })));
  let active = 0;
  let peak = 0;
  const getText = vi.spyOn(api, 'getText').mockImplementation(async (url) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    active--;
    if (url.endsWith('/21')) {
      throw new Error('Unreadable last manifest');
    }
    return 'id: shared\nversion: 1.0.0\n';
  });
  const pending = new GitHubReleaseLookup(() => api).listCollections('https://github.com/owner/repo', 'selected');
  await vi.advanceTimersByTimeAsync(300);
  expect(getText).toHaveBeenCalledTimes(21);
  expect(peak).toBe(10);
  const inventory = await pending;
  expect(inventory.collections).toEqual([{ id: 'shared', sourceId: 'selected', repository: 'https://github.com/owner/repo' }]);
  expect(inventory.unverifiedSources).toHaveLength(1);
});

it('reports sources still unread at the deadline as unverified instead of hanging', async () => {
  vi.useFakeTimers();
  const sources: RegistrySource[] = ['fast', 'slow'].map((id) => ({
    id, name: 'Source', type: 'github', url: `https://github.com/owner/${id}`, enabled: true, priority: 0
  }));
  const listCollections = vi.fn(async (_repository: string, sourceId: string) => {
    await new Promise((resolve) => setTimeout(resolve, sourceId === 'slow' ? 10_000 : 10));
    return { collections: [{ id: sourceId, sourceId }], unverifiedSources: [] };
  });
  const pending = new HubSourceCollectionIndex(sources, vi.fn(), { listCollections }, undefined, { deadlineMs: 1000 }).read();
  await vi.advanceTimersByTimeAsync(1000);
  const inventory = await pending;
  expect(inventory.collections.map((c) => c.sourceId)).toEqual(['fast']);
  expect(inventory.unverifiedSources).toEqual([expect.objectContaining({ sourceId: 'slow', message: expect.stringContaining('time limit'), hint: expect.any(String) })]);
});

it('reads context sources ids-only and changed sources in full', async () => {
  const sources: RegistrySource[] = ['changed', 'context'].map((id) => ({
    id, name: 'Source', type: 'github', url: `https://github.com/owner/${id}`, enabled: true, priority: 0
  }));
  const listCollections = vi.fn(async (_repository: string, sourceId: string) => ({ collections: [{ id: 'x', sourceId }], unverifiedSources: [] }));
  await new HubSourceCollectionIndex(sources, vi.fn(), { listCollections }, undefined, { fullSourceIds: new Set(['changed']) }).read();
  expect(listCollections).toHaveBeenCalledWith('https://github.com/owner/changed', 'changed', { idsOnly: false });
  expect(listCollections).toHaveBeenCalledWith('https://github.com/owner/context', 'context', { idsOnly: true });
});

it('opens only the newest release per tag family in ids-only mode', async () => {
  const release = (tag: string, asset: number) => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [
    { name: 'deployment-manifest.yml', url: `https://api.github.com/repos/owner/repo/releases/assets/${asset}` },
    { name: 'bundle.zip', url: 'https://api.github.com/repos/owner/repo/releases/assets/100' }
  ] });
  const api = new FakeGitHubApi().seedJson('/repos/owner/repo/releases?per_page=100&page=1', [
    release('alpha-v2.0.0', 1), release('alpha-v1.0.0', 2), release('beta-v1.0.0', 3), release('custom', 4)
  ]);
  const getText = vi.spyOn(api, 'getText').mockImplementation(async (url) => {
    const id = { 1: 'alpha', 2: 'alpha', 3: 'beta', 4: 'gamma' }[Number(url.split('/').pop())];
    return `id: ${id}\nversion: 1.0.0\n`;
  });
  const inventory = await new GitHubReleaseLookup(() => api).listCollections('https://github.com/owner/repo', 'context', { idsOnly: true });
  expect(getText.mock.calls.map(([url]) => url.split('/').pop())).toEqual(['1', '3', '4']);
  expect(inventory.collections.map((c) => c.id).toSorted()).toEqual(['alpha', 'beta', 'gamma']);
});

it('explains a renamed repository and tells which url to use', async () => {
  const api = new FakeGitHubApi().seedJson('/repos/owner/old/releases?per_page=100&page=1', [{
    tag_name: 'c-v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [
      { name: 'deployment-manifest.yml', url: 'https://api.github.com/repos/owner/new/releases/assets/1' },
      { name: 'bundle.zip', url: 'https://api.github.com/repos/owner/new/releases/assets/2' }
    ] }]);
  const inventory = await new GitHubReleaseLookup(() => api).listCollections('https://github.com/owner/old', 'renamed');
  expect(inventory.unverifiedSources).toEqual([{
    sourceId: 'renamed',
    message: expect.stringContaining("belong to repository 'owner/new', not 'owner/old'"),
    hint: 'Update this source\'s url in hub-config.yml to https://github.com/owner/new.'
  }]);
});
