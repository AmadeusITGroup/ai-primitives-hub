/**
 * Shared bundle install.
 *
 * Writes a bundle through the target's writer, excludes `local-only`
 * repository files from git, records the install, and removes the files
 * the previous install of the same key placed that the new one no longer
 * produces. Recording is part of the install: when the record can't be
 * written, the install's new files are rolled back and the error reaches
 * the caller.
 * @module install/apply-bundle-install
 */
import * as path from 'node:path';
import type {
  ExtractedFiles,
  FileSystem,
  RepositoryExclusion,
  Target,
  TargetWriter,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import type {
  InstallRecord,
  InstallRecordStore,
} from '../stores/install-record-store';
import type {
  LockfileBundleEntry,
  LockfileSourceEntry,
} from '../stores/json-lockfile-store';
import {
  unexcludePaths,
} from './apply-bundle-uninstall';
import {
  buildLockfileBundleEntry,
  computeInstalledChecksums,
} from './lockfile-entry';
import {
  type SkippedBundleContent,
  writeBundleForInstall,
} from './partial-target-write';
import {
  locateRecord,
  recordedFiles,
  removeSupersededRecordFiles,
} from './recorded-files';

/** Inputs of {@link applyBundleInstall}. */
export interface ApplyBundleInstallInput {
  /** Writer factory. */
  writerFactory: (target: Target) => TargetWriter;
  /** Effective target: scope, commit mode and root set. */
  target: Target;
  /** Full archive, modes preserved. */
  files: ExtractedFiles;
  /** Validated manifest of `files`. */
  manifest: ValidatedManifest;
  /** Record key (bundle id). */
  key: string;
  /** Where the bundle came from. */
  origin: { sourceId: string; sourceType: string; checksum?: string };
  /** Source descriptor recorded under `origin.sourceId`. */
  source: LockfileSourceEntry;
  /** Where the record is read and written. */
  store: InstallRecordStore;
  /** Exclusion list of the repository; `null` outside repository scope. */
  exclusion: RepositoryExclusion | null;
  /** Filesystem used for checksums, existence, real-path and pruning checks. */
  fs: FileSystem;
  /** Keep superseded files whose bytes changed since the previous install. */
  preserveModified: boolean;
  /** Install the content the target supports and report the rest (default all-or-nothing). */
  skipUnsupported?: boolean;
  /** Clock for `installedAt`. */
  now?: () => Date;
}

/** Outcome of {@link applyBundleInstall}. */
export interface ApplyBundleInstallResult {
  /** The recorded entry. */
  entry: LockfileBundleEntry;
  /** Absolute paths written. */
  written: string[];
  /** Content left out (`skipUnsupported` only). */
  skipped: SkippedBundleContent[];
  /** Bundle paths of the previous install's files that were removed. */
  superseded: string[];
  /**
   * Previous files kept: another record holds them, they were modified,
   * their location was refused, or the previous record was placed by
   * another target type whose files can't be located (`unresolvable`).
   */
  supersededKept: { path: string; reason: 'shared' | 'modified' | 'refused' | 'unresolvable' }[];
  /** Why the previous record, placed by another target type, could not be located; set only then. */
  supersededUnresolvable?: string;
  /** Previous files whose removal threw. */
  errors: { path: string; message: string }[];
  /** The workspace is not a git repository: nothing was excluded. */
  exclusionSkipped: boolean;
  /** Exclusion list updates that failed; the install went on. */
  exclusionErrors: string[];
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isLocalOnlyRepository = (target: Target): boolean =>
  target.scope === 'repository' && target.commitMode === 'local-only';

/**
 * Best-effort removal of written files after a failed recording.
 * @param writer Writer that wrote them.
 * @param target Target.
 * @param fs Filesystem (fallback for a writer without `rollback`).
 * @param paths Absolute paths to remove.
 */
const rollbackWritten = async (writer: TargetWriter, target: Target, fs: FileSystem, paths: readonly string[]): Promise<void> => {
  if (writer.rollback !== undefined) {
    try {
      await writer.rollback(target, paths);
    } catch {
      // Best effort: the recording error is what the caller needs.
    }
    return;
  }
  for (const p of paths) {
    try {
      await fs.remove(p);
    } catch {
      // Best effort, as above.
    }
  }
};

/**
 * Install a bundle and record it.
 *
 * 1. read the previous record of `key`;
 * 2. write through `writeBundleForInstall` (a rejection writes nothing and records nothing);
 * 3. `local-only` at repository scope → exclude the written files (recoverable);
 * 4–5. checksum the written files, read the new locations and the other
 *    records step 7 needs (only with a previous record), and store the entry;
 * 6. on a failure of 4–5, roll back the written files the previous record
 *    doesn't own, remove the exclusion lines this install added, rethrow;
 * 7. previous record, located with the writer of its own target type →
 *    remove its files the new entry doesn't produce, guarded like
 *    uninstall, prune, and un-exclude them when the previous record was
 *    `local-only`; a previous record of another target type that can't be
 *    located → keep its files and report them as `unresolvable`;
 * 8. previous `local-only`, new `commit` → un-exclude the new locations.
 * @param input Install inputs.
 * @returns The outcome.
 */
export async function applyBundleInstall(input: ApplyBundleInstallInput): Promise<ApplyBundleInstallResult> {
  const { writerFactory, target, files, manifest, key, origin, source, store, exclusion, fs, preserveModified } = input;
  const now = input.now ?? ((): Date => new Date());
  const exclusionErrors: string[] = [];
  let exclusionSkipped = false;

  const previous = await store.get(key);
  const writer = writerFactory(target);
  const write = await writeBundleForInstall(writer, target, files, manifest, { skipUnsupported: input.skipUnsupported === true });
  const { written } = write.result;

  let excluded = false;
  if (exclusion !== null && isLocalOnlyRepository(target) && written.length > 0) {
    try {
      if (await exclusion.isAvailable?.() ?? true) {
        await exclusion.add(written);
        excluded = true;
      } else {
        exclusionSkipped = true;
      }
    } catch (err) {
      exclusionErrors.push(messageOf(err));
    }
  }

  let entry: LockfileBundleEntry;
  let newLocations: string[] = [];
  let others: readonly InstallRecord[] = [];
  try {
    const installedChecksums = await computeInstalledChecksums({ writer, target, write, fs });
    entry = buildLockfileBundleEntry({
      version: manifest.version,
      sourceId: origin.sourceId,
      sourceType: origin.sourceType,
      ...(origin.checksum === undefined ? {} : { checksum: origin.checksum }),
      targetType: target.type,
      write,
      installedChecksums,
      now: now()
    });
    if (previous !== undefined) {
      // Read before the record is replaced: a failure here leaves the previous record and its files as they were.
      newLocations = writer.locate === undefined
        ? []
        : (await writer.locate(target, recordedFiles(entry.files))).paths.filter((p): p is string => p !== null);
      others = await store.others(key);
    }
    await store.put(key, entry, { id: origin.sourceId, descriptor: source }, target.commitMode);
  } catch (err) {
    const ownedRecord = previous === undefined ? undefined : await locateRecord(writerFactory, target, previous);
    const owned = new Set(ownedRecord?.kind === 'located'
      ? ownedRecord.located.paths.filter((p): p is string => p !== null).map((p) => path.resolve(p))
      : []);
    const rollback = written.filter((p) => !owned.has(path.resolve(p)));
    await rollbackWritten(writer, target, fs, rollback);
    if (excluded && exclusion !== null) {
      try {
        // The previous record's lines predate this install only when it was local-only.
        await exclusion.remove(previous?.commitMode === 'local-only' ? rollback : written);
      } catch {
        // Best effort: the recording error is what the caller needs.
      }
    }
    throw err;
  }

  const result: ApplyBundleInstallResult = {
    entry,
    written,
    skipped: write.skipped,
    superseded: [],
    supersededKept: [],
    errors: [],
    exclusionSkipped,
    exclusionErrors
  };
  if (previous === undefined) {
    return result;
  }

  // The written paths too: a writer without `locate` gives no new locations.
  const produced = new Set([...written, ...newLocations].map((p) => path.resolve(p)));

  const removal = await removeSupersededRecordFiles({
    writerFactory, target, previous, produced, others, fs, preserveModified
  });
  if (removal === null && (previous.entry.targetType ?? target.type) !== target.type) {
    // The new entry replaced a record of another target type whose files
    // can't be located here: nothing removes them later, so report them.
    const located = await locateRecord(writerFactory, target, previous);
    result.supersededUnresolvable = located.kind === 'unresolvable'
      ? located.reason
      : `the writer of target type "${previous.entry.targetType ?? target.type}" cannot locate files`;
    result.supersededKept.push(...previous.entry.files.map((file) => ({ path: file.path, reason: 'unresolvable' as const })));
  }
  if (removal !== null) {
    result.superseded.push(...removal.removed);
    result.supersededKept.push(...removal.kept, ...removal.refused.map((p) => ({ path: p, reason: 'refused' as const })));
    result.errors.push(...removal.errors);
    const outcome = await unexcludePaths({
      exclusion, target, commitMode: previous.commitMode, paths: [...removal.removedLocations, ...removal.pruned]
    });
    result.exclusionSkipped ||= outcome.exclusionSkipped;
    result.exclusionErrors.push(...outcome.exclusionErrors);
  }

  if ((target.commitMode ?? 'commit') === 'commit') {
    const outcome = await unexcludePaths({ exclusion, target, commitMode: previous.commitMode, paths: newLocations });
    result.exclusionSkipped ||= outcome.exclusionSkipped;
    result.exclusionErrors.push(...outcome.exclusionErrors);
  }
  return result;
}
