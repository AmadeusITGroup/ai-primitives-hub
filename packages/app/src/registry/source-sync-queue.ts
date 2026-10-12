export interface SourceSyncQueue {
  enqueue: (sourceId: string) => void;
  hasEnqueued: () => boolean;
  onIdle: () => Promise<void>;
  onFirstSettled: () => Promise<void>;
}

/**
 * Normalize a caller-provided concurrency limit to a usable queue size.
 * @param concurrency Requested concurrency limit.
 * @returns A finite integer of at least one.
 */
export function normalizeConcurrency(concurrency: number): number {
  return Number.isFinite(concurrency) && concurrency > 0
    ? Math.max(1, Math.floor(concurrency))
    : 1;
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
 * @param onError
 */
export function createSourceSyncQueue(
  syncSource: (sourceId: string) => Promise<void>,
  concurrency: number,
  onError?: (sourceId: string, error: Error) => void
): SourceSyncQueue {
  const normalizedConcurrency = normalizeConcurrency(concurrency);
  const pending: string[] = [];
  const idleResolvers: (() => void)[] = [];
  const firstSettledResolvers: (() => void)[] = [];
  let activeSyncs = 0;
  let enqueuedCount = 0;
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
    void syncSource(sourceId).catch((error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      onError?.(sourceId, normalizedError);
    }).finally(() => {
      activeSyncs--;
      startAvailableSyncs();
      resolveFirstSettled();
      resolveIdle();
    });
  };

  const startAvailableSyncs = (): void => {
    while (activeSyncs < normalizedConcurrency && pending.length > 0) {
      startSync(pending.shift()!);
    }
  };

  return {
    enqueue: (sourceId) => {
      enqueuedCount++;
      pending.push(sourceId);
      startAvailableSyncs();
    },
    hasEnqueued: () => enqueuedCount > 0,
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
