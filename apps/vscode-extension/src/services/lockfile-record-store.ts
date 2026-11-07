/**
 * The shared install use cases' record store over the extension's
 * repository lockfiles.
 *
 * Adapts {@link LockfileManager} (atomic writes, change events, local
 * lockfile exclusion) to `app`'s `InstallRecordStore`, with the same
 * contract as `app`'s `createLockfileRecordStore`: a key lives in exactly
 * one of the two files, and a `put` that cannot remove it from the other
 * file restores the file it wrote before rethrowing.
 * @module services/lockfile-record-store
 */
import type {
  InstallRecord,
  InstallRecordSource,
  InstallRecordStore,
} from '@ai-primitives-hub/app';
import type {
  Lockfile,
  LockfileBundleEntry,
} from '../types/lockfile';
import type {
  RepositoryCommitMode,
} from '../types/registry';
import {
  Logger,
} from '../utils/logger';
import type {
  LockfileManager,
} from './lockfile-manager';

const COMMIT_MODES: readonly RepositoryCommitMode[] = ['commit', 'local-only'];

const otherModeOf = (mode: RepositoryCommitMode): RepositoryCommitMode => (mode === 'commit' ? 'local-only' : 'commit');

/**
 * `InstallRecordStore` over a workspace's `LockfileManager`.
 */
export class LockfileManagerRecordStore implements InstallRecordStore {
  private readonly logger = Logger.getInstance();

  /**
   * Store over a workspace's lockfiles.
   * @param lockfileManager - Lockfile manager of the workspace.
   */
  constructor(private readonly lockfileManager: LockfileManager) {}

  private async entryIn(mode: RepositoryCommitMode, key: string): Promise<LockfileBundleEntry | undefined> {
    const lockfile = await this.lockfileManager.readLockfileByMode(mode);
    return lockfile && Object.prototype.hasOwnProperty.call(lockfile.bundles, key) ? lockfile.bundles[key] : undefined;
  }

  /**
   * Undo a `put`'s write: put the target lockfile back as it was, which
   * restores the previous entry of `key`, drops a key the write added, or
   * deletes a file the write created. Best effort: a failure is logged and
   * the caller's error is the one reported.
   * @param key - Bundle ID.
   * @param mode - Lockfile the `put` wrote.
   * @param previous - Content of that lockfile before the write, `null` when absent.
   */
  private async restore(key: string, mode: RepositoryCommitMode, previous: Lockfile | null): Promise<void> {
    try {
      await this.lockfileManager.restoreLockfileByMode(mode, previous);
    } catch (error) {
      this.logger.warn(`Failed to restore the ${mode} lockfile after a failed move of ${key}:`, error instanceof Error ? error : undefined);
    }
  }

  /**
   * The record stored under `key`; the commit lockfile is read first.
   * @param key - Bundle ID.
   * @returns The record with the commit mode of its file, or `undefined`.
   */
  public async get(key: string): Promise<InstallRecord | undefined> {
    for (const mode of COMMIT_MODES) {
      const entry = await this.entryIn(mode, key);
      if (entry !== undefined) {
        return { entry, commitMode: mode };
      }
    }
    return undefined;
  }

  /**
   * Every record of both lockfiles except the ones stored under `key`.
   * @param key - Bundle ID to leave out.
   * @returns The other records.
   */
  public async others(key: string): Promise<readonly InstallRecord[]> {
    const records: InstallRecord[] = [];
    for (const mode of COMMIT_MODES) {
      const lockfile = await this.lockfileManager.readLockfileByMode(mode);
      for (const [otherKey, entry] of Object.entries(lockfile?.bundles ?? {})) {
        if (otherKey !== key) {
          records.push({ entry, commitMode: mode });
        }
      }
    }
    return records;
  }

  /**
   * Write the record into the lockfile of `commitMode`, then remove `key`
   * from the other lockfile. When that removal fails, the target file's
   * previous entry for `key` is restored (or the added key removed) and
   * the error rethrown, so `key` stays only where it was.
   * @param key - Bundle ID.
   * @param entry - Lockfile entry.
   * @param source - Source the entry refers to.
   * @param commitMode - Lockfile the record goes to (default `commit`).
   */
  public async put(
    key: string,
    entry: LockfileBundleEntry,
    source: InstallRecordSource,
    commitMode: RepositoryCommitMode = 'commit'
  ): Promise<void> {
    const previous = await this.lockfileManager.readLockfileByMode(commitMode);
    await this.lockfileManager.writeBundleEntry(key, entry, source.descriptor, commitMode);
    const otherMode = otherModeOf(commitMode);
    if ((await this.entryIn(otherMode, key)) === undefined) {
      return;
    }
    try {
      await this.lockfileManager.removeFromMode(key, otherMode);
    } catch (error) {
      await this.restore(key, commitMode, previous);
      throw error;
    }
  }

  /**
   * Remove the record stored under `key` and its source when no other
   * record refers to it; an emptied lockfile is deleted.
   * @param key - Bundle ID.
   */
  public async remove(key: string): Promise<void> {
    await this.lockfileManager.remove(key);
  }
}
