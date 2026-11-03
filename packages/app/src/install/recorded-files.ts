/**
 * Recorded files of an install record: where they are, and their guarded
 * removal.
 *
 * Shared by the install use case (superseded files) and the uninstall use
 * case. A record is located through the writer of the target type that
 * placed it; a file is removed only when its location lies inside the
 * writer's root, lexically and by real path, no other record holds the
 * same location, and (when asked) the file still has the bytes the install
 * wrote.
 * @module install/recorded-files
 */
import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  FileSystem,
  RecordedFile,
  RecordedLocations,
  Target,
  TargetType,
  TargetWriter,
} from '@ai-primitives-hub/core';
import {
  isTargetType,
} from '@ai-primitives-hub/core';
import type {
  InstallRecord,
} from '../stores/install-record-store';
import type {
  LockfileFileEntry,
} from '../stores/json-lockfile-store';

/**
 * Where a record's files are.
 *
 * - `located`: the writer of the record's target type located every file
 *   (`located.paths[i]` is `null` for a file with no location inside the root);
 * - `no-locate`: the writer cannot locate files (a custom writer);
 * - `unresolvable`: the record names an unknown target type, or building
 *   the writer or locating the files failed.
 *
 * `target` is the target the record's writer works on: the caller's
 * target with the record's `targetType` and commit mode, without the
 * caller's `path` and `allowedKinds` when the types differ.
 */
export type LocatedRecord =
  | { kind: 'located'; writer: TargetWriter; target: Target; located: RecordedLocations }
  | { kind: 'no-locate'; writer: TargetWriter; target: Target }
  | { kind: 'unresolvable'; reason: string };

/**
 * Recorded files as the writers' `locate` takes them.
 * @param files Lockfile file entries.
 * @returns Bundle path plus recorded `installedPath` per file.
 */
export const recordedFiles = (files: readonly LockfileFileEntry[]): RecordedFile[] =>
  files.map((file) => (file.installedPath === undefined ? { path: file.path } : { path: file.path, installedPath: file.installedPath }));

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The caller's target retyped for a record's target type.
 *
 * Of the same type, the caller's target as is. Of another type, only its
 * name, scope and root: `path` overrides the caller type's own base
 * directory (at user scope), and `allowedKinds` filters the caller type's
 * kinds, so neither applies to another type's layout. The lockfile entry
 * records neither a target name nor a `path`, so a record placed through
 * a target with a custom `path` is located, through a target of another
 * type, at its type's default base directory.
 * @param target Caller's target.
 * @param type Record's target type.
 * @returns The target the record's writer works on.
 */
const targetOfType = (target: Target, type: TargetType): Target => (type === target.type
  ? target
  : {
    name: target.name,
    type,
    scope: target.scope,
    ...(target.rootPath === undefined ? {} : { rootPath: target.rootPath })
  });

/**
 * Locate a record's files with the writer of the target type that placed
 * them (`entry.targetType`, else the caller's target type).
 * @param writerFactory Writer factory.
 * @param target Caller's target (scope, root, commit mode).
 * @param record Install record.
 * @returns The located record.
 */
export async function locateRecord(
  writerFactory: (target: Target) => TargetWriter,
  target: Target,
  record: InstallRecord
): Promise<LocatedRecord> {
  const recordedType = record.entry.targetType;
  if (recordedType !== undefined && !isTargetType(recordedType)) {
    return { kind: 'unresolvable', reason: `unknown target type "${recordedType}"` };
  }
  const commitMode = record.commitMode ?? target.commitMode;
  const recordTarget: Target = {
    ...targetOfType(target, recordedType ?? target.type),
    ...(commitMode === undefined ? {} : { commitMode })
  };
  let writer: TargetWriter;
  try {
    writer = writerFactory(recordTarget);
  } catch (err) {
    return { kind: 'unresolvable', reason: messageOf(err) };
  }
  if (writer.locate === undefined) {
    return { kind: 'no-locate', writer, target: recordTarget };
  }
  try {
    return { kind: 'located', writer, target: recordTarget, located: await writer.locate(recordTarget, recordedFiles(record.entry.files)) };
  } catch (err) {
    return { kind: 'unresolvable', reason: messageOf(err) };
  }
}

/**
 * Normalised absolute locations of every located record, for the
 * shared-file guard. Records that aren't located add none.
 * @param writerFactory Writer factory.
 * @param target Caller's target.
 * @param records Records to collect.
 * @returns Set of `path.resolve`d locations.
 */
export async function recordLocations(
  writerFactory: (target: Target) => TargetWriter,
  target: Target,
  records: readonly InstallRecord[]
): Promise<Set<string>> {
  const locations = new Set<string>();
  for (const record of records) {
    const located = await locateRecord(writerFactory, target, record);
    if (located.kind === 'located') {
      for (const location of located.located.paths) {
        if (location !== null) {
          locations.add(path.resolve(location));
        }
      }
    }
  }
  return locations;
}

/** Outcome of {@link removeGuarded}, by bundle path. */
export interface GuardedRemoval {
  /** Bundle paths removed. */
  removed: string[];
  /** Absolute locations removed, index-aligned with `removed`. */
  removedLocations: string[];
  /** Files kept: another record holds the location, or the file was modified. */
  kept: { path: string; reason: 'shared' | 'modified' }[];
  /** Files with no location inside the root, lexically or by real path. */
  refused: string[];
  /** Files not on disk. */
  missing: string[];
  /** Files whose removal failed. */
  errors: { path: string; message: string }[];
}

const isNotFound = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || (err instanceof Error && err.message.startsWith('ENOENT'));
};

/**
 * Whether `candidate` equals `root` or lies below it.
 * @param root Absolute root.
 * @param candidate Absolute path.
 * @returns True when inside.
 */
const isAtOrBelow = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/** Real path of a directory, or why there is none. */
type RealPath = { kind: 'resolved'; path: string } | { kind: 'missing' } | { kind: 'unresolved' };

/**
 * Real path of a directory; lexical (`path.resolve`) without `fs.realpath`.
 * @param fs Filesystem.
 * @param dir Absolute directory.
 * @returns The real path, `missing` on ENOENT, `unresolved` on any other error.
 */
const realpathOf = async (fs: Pick<FileSystem, 'realpath'>, dir: string): Promise<RealPath> => {
  if (fs.realpath === undefined) {
    return { kind: 'resolved', path: path.resolve(dir) };
  }
  try {
    return { kind: 'resolved', path: await fs.realpath(dir) };
  } catch (err) {
    return isNotFound(err) ? { kind: 'missing' } : { kind: 'unresolved' };
  }
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Remove a located record's files, guarded.
 *
 * Per file: no location → refused; the real path of its parent directory
 * is not the root's real path or below it → refused (a symlinked
 * directory below the root pointing outside); its location is in
 * `others` → kept `shared`; not on disk (or its parent or the root
 * missing) → missing; `preserveModified` and the bytes on disk don't
 * match `installedChecksum ?? checksum` → kept `modified`; otherwise
 * `writer.remove` (a throw goes to `errors`). Without `fs.realpath` the
 * check is lexical only. The file itself may be a symlink: removal
 * removes the link, never its target.
 * @param input Located record, files, guard inputs.
 * @param input.located A `located` record.
 * @param input.files The record's files, index-aligned with `located.located.paths`.
 * @param input.others Normalised locations other records hold.
 * @param input.fs Filesystem.
 * @param input.preserveModified Keep files whose bytes changed since install.
 * @returns The outcome by bundle path.
 */
export async function removeGuarded(input: {
  located: Extract<LocatedRecord, { kind: 'located' }>;
  files: readonly LockfileFileEntry[];
  others: ReadonlySet<string>;
  fs: FileSystem;
  preserveModified: boolean;
}): Promise<GuardedRemoval> {
  const { located: { writer, target, located }, files, others, fs, preserveModified } = input;
  const outcome: GuardedRemoval = { removed: [], removedLocations: [], kept: [], refused: [], missing: [], errors: [] };
  const rootReal = await realpathOf(fs, located.root);

  for (const [index, file] of files.entries()) {
    const location = located.paths[index] ?? null;
    if (location === null) {
      outcome.refused.push(file.path);
      continue;
    }
    if (rootReal.kind === 'missing') {
      outcome.missing.push(file.path);
      continue;
    }
    const parentReal = await realpathOf(fs, path.dirname(location));
    if (parentReal.kind === 'missing') {
      outcome.missing.push(file.path);
      continue;
    }
    if (rootReal.kind !== 'resolved' || parentReal.kind !== 'resolved' || !isAtOrBelow(rootReal.path, parentReal.path)) {
      outcome.refused.push(file.path);
      continue;
    }
    if (others.has(path.resolve(location))) {
      outcome.kept.push({ path: file.path, reason: 'shared' });
      continue;
    }
    if (!(await fs.exists(location))) {
      outcome.missing.push(file.path);
      continue;
    }
    if (preserveModified && sha256(await fs.readFileBytes(location)) !== (file.installedChecksum ?? file.checksum)) {
      outcome.kept.push({ path: file.path, reason: 'modified' });
      continue;
    }
    try {
      await (file.installedPath === undefined
        ? writer.remove(target, file.path)
        : writer.remove(target, file.path, file.installedPath));
      outcome.removed.push(file.path);
      outcome.removedLocations.push(location);
    } catch (err) {
      outcome.errors.push({ path: file.path, message: messageOf(err) });
    }
  }
  return outcome;
}

/** Outcome of {@link inspectRecordedFiles}, by bundle path. */
export interface RecordedFilesInspection {
  /** Files not on disk, or with no location inside the root. */
  missing: string[];
  /** Files whose bytes differ from `installedChecksum ?? checksum`, with the checksum on disk. */
  modified: { path: string; currentChecksum: string }[];
  /**
   * Files whose state can't be known: the record isn't located (unknown
   * target type, a writer without `locate`, a failed locate), or reading
   * the file failed with an error other than "not found".
   */
  unknown: string[];
}

/**
 * Compare a record's files with the disk.
 *
 * A `located` record: a file with no location or not on disk is
 * `missing`; one whose bytes don't match `installedChecksum ?? checksum`
 * is `modified`; a read error other than "not found" makes it `unknown`.
 * A record that isn't located has every file `unknown`. Nothing is
 * changed on disk.
 * @param input Located record, files and filesystem.
 * @param input.located The record located by {@link locateRecord}.
 * @param input.files The record's files, index-aligned with `located.located.paths`.
 * @param input.fs Filesystem the bytes are read from.
 * @returns The files missing, modified and of unknown state.
 */
export async function inspectRecordedFiles(input: {
  located: LocatedRecord;
  files: readonly LockfileFileEntry[];
  fs: Pick<FileSystem, 'readFileBytes'>;
}): Promise<RecordedFilesInspection> {
  const { located, files, fs } = input;
  const outcome: RecordedFilesInspection = { missing: [], modified: [], unknown: [] };
  if (located.kind !== 'located') {
    outcome.unknown.push(...files.map((file) => file.path));
    return outcome;
  }
  for (const [index, file] of files.entries()) {
    const location = located.located.paths[index] ?? null;
    if (location === null) {
      outcome.missing.push(file.path);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFileBytes(location);
    } catch (err) {
      (isNotFound(err) ? outcome.missing : outcome.unknown).push(file.path);
      continue;
    }
    const currentChecksum = sha256(bytes);
    if (currentChecksum !== (file.installedChecksum ?? file.checksum)) {
      outcome.modified.push({ path: file.path, currentChecksum });
    }
  }
  return outcome;
}

/**
 * Whether an installed record lacks files: some file is `missing`. A
 * file of `unknown` state counts as present, so a record is not reported
 * incomplete only because its files can't be checked.
 * @param inspection Outcome of {@link inspectRecordedFiles}.
 * @returns True when a recorded file is missing.
 */
export const isRecordIncomplete = (inspection: Pick<RecordedFilesInspection, 'missing'>): boolean =>
  inspection.missing.length > 0;

/**
 * Remove the directories left empty by removed files: every ancestor of
 * a removed location strictly below the root, deepest first, when it is
 * empty and its real path lies strictly below the root's real path. The
 * root itself is never removed.
 * @param input Filesystem, root and removed locations.
 * @param input.fs Filesystem.
 * @param input.root Absolute root of the writer.
 * @param input.removedLocations Absolute locations removed.
 * @returns Absolute directories removed, deepest first.
 */
export async function pruneEmptyParents(input: {
  fs: FileSystem;
  root: string;
  removedLocations: readonly string[];
}): Promise<string[]> {
  const { fs } = input;
  const root = path.resolve(input.root);
  const rootReal = await realpathOf(fs, root);
  if (rootReal.kind !== 'resolved') {
    return [];
  }
  const candidates = new Set<string>();
  for (const location of input.removedLocations) {
    for (let dir = path.dirname(path.resolve(location)); dir !== root && isAtOrBelow(root, dir); dir = path.dirname(dir)) {
      candidates.add(dir);
    }
  }
  const deepestFirst = [...candidates].toSorted((a, b) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b));
  const pruned: string[] = [];
  for (const dir of deepestFirst) {
    if (!(await isEmptyDirectory(fs, dir))) {
      continue;
    }
    const dirReal = await realpathOf(fs, dir);
    if (dirReal.kind !== 'resolved' || dirReal.path === rootReal.path || !isAtOrBelow(rootReal.path, dirReal.path)) {
      continue;
    }
    try {
      await fs.remove(dir, { recursive: true });
      pruned.push(dir);
    } catch {
      // Best effort: a directory that can't be removed stays.
    }
  }
  return pruned;
}

/** Outcome of {@link removeSupersededRecordFiles}. */
export interface SupersededRemoval extends GuardedRemoval {
  /** Directories left empty by the removal and removed, deepest first. */
  pruned: string[];
}

/**
 * Remove the files a previous record of a bundle placed that the new
 * install no longer produces, guarded like uninstall (see
 * {@link removeGuarded}), then prune the directories they leave empty.
 *
 * The previous record is located with the writer of its own target type
 * (see {@link locateRecord}), so a reinstall through another target type
 * removes the files the replaced record placed instead of leaving them
 * with no record.
 * @param input Previous record, new locations and guard inputs.
 * @param input.writerFactory Writer factory.
 * @param input.target Caller's target.
 * @param input.previous The replaced record.
 * @param input.produced Normalised locations the new install produced.
 * @param input.others Records the shared-file guard must respect.
 * @param input.fs Filesystem.
 * @param input.preserveModified Keep files whose bytes changed since the previous install.
 * @returns The outcome, or `null` when the previous record's files can't
 *   be located.
 */
export async function removeSupersededRecordFiles(input: {
  writerFactory: (target: Target) => TargetWriter;
  target: Target;
  previous: InstallRecord;
  produced: ReadonlySet<string>;
  others: readonly InstallRecord[];
  fs: FileSystem;
  preserveModified: boolean;
}): Promise<SupersededRemoval | null> {
  const { writerFactory, target, previous, produced, others, fs, preserveModified } = input;
  const previousLocated = await locateRecord(writerFactory, target, previous);
  if (previousLocated.kind !== 'located') {
    return null;
  }
  const candidates = previous.entry.files
    .map((file, index) => ({ file, location: previousLocated.located.paths[index] ?? null }))
    .filter(({ location }) => location !== null && !produced.has(path.resolve(location)));
  const removal = await removeGuarded({
    located: { ...previousLocated, located: { root: previousLocated.located.root, paths: candidates.map(({ location }) => location) } },
    files: candidates.map(({ file }) => file),
    others: await recordLocations(writerFactory, target, others),
    fs,
    preserveModified
  });
  const pruned = await pruneEmptyParents({ fs, root: previousLocated.located.root, removedLocations: removal.removedLocations });
  return { ...removal, pruned };
}

const isEmptyDirectory = async (fs: FileSystem, dir: string): Promise<boolean> => {
  try {
    return (await fs.exists(dir)) && (await fs.readDir(dir)).length === 0;
  } catch {
    return false;
  }
};
