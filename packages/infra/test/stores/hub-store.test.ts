/**
 * Tests for infra/stores/hub-store.ts.
 */
import type {
  HubConfig,
  HubReference,
} from '@ai-primitives-hub/core';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  HubStore,
} from '../../src/stores/hub-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

function makeConfig(name = 'Test Hub'): HubConfig {
  return {
    version: '1.0.0',
    metadata: { name, description: 'd', maintainer: 'm', updatedAt: '2024-01-01T00:00:00.000Z' },
    sources: [],
    profiles: []
  };
}

const REF: HubReference = { type: 'github', location: 'owner/repo', ref: 'main' };

describe('HubStore', () => {
  let fs: InMemoryFileSystem;
  let store: HubStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = new HubStore('/hubs', fs);
  });

  it('saves and loads a hub by id', async () => {
    await store.save('my-hub', makeConfig(), REF);
    const loaded = await store.load('my-hub');
    expect(loaded.config.metadata.name).toBe('Test Hub');
    expect(loaded.reference).toEqual(REF);
  });

  it('rejects an invalid hub id on save', async () => {
    await expect(store.save('../bad', makeConfig(), REF)).rejects.toThrow(/Invalid hub ID/);
  });

  it('throws "Hub not found" when loading a missing hub', async () => {
    await expect(store.load('missing')).rejects.toThrow('Hub not found: missing');
  });

  it('falls back to a local reference when the sidecar is missing', async () => {
    fs.seed('/hubs/no-meta.yml', 'version: "1.0.0"\nmetadata:\n  name: x\n  description: d\n  maintainer: m\n  updatedAt: "2024-01-01T00:00:00.000Z"\nsources: []\nprofiles: []\n');
    const loaded = await store.load('no-meta');
    expect(loaded.reference).toEqual({ type: 'local', location: '/hubs/no-meta.yml' });
  });

  it('overwrites an existing hub on save', async () => {
    await store.save('my-hub', makeConfig('First'), REF);
    await store.save('my-hub', makeConfig('Second'), REF);
    const loaded = await store.load('my-hub');
    expect(loaded.config.metadata.name).toBe('Second');
  });

  it('lists saved hub ids', async () => {
    await store.save('hub-1', makeConfig(), REF);
    await store.save('hub-2', makeConfig(), REF);
    const ids = await store.list();
    expect(ids.toSorted()).toEqual(['hub-1', 'hub-2']);
  });

  it('returns an empty list when nothing has been saved', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('reports has() correctly', async () => {
    await store.save('my-hub', makeConfig(), REF);
    expect(await store.has('my-hub')).toBe(true);
    expect(await store.has('missing')).toBe(false);
  });

  it('has() returns false rather than throwing for an invalid id', async () => {
    expect(await store.has('../bad')).toBe(false);
  });

  it('removes a hub and its sidecar', async () => {
    await store.save('my-hub', makeConfig(), REF);
    await store.remove('my-hub');
    expect(await store.has('my-hub')).toBe(false);
    await expect(store.load('my-hub')).rejects.toThrow('Hub not found');
  });

  it('throws "Hub not found" when removing a missing hub', async () => {
    await expect(store.remove('missing')).rejects.toThrow('Hub not found: missing');
  });

  it('cleans up profile-activation state files for the removed hub', async () => {
    await store.save('my-hub', makeConfig(), REF);
    fs.seed('/hubs/profile-activations/my-hub_profile-1.json', '{}');
    fs.seed('/hubs/profile-activations/other-hub_profile-1.json', '{}');

    await store.remove('my-hub');

    expect(await fs.exists('/hubs/profile-activations/my-hub_profile-1.json')).toBe(false);
    expect(await fs.exists('/hubs/profile-activations/other-hub_profile-1.json')).toBe(true);
  });

  it('gets sidecar metadata without loading the full config', async () => {
    await store.save('my-hub', makeConfig(), REF);
    const meta = await store.getMetadata('my-hub');
    expect(meta.reference).toEqual(REF);
    expect(meta.size).toBeGreaterThan(0);
    expect(meta.lastModified).toBeTruthy();
  });

  it('throws "Hub not found" when getting metadata for a missing hub', async () => {
    await expect(store.getMetadata('missing')).rejects.toThrow('Hub not found: missing');
  });
});
