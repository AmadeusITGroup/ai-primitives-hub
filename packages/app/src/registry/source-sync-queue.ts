export interface SourceSyncQueue {
  enqueue: (sourceId: string) => void;
  onIdle: () => Promise<void>;
  onFirstSettled: () => Promise<void>;
}

/**
 * Creates a bounded-concurrency queue that syncs sources via the provided
 * `syncSource` callback.
 *
 * - `enqueue(sourceId)` — registers a source; dispatches up to `concurrency`
 *   syncs immediately.
 * - `onFirstSettled()` — resolves once the first sync has settled (success or
 *   failure). Resolves immediately if a sync has already settled at call time,
 *   preventing a race where the sync finishes before the caller awaits.
 * - `onIdle()` — resolves once all enqueued sources are done and the queue is
 *   empty. Also resolves immediately when the queue is already idle.
 * @param syncSource
 * @param concurrency
 */
export function createSourceSyncQueue(
  syncSource: (sourceId: string) => Promise<void>,
  concurrency: number
): SourceSyncQueue {
  const pending: string[] = [];
  const idleResolvers: (() => void)[] = [];
  const firstSettledResolvers: (() => void)[] = [];
  let activeSyncs = 0;
  let hasSettledOne = false;

  const flush = (resolvers: (() => void)[]): void => resolvers.splice(0).forEach((r) => r());

  const resolveIdle = (): void => {
    if (activeSyncs === 0 && pending.length === 0) {
      flush(idleResolvers);
    }
  };

  const resolveFirstSettled = (): void => {
    if (!hasSettledOne) {
      hasSettledOne = true;
      flush(firstSettledResolvers);
    }
  };

  const startSync = (sourceId: string): void => {
    activeSyncs++;
    // .catch() prevents unhandled rejections — callers are expected to handle
    // errors inside their syncSource callback, but any leak is silenced here.
    void syncSource(sourceId).catch(() => undefined).finally(() => {
      activeSyncs--;
      startAvailableSyncs();
      resolveFirstSettled();
      resolveIdle();
    });
  };

  const startAvailableSyncs = (): void => {
    while (activeSyncs < concurrency && pending.length > 0) {
      startSync(pending.shift()!);
    }
  };

  return {
    enqueue: (sourceId) => {
      pending.push(sourceId);
      startAvailableSyncs();
    },
    onIdle: () => new Promise<void>((resolve) => {
      idleResolvers.push(resolve);
      resolveIdle();
    }),
    onFirstSettled: () => new Promise<void>((resolve) => {
      // Eager resolution: if a sync already settled before this is called, resolve
      // in the same microtask tick rather than waiting indefinitely.
      if (hasSettledOne) {
        resolve();
        return;
      }
      firstSettledResolvers.push(resolve);
    })
  };
}
