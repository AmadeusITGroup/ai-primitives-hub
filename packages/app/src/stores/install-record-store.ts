/**
 * Install records kept in lockfiles.
 *
 * The shared install and uninstall use cases read and write what a bundle
 * installed through the {@link InstallRecordStore} interface; each
 * delivery passes its own store. This module's store keeps the records in
 * the CLI's lockfiles: the two repository lockfiles
 * (`prompt-registry.lock.json` for `commit`, `prompt-registry.local.lock.json`
 * for `local-only`), or a single user-scope lockfile.
 * @module stores/install-record-store
 */
import type {
  FileSystem,
  RepositoryExclusion,
} from '@ai-primitives-hub/core';
import {
  cleanupOrphanedSource,
  deleteLockfile,
  emptyLockfile,
  getLockfilePathForMode,
  type Lockfile,
  type LockfileBundleEntry,
  type LockfileSourceEntry,
  readLockfile,
  removeBundleEntry,
  type RepositoryCommitMode,
  upsertBundleEntry,
  upsertSource,
  writeLockfile,
} from './json-lockfile-store';

/** A bundle's install record. */
export interface InstallRecord {
  /** The recorded lockfile entry. */
  entry: LockfileBundleEntry;
  /** Repository store: the commit mode of the file the entry was read from. User store: undefined. */
  commitMode?: RepositoryCommitMode;
}

/** The source a record refers to. */
export interface InstallRecordSource {
  /** Source id (the `sources` map key). */
  id: string;
  /** Source descriptor. */
  descriptor: LockfileSourceEntry;
}

/** Where the shared use cases read and write install records. */
export interface InstallRecordStore {
  /**
   * The record stored under `key`; at repository scope the commit
   * lockfile is read first.
   * @param key Record key (bundle id).
   * @returns The record, or `undefined` when there is none.
   */
  get(key: string): Promise<InstallRecord | undefined>;
  /**
   * Every record the shared-file guard must respect, except the one
   * stored under `key`.
   * @param key Record key to leave out.
   * @returns The other records.
   */
  others(key: string): Promise<readonly InstallRecord[]>;
  /**
   * Store a record. Leaves `key` in exactly one file: it is removed from
   * the other repository lockfile when present there.
   * @param key Record key.
   * @param entry Lockfile entry.
   * @param source Source the entry refers to.
   * @param commitMode Repository commit mode (default `commit`); ignored by the user store.
   */
  put(key: string, entry: LockfileBundleEntry, source: InstallRecordSource, commitMode?: RepositoryCommitMode): Promise<void>;
  /**
   * Remove the record stored under `key` and its source when no other
   * record refers to it.
   * @param key Record key.
   */
  remove(key: string): Promise<void>;
}

/** Options of {@link createLockfileRecordStore}. */
export type LockfileRecordStoreOptions =
  | {
    scope: 'repository';
    fs: FileSystem;
    /** Repository root holding both lockfiles. */
    rootPath: string;
    /** `generatedBy` of a lockfile this store creates. */
    generatedBy: string;
    /** Exclusion list the local lockfile is added to and removed from. */
    exclusion: RepositoryExclusion;
  }
  | {
    scope: 'user';
    fs: FileSystem;
    /** The single user-scope lockfile. */
    lockfilePath: string;
    /** `generatedBy` of a lockfile this store creates. */
    generatedBy: string;
  };

const COMMIT_MODES: readonly RepositoryCommitMode[] = ['commit', 'local-only'];

const requireNonEmpty = (field: string, value: unknown): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`install record needs a non-empty ${field}`);
  }
};

const validatePut = (key: string, entry: LockfileBundleEntry, source: InstallRecordSource): void => {
  requireNonEmpty('key', key);
  requireNonEmpty('sourceId', entry.sourceId);
  requireNonEmpty('sourceType', entry.sourceType);
  requireNonEmpty('source.id', source.id);
  requireNonEmpty('source.type', source.descriptor.type);
  requireNonEmpty('source.url', source.descriptor.url);
};

const has = (lock: Lockfile | null, key: string): lock is Lockfile =>
  lock !== null && Object.prototype.hasOwnProperty.call(lock.bundles, key);

const withoutKey = (lock: Lockfile, key: string): Lockfile =>
  cleanupOrphanedSource(removeBundleEntry(lock, key), lock.bundles[key].sourceId);

const withRecord = (lock: Lockfile, key: string, entry: LockfileBundleEntry, source: InstallRecordSource): Lockfile =>
  upsertSource(upsertBundleEntry(lock, key, entry), source.id, source.descriptor);

/**
 * Store over the two repository lockfiles. Writing the local lockfile
 * adds it to the exclusion list (the list skips lines it already has)
 * and deleting it removes it there; errors of those two calls are
 * ignored (the use cases' own exclusion calls on the same list report
 * the problem).
 * @param opts Repository store options.
 * @param opts.fs Filesystem.
 * @param opts.rootPath Repository root.
 * @param opts.generatedBy `generatedBy` of a created lockfile.
 * @param opts.exclusion Exclusion list.
 * @returns The store.
 */
function repositoryStore(opts: { fs: FileSystem; rootPath: string; generatedBy: string; exclusion: RepositoryExclusion }): InstallRecordStore {
  const { fs, rootPath, generatedBy, exclusion } = opts;
  const pathFor = (mode: RepositoryCommitMode): string => getLockfilePathForMode(rootPath, mode);
  const readAll = async (): Promise<{ mode: RepositoryCommitMode; lock: Lockfile | null }[]> => Promise.all(
    COMMIT_MODES.map(async (mode) => ({ mode, lock: await readLockfile(pathFor(mode), fs) }))
  );
  const quietly = async (call: () => Promise<void>): Promise<void> => {
    try {
      await call();
    } catch {
      // Best effort: the use cases report exclusion problems themselves.
    }
  };
  /**
   * Write a lockfile, or delete it when no bundle remains.
   * @param mode Commit mode of the file.
   * @param lock Lockfile content to keep.
   */
  const save = async (mode: RepositoryCommitMode, lock: Lockfile): Promise<void> => {
    const file = pathFor(mode);
    if (Object.keys(lock.bundles).length > 0) {
      await writeLockfile(file, lock, fs);
      return;
    }
    await deleteLockfile(file, fs);
    if (mode === 'local-only' && !(await fs.exists(file))) {
      await quietly(() => exclusion.remove([file]));
    }
  };

  return {
    get: async (key) => {
      for (const { mode, lock } of await readAll()) {
        if (has(lock, key)) {
          return { entry: lock.bundles[key], commitMode: mode };
        }
      }
      return undefined;
    },
    others: async (key) => {
      const records: InstallRecord[] = [];
      for (const { mode, lock } of await readAll()) {
        for (const [otherKey, entry] of Object.entries(lock?.bundles ?? {})) {
          if (otherKey !== key) {
            records.push({ entry, commitMode: mode });
          }
        }
      }
      return records;
    },
    put: async (key, entry, source, commitMode = 'commit') => {
      validatePut(key, entry, source);
      const file = pathFor(commitMode);
      const existing = await readLockfile(file, fs);
      await writeLockfile(file, withRecord(existing ?? emptyLockfile(generatedBy), key, entry, source), fs);
      if (commitMode === 'local-only') {
        // Every time, not only on creation: a local lockfile an earlier install left unexcluded gets excluded too.
        await quietly(() => exclusion.add([file]));
      }
      // Written first, removed second: a crash in between leaves the record in both files, never in none.
      const otherMode: RepositoryCommitMode = commitMode === 'commit' ? 'local-only' : 'commit';
      const other = await readLockfile(pathFor(otherMode), fs);
      if (has(other, key)) {
        await save(otherMode, withoutKey(other, key));
      }
    },
    remove: async (key) => {
      requireNonEmpty('key', key);
      for (const { mode, lock } of await readAll()) {
        if (has(lock, key)) {
          await save(mode, withoutKey(lock, key));
          return;
        }
      }
    }
  };
}

/**
 * Store over a single user-scope lockfile. A lockfile left without
 * bundles is kept.
 * @param opts User store options.
 * @param opts.fs Filesystem.
 * @param opts.lockfilePath The lockfile.
 * @param opts.generatedBy `generatedBy` of a created lockfile.
 * @returns The store.
 */
function userStore(opts: { fs: FileSystem; lockfilePath: string; generatedBy: string }): InstallRecordStore {
  const { fs, lockfilePath, generatedBy } = opts;
  return {
    get: async (key) => {
      const lock = await readLockfile(lockfilePath, fs);
      return has(lock, key) ? { entry: lock.bundles[key] } : undefined;
    },
    others: async (key) => {
      const lock = await readLockfile(lockfilePath, fs);
      return Object.entries(lock?.bundles ?? {})
        .filter(([otherKey]) => otherKey !== key)
        .map(([, entry]) => ({ entry }));
    },
    put: async (key, entry, source) => {
      validatePut(key, entry, source);
      const lock = await readLockfile(lockfilePath, fs) ?? emptyLockfile(generatedBy);
      await writeLockfile(lockfilePath, withRecord(lock, key, entry, source), fs);
    },
    remove: async (key) => {
      requireNonEmpty('key', key);
      const lock = await readLockfile(lockfilePath, fs);
      if (has(lock, key)) {
        await writeLockfile(lockfilePath, withoutKey(lock, key), fs);
      }
    }
  };
}

/**
 * Create an install record store over the CLI's lockfiles.
 *
 * `put` and `remove` reject a key, `sourceId`, `sourceType`, source id,
 * `source.type` or `source.url` that isn't a non-empty string, naming the
 * field, before touching any file.
 * @param opts Repository (two lockfiles below `rootPath`) or user (one lockfile) options.
 * @returns The store.
 */
export function createLockfileRecordStore(opts: LockfileRecordStoreOptions): InstallRecordStore {
  return opts.scope === 'repository' ? repositoryStore(opts) : userStore(opts);
}
