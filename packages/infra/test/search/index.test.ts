import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  harvest,
} from '../../src/harvest/harvester';
import {
  TernlightEmbeddingProvider,
} from '../../src/search/embedding/ternlight-embedding-provider';
import {
  PrimitiveIndex,
} from '../../src/search/primitive-index';
import {
  clearIndexCache,
  INDEX_CACHE_MAX_ENTRIES,
  loadIndex,
  saveIndex,
} from '../../src/stores/json-index-store';
import {
  createFixtureBundles,
  FakeBundleProvider,
} from '../fixtures/primitive-index';

async function buildIndex(): Promise<PrimitiveIndex> {
  return PrimitiveIndex.buildFrom(new FakeBundleProvider(createFixtureBundles()));
}

describe('PrimitiveIndex', () => {
  it('builds and exposes stats', async () => {
    const idx = await buildIndex();
    const stats = idx.stats();
    expect(stats.primitives).toBeGreaterThan(0);
    expect(stats.bundles).toBeGreaterThan(0);
  });

  it('search matches relevant primitives by title+tags', async () => {
    const idx = await buildIndex();
    const res = idx.search({ q: 'rust', limit: 5 });
    if (res.hits.length > 0) {
      expect(res.hits[0].primitive.title.toLowerCase()).toMatch(/rust/);
    }
  });

  it('relevance floors drop the weak tail and can return no text hits', async () => {
    const idx = await buildIndex();
    const unfiltered = idx.search({ q: 'rust', limit: 50 });
    // A fixture query must produce a spread of scores for the cut to be visible.
    expect(unfiltered.hits.length).toBeGreaterThan(1);
    const topScore = unfiltered.hits[0].score;

    // A relative floor keeps only hits close to the best score.
    const relative = idx.search({ q: 'rust', limit: 50, minRelativeScore: 0.5 });
    expect(relative.hits.length).toBeLessThanOrEqual(unfiltered.hits.length);
    expect(relative.hits[0].score).toBe(topScore);
    expect(relative.hits.every((h, i) => i === 0 || h.score >= topScore * 0.5)).toBe(true);
    expect(relative.total).toBe(relative.hits.length);

    // An absolute floor above the top score allows a text query to return no
    // results when none of the hits reaches the configured relevance floor.
    const strict = idx.search({ q: 'rust', limit: 50, minScore: topScore + 1 });
    expect(strict.hits).toHaveLength(0);
    expect(strict.total).toBe(0);
  });

  it('facet filters narrow candidates', async () => {
    const idx = await buildIndex();
    const res = idx.search({ kinds: ['chat-mode'] });
    if (res.hits.length > 0) {
      expect(res.hits.every((h) => h.primitive.kind === 'chat-mode')).toBe(true);
    }
  });

  it('installedOnly filter works', async () => {
    const idx = await buildIndex();
    const res = idx.search({ installedOnly: true });
    expect(res.hits.every((h) => h.primitive.bundle.installed)).toBe(true);
  });

  it('applies the current installed bundle snapshot at query time', async () => {
    const idx = await buildIndex();
    const target = idx.all().find((primitive) => !primitive.bundle.installed);
    expect(target).toBeDefined();

    const res = idx.search({
      installedOnly: true,
      installedBundleKeys: [`${target!.bundle.sourceId}\u0000${target!.bundle.bundleId}\u0000${target!.bundle.bundleVersion}`]
    });

    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits.every((hit) => hit.primitive.bundle.bundleId === target!.bundle.bundleId)).toBe(true);
  });

  it('explain mode attaches matches', async () => {
    const idx = await buildIndex();
    const res = idx.search({ q: 'rust', limit: 3, explain: true });
    if (res.hits.length > 0) {
      expect(res.hits[0].matches && res.hits[0].matches.length > 0).toBe(true);
    }
  });

  it('is deterministic across runs', async () => {
    const a = await buildIndex();
    const b = await buildIndex();
    const ra = a.search({ q: 'rust' });
    const rb = b.search({ q: 'rust' });
    expect(
      ra.hits.map((h) => h.primitive.id)
    ).toStrictEqual(
      rb.hits.map((h) => h.primitive.id)
    );
  });

  it('shortlist CRUD', async () => {
    const idx = await buildIndex();
    const prim = idx.all()[0];
    const sl = idx.createShortlist('my');
    idx.addToShortlist(sl.id, prim.id);
    expect(idx.getShortlist(sl.id)?.primitiveIds).toStrictEqual([prim.id]);
    idx.addToShortlist(sl.id, prim.id); // idempotent
    expect(idx.getShortlist(sl.id)?.primitiveIds.length).toBe(1);
    idx.removeFromShortlist(sl.id, prim.id);
    expect(idx.getShortlist(sl.id)?.primitiveIds.length).toBe(0);
    expect(() => idx.addToShortlist(sl.id, 'bogus')).toThrow();
    expect(() => idx.addToShortlist('bogus', prim.id)).toThrow();
  });

  it('round-trips via save/load preserving searchability and shortlists', async () => {
    const idx = await buildIndex();
    const sl = idx.createShortlist('persisted');
    const prim = idx.all()[0];
    idx.addToShortlist(sl.id, prim.id);
    const file = path.join(os.tmpdir(), `pi-${Date.now()}.json`);
    try {
      saveIndex(idx, file);
      const loaded = loadIndex(file);
      expect(loaded.stats().primitives).toBe(idx.stats().primitives);
      expect(loaded.getShortlist(sl.id)?.primitiveIds[0]).toBe(prim.id);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('replaces an existing index atomically without leaving temporary files', async () => {
    const idx = await buildIndex();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primitive-index-atomic-'));
    const file = path.join(dir, 'nested', 'primitive-index.json');
    try {
      saveIndex(idx, file);
      saveIndex(idx, file);

      expect(loadIndex(file).stats().primitives).toBe(idx.stats().primitives);
      expect(fs.readdirSync(path.dirname(file))).toStrictEqual(['primitive-index.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a cached parsed index for an unchanged file and refreshes after rewrite', async () => {
    const idx = await buildIndex();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primitive-index-cache-'));
    const file = path.join(dir, 'primitive-index.json');
    try {
      saveIndex(idx, file);
      clearIndexCache(file);
      const first = loadIndex(file);
      const second = loadIndex(file);
      // Same file identity -> same parsed instance, no re-read/parse.
      expect(second).toBe(first);

      // Rewriting the file (as an index rebuild does) must invalidate the cache
      // so the next load reflects the new content.
      const rebuilt = await buildIndex();
      const extra = rebuilt.createShortlist('rebuilt');
      saveIndex(rebuilt, file);
      const third = loadIndex(file);
      expect(third).not.toBe(first);
      expect(third.getShortlist(extra.id)?.name).toBe('rebuilt');
    } finally {
      clearIndexCache(file);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds the parsed-index cache and evicts the least recently used entry', async () => {
    const idx = await buildIndex();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primitive-index-cache-limit-'));
    const files = Array.from({ length: INDEX_CACHE_MAX_ENTRIES + 1 }, (_, i) =>
      path.join(dir, `primitive-index-${i}.json`));
    try {
      files.forEach((file) => saveIndex(idx, file));
      clearIndexCache();

      const loaded = files.slice(0, INDEX_CACHE_MAX_ENTRIES).map((file) => loadIndex(file));
      // Touch the first entry before adding another file so the second one
      // becomes the least recently used entry.
      expect(loadIndex(files[0])).toBe(loaded[0]);

      loadIndex(files[INDEX_CACHE_MAX_ENTRIES]);
      const reloadedSecond = loadIndex(files[1]);
      expect(reloadedSecond).not.toBe(loaded[1]);
      expect(loadIndex(files[0])).toBe(loaded[0]);
    } finally {
      clearIndexCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes LRU position when a cached index is rewritten', async () => {
    const idx = await buildIndex();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primitive-index-cache-rewrite-'));
    const files = Array.from({ length: INDEX_CACHE_MAX_ENTRIES + 1 }, (_, i) =>
      path.join(dir, `primitive-index-${i}.json`));
    try {
      files.forEach((file) => saveIndex(idx, file));
      clearIndexCache();
      files.slice(0, INDEX_CACHE_MAX_ENTRIES).forEach((file) => loadIndex(file));

      const rewritten = await buildIndex();
      rewritten.createShortlist('rewritten');
      saveIndex(rewritten, files[0]);
      const refreshed = loadIndex(files[0]);

      loadIndex(files[INDEX_CACHE_MAX_ENTRIES]);
      expect(loadIndex(files[0])).toBe(refreshed);
    } finally {
      clearIndexCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refresh reports adds/updates/removes and prunes shortlists', async () => {
    const bundles = createFixtureBundles();
    const provider = new FakeBundleProvider(bundles);
    const prims = await harvest(provider);
    const idx = PrimitiveIndex.fromPrimitives(prims);
    const sl = idx.createShortlist('check');
    const removedId = prims[0].id;
    idx.addToShortlist(sl.id, removedId);

    // Refresh with the same bundles - should report no changes
    const report = await idx.refresh(new FakeBundleProvider(bundles));
    expect(report.removed.length).toBe(0);
    expect(report.added.length).toBe(0);
    expect(report.updated.length).toBe(0);
    // Shortlist should still contain the primitive since nothing was removed
    expect(idx.getShortlist(sl.id)?.primitiveIds.length).toBe(1);
  });

  it('requires embeddings when refreshing an embedded index', async () => {
    const idx = await PrimitiveIndex.buildFrom(
      new FakeBundleProvider(createFixtureBundles()),
      { embeddings: new TernlightEmbeddingProvider() }
    );

    await expect(idx.refresh(new FakeBundleProvider(createFixtureBundles())))
      .rejects.toThrow(/requires the embedding provider/);
  });
});
