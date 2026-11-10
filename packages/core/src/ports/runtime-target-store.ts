/**
 * RuntimeTargetStore port — durable state for target management.
 * Implementations own serialization, atomic publication and the exclusive
 * mutation lock. Only ENOENT means empty state; malformed state must reject.
 * @module ports/runtime-target-store
 */
import type {
  RuntimeMultiTargetLockfile,
} from '../domain/runtime-target/lockfile-v3';
import type {
  RuntimePlanConflict,
  RuntimeProjectionReceipt,
  RuntimeTargetInstance,
  RuntimeTargetState,
} from '../domain/runtime-target/types';

export interface RuntimeTargetStore {
  /** Absolute path of the user lockfile (for diagnostics/errors). */
  readonly statePath: string;
  /** Load and validate state; empty when the file does not exist. */
  load(): Promise<RuntimeTargetState>;
  /** Atomically publish the next state. */
  save(state: RuntimeTargetState): Promise<void>;
  /** Authority preflight; prevents projection over unresolved legacy records. */
  getMutationConflicts?(instance: RuntimeTargetInstance): Promise<RuntimePlanConflict[]>;
  /** Physical authorities for inspection; never a synthesized shadow ledger. */
  listLockfiles?(): Promise<{ path: string; scope: 'user' | 'repository'; document: RuntimeMultiTargetLockfile }[]>;
  /**
   * Replace legacy v2 repository lockfiles with v3 records, all or nothing.
   * Receipts are grouped by the lockfile (`commit` or `local-only`) they replace.
   */
  publishLegacyMigration?(input: {
    workspaceRoot: string;
    groups: { kind: 'commit' | 'local-only'; receipts: RuntimeProjectionReceipt[] }[];
  }): Promise<void>;
  /**
   * Run `fn` holding the exclusive mutation lock. The lock is an
   * exclusive-create file; a held/stale lock fails closed with the lock
   * path — never steal or reap another operation's lock.
   */
  withExclusive<T>(fn: () => Promise<T>): Promise<T>;
}
