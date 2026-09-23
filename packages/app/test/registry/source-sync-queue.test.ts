import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  createSourceSyncQueue,
} from '../../src/registry/source-sync-queue';

describe('createSourceSyncQueue', () => {
  it('onIdle resolves immediately when no sources are enqueued', async () => {
    const queue = createSourceSyncQueue(() => Promise.resolve(), 2);
    await queue.onIdle();
  });

  it('onIdle resolves after a single enqueued source finishes', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });

    const queue = createSourceSyncQueue(() => blocker, 2);
    queue.enqueue('s1');

    let resolved = false;
    const idlePromise = queue.onIdle().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    release();
    await idlePromise;
    expect(resolved).toBe(true);
  });

  it('onIdle resolves only after all enqueued sources finish', async () => {
    const releases: (() => void)[] = [];
    const sync = () => new Promise<void>((r) => {
      releases.push(r);
    });

    const queue = createSourceSyncQueue(sync, 3);
    queue.enqueue('s1');
    queue.enqueue('s2');
    queue.enqueue('s3');

    let resolved = false;
    const idlePromise = queue.onIdle().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    releases[0]();
    releases[1]();
    await Promise.resolve();
    expect(resolved).toBe(false);

    releases[2]();
    await idlePromise;
    expect(resolved).toBe(true);
  });

  it('onFirstSettled resolves after the first source settles (success)', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });

    const queue = createSourceSyncQueue(() => blocker, 1);
    queue.enqueue('s1');

    let settled = false;
    const firstSettledPromise = queue.onFirstSettled().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await firstSettledPromise;
    expect(settled).toBe(true);
  });

  it('onFirstSettled resolves after the first source settles (failure)', async () => {
    // syncSource is expected to handle its own errors — the queue only calls
    // .catch(() => undefined) as a safety net, so the callback swallows here.
    const sync = () => Promise.reject(new Error('sync failed')).catch(() => undefined) as Promise<void>;
    const queue = createSourceSyncQueue(sync, 1);
    queue.enqueue('s1');

    await queue.onFirstSettled(); // must resolve, not hang
  });

  it('onFirstSettled resolves immediately when already settled before promise is registered', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });

    const queue = createSourceSyncQueue(() => blocker, 1);
    queue.enqueue('s1');

    release();
    // Drain the microtask chain: blocker → catch → finally → hasSettledOne=true
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    let settled = false;
    await queue.onFirstSettled().then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
  });

  it('does not exceed the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: (() => void)[] = [];

    const sync = () => new Promise<void>((r) => {
      active++;
      maxActive = Math.max(maxActive, active);
      releases.push(() => {
        active--;
        r();
      });
    });

    const queue = createSourceSyncQueue(sync, 2);
    queue.enqueue('s1');
    queue.enqueue('s2');
    queue.enqueue('s3');

    await Promise.resolve();
    expect(active).toBe(2);

    releases[0]();
    // Drain: resolve → catch → finally → startAvailableSyncs → sync(s3) starts
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(active).toBe(2);

    releases[1]();
    releases[2]();
    await queue.onIdle();
    expect(maxActive).toBe(2);
  });

  it('proceeds past a failing sync to remaining sources', async () => {
    const synced: string[] = [];
    const sync = async (id: string) => {
      if (id === 's2') {
        throw new Error('forced failure');
      }
      synced.push(id);
    };

    const queue = createSourceSyncQueue(sync, 3);
    queue.enqueue('s1');
    queue.enqueue('s2');
    queue.enqueue('s3');

    await queue.onIdle();
    expect(synced.toSorted()).toEqual(['s1', 's3']);
  });
});
