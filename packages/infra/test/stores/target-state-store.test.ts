/**
 * Tests for infra/stores/target-state-store.ts.
 *
 * Rewritten against this package's own `InMemoryFileSystem` test helper
 * rather than porting the reference branch's `.test.ts.skip` version
 * (which shelled out to a real temp-dir fs via a `../../cli/helpers/...`
 * relative import that does not resolve from this package — hence
 * disabled there).
 */
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type {
  TargetState,
} from '../../src/stores/target-state-store';
import {
  TargetStateStore,
} from '../../src/stores/target-state-store';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';

describe('TargetStateStore', () => {
  let fs: InMemoryFileSystem;
  let store: TargetStateStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = new TargetStateStore({ fs, statePath: '/state/target-state.json' });
  });

  const makeState = (targetName: string, lastUsedAt: string): TargetState => ({
    targetName,
    lastInstalledBundles: [
      { bundleId: 'bundle1', version: '1.0.0', installedAt: lastUsedAt }
    ],
    lastUsedAt
  });

  it('saves and loads target state', async () => {
    const state = makeState('test-target', '2024-01-01T00:00:00Z');
    await store.save(state);
    expect(await store.load('test-target')).toEqual(state);
  });

  it('returns null for missing target', async () => {
    expect(await store.load('missing-target')).toBeNull();
  });

  it('returns empty object when file does not exist for loadAll', async () => {
    expect(await store.loadAll()).toEqual({ targets: {} });
  });

  it('loads all target states', async () => {
    const state1 = makeState('target1', '2024-01-01T00:00:00Z');
    const state2 = makeState('target2', '2024-01-02T00:00:00Z');
    await store.save(state1);
    await store.save(state2);

    const loaded = await store.loadAll();
    expect(loaded.targets.target1).toEqual(state1);
    expect(loaded.targets.target2).toEqual(state2);
  });

  it('removes target state', async () => {
    const state = makeState('test-target', '2024-01-01T00:00:00Z');
    await store.save(state);
    await store.remove('test-target');
    expect(await store.load('test-target')).toBeNull();
  });

  it('is a no-op to remove a target when the file does not exist', async () => {
    await expect(store.remove('missing-target')).resolves.toBeUndefined();
  });

  it('gets last used target', async () => {
    await store.save(makeState('target1', '2024-01-01T00:00:00Z'));
    await store.save(makeState('target2', '2024-01-02T00:00:00Z'));

    expect(await store.getLastUsedTarget()).toBe('target2');
  });

  it('returns null for last used target when no states exist', async () => {
    expect(await store.getLastUsedTarget()).toBeNull();
  });

  it('creates parent directories when saving', async () => {
    const nestedStore = new TargetStateStore({ fs, statePath: '/state/nested/dir/target-state.json' });
    const state = makeState('test-target', '2024-01-01T00:00:00Z');

    await nestedStore.save(state);

    expect(await nestedStore.load('test-target')).toEqual(state);
  });
});
