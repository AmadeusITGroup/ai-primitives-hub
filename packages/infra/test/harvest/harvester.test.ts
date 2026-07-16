import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  harvest,
} from '../../src/harvest/harvester';
import {
  createFixtureBundles,
  FakeBundleProvider,
} from '../fixtures/primitive-index';

describe('harvester', () => {
  it('produces primitives for all bundles and includes MCP servers', async () => {
    const provider = new FakeBundleProvider(createFixtureBundles());
    const prims = await harvest(provider);
    const byKind = prims.reduce<Record<string, number>>((acc, p) => {
      acc[p.kind] = (acc[p.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(prims.length).toBeGreaterThan(0);
    expect(Object.keys(byKind).length).toBeGreaterThan(0);
  });

  it('isolates errors per bundle via onError hook', async () => {
    const bundles = createFixtureBundles();
    // Remove first bundle to simulate an error scenario
    const bundlesWithoutFirst = bundles.slice(1);
    const errors: unknown[] = [];
    const provider = new FakeBundleProvider(bundlesWithoutFirst);
    const prims = await harvest(provider, { onError: (_, e) => errors.push(e) });
    expect(prims.length).toBeGreaterThan(0);
  });

  it('yields stable primitive ids (deterministic)', async () => {
    const provider = new FakeBundleProvider(createFixtureBundles());
    const a = await harvest(provider);
    const b = await harvest(new FakeBundleProvider(createFixtureBundles()));
    const idsA = a.map((p) => p.id).toSorted();
    const idsB = b.map((p) => p.id).toSorted();
    expect(idsA).toStrictEqual(idsB);
  });
});
