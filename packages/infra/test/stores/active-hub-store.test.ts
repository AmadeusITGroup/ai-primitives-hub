/**
 * Tests for infra/stores/active-hub-store.ts.
 */
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ActiveHubStore,
} from '../../src/stores/active-hub-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

describe('ActiveHubStore', () => {
  let fs: InMemoryFileSystem;
  let store: ActiveHubStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = new ActiveHubStore('/hubs/active-hub.json', fs);
  });

  it('returns null when nothing has been set', async () => {
    expect(await store.get()).toBeNull();
  });

  it('persists and retrieves the active hub id', async () => {
    await store.set('my-hub');
    expect(await store.get()).toBe('my-hub');
  });

  it('updates the active hub id when set again', async () => {
    await store.set('hub-1');
    await store.set('hub-2');
    expect(await store.get()).toBe('hub-2');
  });

  it('clears the active hub id when set to null', async () => {
    await store.set('my-hub');
    await store.set(null);
    expect(await store.get()).toBeNull();
  });

  it('is a no-op to clear when nothing was set', async () => {
    await expect(store.set(null)).resolves.toBeUndefined();
    expect(await store.get()).toBeNull();
  });

  it('returns null (rather than throwing) on a corrupted pointer file', async () => {
    fs.seed('/hubs/active-hub.json', 'not valid json');
    expect(await store.get()).toBeNull();
  });

  it('records a setAt timestamp', async () => {
    const before = new Date();
    await store.set('my-hub');
    const raw = await fs.readJson<{ hubId: string; setAt: string }>('/hubs/active-hub.json');
    expect(raw.hubId).toBe('my-hub');
    expect(new Date(raw.setAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
