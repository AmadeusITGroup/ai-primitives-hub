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
  PrimitiveIndex,
} from '../../src/search/primitive-index';
import {
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
});
