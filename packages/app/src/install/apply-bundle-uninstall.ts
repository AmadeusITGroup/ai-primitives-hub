/**
 * Shared bundle uninstall.
 *
 * Removes the files an install record lists, guarded (see
 * `recorded-files.ts`): a file another record holds is kept, a recorded
 * path with no location inside the target root (lexically or through a
 * symlinked directory) is refused, empty directories left behind are
 * pruned, and `local-only` repository installs drop their lines from the
 * git exclusion list. The record is removed in every case.
 * @module install/apply-bundle-uninstall
 */
import type {
  FileSystem,
  RepositoryExclusion,
  Target,
  TargetWriter,
} from '@ai-primitives-hub/core';
import type {
  InstallRecordStore,
} from '../stores/install-record-store';
import type {
  RepositoryCommitMode,
} from '../stores/json-lockfile-store';
import {
  locateRecord,
  pruneEmptyParents,
  recordLocations,
  removeGuarded,
} from './recorded-files';

/** Inputs of {@link applyBundleUninstall}. */
export interface ApplyBundleUninstallInput {
  /** Writer factory; the record's writer is built from its `targetType`. */
  writerFactory: (target: Target) => TargetWriter;
  /** Effective target: scope, commit mode and root set. */
  target: Target;
  /** Record key (bundle id). */
  key: string;
  /** Where the record is read and removed. */
  store: InstallRecordStore;
  /** Exclusion list of the repository; `null` outside repository scope. */
  exclusion: RepositoryExclusion | null;
  /** Filesystem used for existence, checksum, real-path and pruning checks. */
  fs: FileSystem;
  /** Keep files whose bytes changed since install. */
  preserveModified: boolean;
}

/** Outcome of {@link applyBundleUninstall}. */
export interface ApplyBundleUninstallResult {
  /** Bundle paths removed. */
  removed: string[];
  /** Bundle paths kept: another record holds the location, or the file was modified. */
  kept: { path: string; reason: 'shared' | 'modified' }[];
  /** Bundle paths with no location inside the root (lexically or by real path), or of an unresolvable record. */
  refused: string[];
  /** Bundle paths not on disk. */
  missing: string[];
  /** Bundle paths whose removal threw. */
  errors: { path: string; message: string }[];
  /** Absolute directories removed because they were left empty. */
  pruned: string[];
  /** Why the record could not be located, when it couldn't. */
  unresolvable?: string;
  /** The workspace is not a git repository: nothing was un-excluded. */
  exclusionSkipped: boolean;
  /** Exclusion list updates that failed; the uninstall went on. */
  exclusionErrors: string[];
}

const emptyResult = (): ApplyBundleUninstallResult => ({
  removed: [],
  kept: [],
  refused: [],
  missing: [],
  errors: [],
  pruned: [],
  exclusionSkipped: false,
  exclusionErrors: []
});

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Stop excluding paths after a `local-only` repository removal. Every
 * failure is recoverable and reported.
 * @param input Exclusion inputs.
 * @param input.exclusion Exclusion list, or `null`.
 * @param input.target Effective target.
 * @param input.commitMode Effective commit mode of the record.
 * @param input.paths Absolute paths to un-exclude.
 * @returns Whether exclusion was skipped and the errors met.
 */
export async function unexcludePaths(input: {
  exclusion: RepositoryExclusion | null;
  target: Target;
  commitMode: RepositoryCommitMode | undefined;
  paths: readonly string[];
}): Promise<{ exclusionSkipped: boolean; exclusionErrors: string[] }> {
  const { exclusion, target, commitMode, paths } = input;
  if (exclusion === null || target.scope !== 'repository' || commitMode !== 'local-only' || paths.length === 0) {
    return { exclusionSkipped: false, exclusionErrors: [] };
  }
  try {
    if (!(await exclusion.isAvailable?.() ?? true)) {
      return { exclusionSkipped: true, exclusionErrors: [] };
    }
    await exclusion.remove(paths);
    return { exclusionSkipped: false, exclusionErrors: [] };
  } catch (err) {
    return { exclusionSkipped: false, exclusionErrors: [messageOf(err)] };
  }
}

/**
 * Uninstall the bundle recorded under `key`.
 *
 * 1. no record → empty result;
 * 2. locate the record with the writer of its target type;
 * 3. unresolvable → every file refused, nothing deleted; a writer without
 *    `locate` → `writer.remove` for every file, unguarded;
 * 4–5. guarded removal against the locations every other record holds;
 * 6. prune empty parent directories strictly below the root;
 * 7. `local-only` at repository scope → un-exclude removed files and pruned directories;
 * 8. remove the record (a store failure rejects).
 * @param input Uninstall inputs.
 * @returns The outcome.
 */
export async function applyBundleUninstall(input: ApplyBundleUninstallInput): Promise<ApplyBundleUninstallResult> {
  const { writerFactory, target, key, store, exclusion, fs, preserveModified } = input;
  const result = emptyResult();
  const record = await store.get(key);
  if (record === undefined) {
    return result;
  }
  const { files } = record.entry;
  const located = await locateRecord(writerFactory, target, record);
  let unexclude: string[] = [];

  if (located.kind === 'unresolvable') {
    result.refused.push(...files.map((file) => file.path));
    result.unresolvable = located.reason;
  } else if (located.kind === 'no-locate') {
    for (const file of files) {
      try {
        await (file.installedPath === undefined
          ? located.writer.remove(located.target, file.path)
          : located.writer.remove(located.target, file.path, file.installedPath));
        result.removed.push(file.path);
      } catch (err) {
        result.errors.push({ path: file.path, message: messageOf(err) });
      }
    }
  } else {
    const others = await recordLocations(writerFactory, target, await store.others(key));
    const removal = await removeGuarded({ located, files, others, fs, preserveModified });
    result.removed.push(...removal.removed);
    result.kept.push(...removal.kept);
    result.refused.push(...removal.refused);
    result.missing.push(...removal.missing);
    result.errors.push(...removal.errors);
    result.pruned.push(...await pruneEmptyParents({ fs, root: located.located.root, removedLocations: removal.removedLocations }));
    unexclude = [...removal.removedLocations, ...result.pruned];
  }

  const exclusionOutcome = await unexcludePaths({
    exclusion,
    target,
    commitMode: record.commitMode ?? target.commitMode,
    paths: unexclude
  });
  result.exclusionSkipped = exclusionOutcome.exclusionSkipped;
  result.exclusionErrors.push(...exclusionOutcome.exclusionErrors);

  await store.remove(key);
  return result;
}
