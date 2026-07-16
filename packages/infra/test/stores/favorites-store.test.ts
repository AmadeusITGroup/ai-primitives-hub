/**
 * Tests for infra/stores/favorites-store.ts.
 */
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  FavoritesStore,
} from '../../src/stores/favorites-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

describe('FavoritesStore', () => {
  let fs: InMemoryFileSystem;
  let store: FavoritesStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = new FavoritesStore('/hubs/favorites.json', fs);
  });

  it('returns an empty map when nothing has been saved', async () => {
    expect(await store.get()).toEqual({});
  });

  it('persists and retrieves the favorites map', async () => {
    await store.save({ 'hub-a': ['profile-1', 'profile-2'] });
    expect(await store.get()).toEqual({ 'hub-a': ['profile-1', 'profile-2'] });
  });

  it('overwrites the whole map on save', async () => {
    await store.save({ 'hub-a': ['profile-1'] });
    await store.save({ 'hub-b': ['profile-2'] });
    expect(await store.get()).toEqual({ 'hub-b': ['profile-2'] });
  });

  it('returns an empty map (rather than throwing) on a corrupted file', async () => {
    fs.seed('/hubs/favorites.json', 'not valid json');
    expect(await store.get()).toEqual({});
  });

  it('writes a bare Record<hubId, profileId[]> with no wrapper', async () => {
    await store.save({ 'hub-a': ['profile-1'] });
    const raw = await fs.readJson<Record<string, string[]>>('/hubs/favorites.json');
    expect(raw).toEqual({ 'hub-a': ['profile-1'] });
  });
});
