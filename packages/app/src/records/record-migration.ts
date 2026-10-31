/**
 * Record migration: turn the old 2.0.0 stores of a level into 3.0.0 record
 * entries before the first record change of an action (workflow W22;
 * BR18.2, BR18.3, BR19.1–BR19.5, BR20.1–BR20.3; NFR4.21, NFR4.22, NFR4.24, NFR4.25, NFR7.5).
 *
 * `migrateRecords` decides which old files it reads, never the caller:
 * - repository level: exactly `<root>/prompt-registry.lock.json` and
 *   `<root>/prompt-registry.local.lock.json`, each merged into the target of
 *   the same commit mode, then deleted;
 * - user level: the CLI's 2.0.0 user lockfile, read only while the user record
 *   has no `importedUserLockfileAt` marker and never changed or deleted, plus
 *   the profile entries the extension passes in.
 *
 * It runs in three phases: load every target and old file (a bad old file is
 * `RECORD.MALFORMED` naming it, and nothing is written), plan in memory, then
 * save the changed targets and delete the old repository files. Old entries go
 * under the `unknown` tool with `needsReinstall`; only profile entries carry a
 * real tool. A bundle a target already holds under any tool is skipped, so an
 * interrupted run is finished by the next one without adding anything back.
 * @module records/record-migration
 */
import * as path from 'node:path';
import {
  type BundleRecord,
  compareVersions,
  FORBIDDEN_KEYS,
  IMPORTED_USER_LOCKFILE_FIELD,
  isRecordError,
  RECORD_MAX_BYTES,
  RECORD_NAME_PATTERN,
  type RecordedFile,
  recordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  type SourceRecord,
  type ToolEntry,
  UNKNOWN_TOOL_NAME,
} from '@ai-primitives-hub/core';
import {
  LOCAL_LOCKFILE_NAME,
  type Lockfile,
  LOCKFILE_NAME,
} from '../stores/json-lockfile-store';
import {
  confinePath,
} from './confine-path';
import type {
  LoadedRecord,
  RecordStore,
} from './record-store';
import {
  sanitizeSource,
} from './sanitize-source';

/** Which old store an entry came from (entities.md `OldStore.kind`). */
export type MigrationOrigin = 'repository-committed' | 'repository-local' | 'cli-user-lockfile' | 'profile-registry-storage';

/** One old entry as it will appear in the 3.0.0 record (entities.md `MigratedEntry`). */
export interface MigratedEntry {
  bundleId: string;
  /** `unknown` for old-file entries; the host tool for profile entries (BR20.2). */
  tool: string;
  version: string;
  sourceId: string;
  /** A source type name, e.g. `github`. */
  sourceType: string;
  /** ISO 8601 UTC install time; the migration time when missing or not a date-time. */
  installedAt?: string;
  /**
   * Level-relative paths. Only safe paths with a file or symlink on disk are
   * kept, with the checksum taken from disk again; the others are reported (BR19.3).
   */
  files: readonly { path: string; checksum?: string }[];
  /** Source to record when the target has none for `sourceId`; credentials are removed (NFR4.25). */
  source?: Readonly<Record<string, unknown>>;
  from: MigrationOrigin;
}

/** What one migration run did (contract C5, amended by BR18.2). */
export interface MigrationReport {
  level: RecordLevel;
  /** Old repository files written under the new name because the new file did not exist. */
  renamed: { from: string; to: string }[];
  /** Old stores merged into an existing record; the profile store is `RegistryStorage (this profile)`. */
  mergedFrom: string[];
  /** The `unknown` entries this run created (BR21.1). */
  needsReinstall: { bundleId: string; version: string }[];
  /** Bundles held by two old stores: the version kept and the one dropped (BR19.4, BR20.3). */
  versionConflicts: { bundleId: string; kept: string; dropped: string }[];
  /** Old paths not kept (BR19.3). */
  droppedFiles: { bundleId: string; path: string; reason: string }[];
  /** Old entries not added because the record already holds the bundle (BR19.4, BR20.1, BR20.2). */
  droppedEntries: { bundleId: string; version: string; sourceId: string; reason: string }[];
  /** ISO 8601 time of the run; also the user record's `importedUserLockfileAt`. */
  migratedAt: string;
  /** Non-fatal problems from the saves, e.g. an `info/exclude` that could not be updated. */
  warnings: string[];
}

/** Input of {@link migrateRecords}. */
export interface MigrationInput {
  store: RecordStore;
  fs: RecordFs;
  level: RecordLevel;
  /** Git root (repository) or home (user); every old path is confined against it. */
  root: string;
  /** Both repository files at `root`, or the user record. */
  targets: readonly RecordLocation[];
  /** User level only: the CLI's 2.0.0 user lockfile (`resolveUserConfigPaths(env).userLockfile`). */
  oldUserLockfile?: string;
  /** User level, extension only: this profile's `RegistryStorage` user entries, already under the host tool (BR20.2). */
  profileEntries?: readonly MigratedEntry[];
  now: () => Date;
}

/** The parts of a 2.0.0 lockfile migration reads, as checked by {@link readOldLockfile}. */
export type OldLockfile = Pick<Lockfile, 'bundles' | 'sources' | 'hubs' | 'profiles'>;

/** Name of the profile store in `MigrationReport.mergedFrom`. */
export const PROFILE_STORE_NAME = 'RegistryStorage (this profile)';

/** URL recorded for a migrated source the old file did not describe; the record schema requires one. */
const MISSING_SOURCE_URL = UNKNOWN_TOOL_NAME;

const ALREADY_RECORDED = 'already recorded';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

const OLD_REPOSITORY_FILES = [
  { name: LOCKFILE_NAME, commitMode: 'commit', origin: 'repository-committed' },
  { name: LOCAL_LOCKFILE_NAME, commitMode: 'local-only', origin: 'repository-local' }
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const toNullPrototype = (value: Record<string, unknown>): Record<string, unknown> => {
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    copy[key] = value[key];
  }
  return copy;
};

/**
 * Prototype-free `JSON.parse`, as core's `parseRecord` but without its version gate.
 * @param text - File contents.
 * @param file - Old file to name in errors.
 */
const parseWithoutPrototypes = (text: string, file: string): unknown => {
  try {
    return JSON.parse(text, (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) {
        throw recordError('RECORD.MALFORMED', { file, detail: `forbidden key ${key}` });
      }
      return isObject(value) ? toNullPrototype(value) : value;
    });
  } catch (error) {
    if (isRecordError(error)) {
      throw error;
    }
    // The SyntaxError message can quote file contents, so it stays in `cause` only.
    throw recordError('RECORD.MALFORMED', { file, detail: 'not valid JSON', cause: error });
  }
};

/**
 * The first way a parsed old file misses the minimum 2.0.0 shape, if any.
 * @param value - Parsed file.
 */
const findShapeProblem = (value: unknown): string | undefined => {
  if (!isObject(value)) {
    return 'top level is not an object';
  }
  if (!isObject(value.bundles)) {
    return 'bundles is not an object';
  }
  const map = (['sources', 'hubs', 'profiles'] as const).find((key) => value[key] !== undefined && !isObject(value[key]));
  if (map !== undefined) {
    return `${map} is not an object`;
  }
  for (const [bundleId, entry] of Object.entries(value.bundles)) {
    const name = `bundles.${JSON.stringify(bundleId)}`;
    if (!isObject(entry) || nonEmpty(entry.version) === undefined || nonEmpty(entry.sourceId) === undefined) {
      return `${name} has no version or sourceId`;
    }
    if (typeof entry.sourceType !== 'string' || !RECORD_NAME_PATTERN.test(entry.sourceType)) {
      return `${name}.sourceType is not a source type name`;
    }
    if (!Array.isArray(entry.files) || !entry.files.every((file) => isObject(file) && typeof file.path === 'string')) {
      return `${name}.files is not a list of files with a path`;
    }
  }
  return undefined;
};

/**
 * Read an old 2.0.0 lockfile with the record store's guards (NFR4.21): a read
 * capped at 10 MB + 1 byte, strict UTF-8, prototype-free parsing and the
 * minimum 2.0.0 shape (`bundles` an object; each entry with a version, a
 * source id, a source type name and a `files` list of objects with a string
 * `path`; `sources`, `hubs` and `profiles` objects when present).
 * @param fs - Filesystem port.
 * @param file - Absolute path of the old file.
 * @returns The parsed file, with prototype-free objects throughout.
 * @throws {RegistryError} `RECORD.MALFORMED` naming the file for any failure.
 */
export const readOldLockfile = async (fs: RecordFs, file: string): Promise<OldLockfile> => {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readCapped(file, RECORD_MAX_BYTES + 1);
  } catch (error) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'the file could not be read', cause: error });
  }
  if (bytes.byteLength > RECORD_MAX_BYTES) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'record larger than 10 MB' });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'not valid UTF-8', cause: error });
  }
  const parsed = parseWithoutPrototypes(text, file);
  const problem = findShapeProblem(parsed);
  if (problem !== undefined) {
    throw recordError('RECORD.MALFORMED', { file, detail: problem });
  }
  return parsed as OldLockfile;
};

/** An old file read for this run, and the target it goes into. */
interface OldFile {
  path: string;
  origin: MigrationOrigin;
  lock: OldLockfile;
  target: LoadedRecord;
}

/** State of one run. */
interface MigrationRun {
  input: MigrationInput;
  loaded: LoadedRecord[];
  changed: Set<LoadedRecord>;
  report: MigrationReport;
}

/**
 * Order versions highest first; a version that cannot be compared keeps the order given.
 * @param left - First version.
 * @param right - Second version.
 */
const higherFirst = (left: string, right: string): number => {
  try {
    return compareVersions(right, left);
  } catch {
    return 0;
  }
};

const holdsBundle = (loaded: readonly LoadedRecord[], bundleId: string): boolean =>
  loaded.some((file) => Object.hasOwn(file.record.bundles, bundleId));

const dropEntry = (report: MigrationReport, entry: MigratedEntry): void => {
  report.droppedEntries.push({ bundleId: entry.bundleId, version: entry.version, sourceId: entry.sourceId, reason: ALREADY_RECORDED });
};

/**
 * One old-file entry as an `unknown` entry (BR19.2, BR20.1).
 * @param old - Old file.
 * @param bundleId - Bundle id.
 */
const fromOldEntry = (old: OldFile, bundleId: string): MigratedEntry => {
  const entry = old.lock.bundles[bundleId];
  const sources: Readonly<Record<string, object>> = old.lock.sources ?? {};
  return {
    bundleId,
    tool: UNKNOWN_TOOL_NAME,
    version: entry.version,
    sourceId: entry.sourceId,
    sourceType: entry.sourceType,
    installedAt: entry.installedAt,
    files: entry.files,
    source: Object.hasOwn(sources, entry.sourceId) ? { ...sources[entry.sourceId] } : undefined,
    from: old.origin
  };
};

/**
 * The recorded file for one old path, or why it is dropped (BR19.3).
 * @param fs - Filesystem port.
 * @param root - Level root.
 * @param recordedPath - Old path, relative to the root.
 */
const keepFile = async (fs: RecordFs, root: string, recordedPath: string): Promise<RecordedFile | string> => {
  let relative: string;
  try {
    relative = await confinePath(fs, root, recordedPath);
  } catch (error) {
    if (isRecordError(error)) {
      return 'unsafe path';
    }
    throw error;
  }
  const absolute = path.join(root, ...relative.split('/'));
  const kind = (await fs.lstat(absolute))?.kind;
  if (kind === undefined) {
    return 'not found';
  }
  if (kind !== 'file' && kind !== 'symlink') {
    return 'not a regular file';
  }
  const file = Object.create(null) as RecordedFile;
  file.path = relative;
  try {
    file.checksum = await fs.hashFile(absolute);
  } catch {
    return 'could not be read';
  }
  return file;
};

/**
 * The source recorded for a migrated entry: sanitized, with the entry's type
 * and {@link MISSING_SOURCE_URL} filling what the old store lacks (BR19.2).
 * @param entry - Migrated entry.
 */
const toSourceRecord = (entry: MigratedEntry): SourceRecord => {
  const given = entry.source ?? {};
  const source = sanitizeSource({ ...given, type: nonEmpty(given.type) ?? entry.sourceType, url: nonEmpty(given.url) ?? MISSING_SOURCE_URL });
  if (source.url === '') {
    source.url = MISSING_SOURCE_URL;
  }
  return source;
};

/**
 * Add a migrated entry to a target in memory, with its kept files and its
 * source. The CLI user lockfile records no target, so none of its files is
 * kept (BR20.1).
 * @param run - Current run.
 * @param target - Target record.
 * @param entry - Entry to add.
 */
const addEntry = async (run: MigrationRun, target: LoadedRecord, entry: MigratedEntry): Promise<void> => {
  const files = new Map<string, RecordedFile>();
  for (const { path: recordedPath } of entry.files) {
    const kept = entry.from === 'cli-user-lockfile' ? 'no target recorded' : await keepFile(run.input.fs, run.input.root, recordedPath);
    if (typeof kept === 'string') {
      run.report.droppedFiles.push({ bundleId: entry.bundleId, path: recordedPath, reason: kept });
    } else {
      files.set(kept.path, kept);
    }
  }
  const tool = Object.create(null) as ToolEntry;
  tool.version = entry.version;
  tool.sourceId = entry.sourceId;
  tool.sourceType = entry.sourceType;
  tool.installedAt = entry.installedAt !== undefined && ISO_DATE_TIME.test(entry.installedAt) ? entry.installedAt : run.report.migratedAt;
  tool.files = [...files.values()].toSorted((left, right) => (left.path < right.path ? -1 : 1));
  if (entry.tool === UNKNOWN_TOOL_NAME) {
    tool.needsReinstall = true;
    run.report.needsReinstall.push({ bundleId: entry.bundleId, version: entry.version });
  }
  const { record } = target;
  if (!Object.hasOwn(record.bundles, entry.bundleId)) {
    const bundle = Object.create(null) as BundleRecord;
    bundle.tools = Object.create(null) as BundleRecord['tools'];
    record.bundles[entry.bundleId] = bundle;
  }
  record.bundles[entry.bundleId].tools[entry.tool] = tool;
  if (!Object.hasOwn(record.sources, entry.sourceId)) {
    record.sources[entry.sourceId] = toSourceRecord(entry);
  }
  run.changed.add(target);
};

/**
 * Carry the old file's `hubs` and `profiles` into its target, keeping any key the target already has (BR19.2).
 * @param run - Current run.
 * @param old - Old file.
 */
const carryMaps = (run: MigrationRun, old: OldFile): void => {
  for (const key of ['hubs', 'profiles'] as const) {
    const from = old.lock[key];
    if (from === undefined) {
      continue;
    }
    const into = (old.target.record[key] ??= Object.create(null) as Record<string, unknown>);
    for (const [id, value] of Object.entries(from)) {
      if (!Object.hasOwn(into, id)) {
        into[id] = value;
        run.changed.add(old.target);
      }
    }
  }
};

/**
 * Repository plan (BR19.1–BR19.4): a bundle in both old files keeps its
 * higher version (the committed one on a tie), in the target of its own mode.
 * @param run - Current run.
 * @param oldFiles - Old repository files, committed first.
 */
const planRepository = async (run: MigrationRun, oldFiles: readonly OldFile[]): Promise<void> => {
  const candidates = new Map<string, { entry: MigratedEntry; target: LoadedRecord }[]>();
  for (const old of oldFiles) {
    carryMaps(run, old);
    for (const bundleId of Object.keys(old.lock.bundles)) {
      const list = candidates.get(bundleId) ?? [];
      list.push({ entry: fromOldEntry(old, bundleId), target: old.target });
      candidates.set(bundleId, list);
    }
  }
  for (const [bundleId, list] of candidates) {
    if (holdsBundle(run.loaded, bundleId)) {
      list.forEach(({ entry }) => dropEntry(run.report, entry));
      continue;
    }
    const [kept, ...others] = list.toSorted((left, right) => higherFirst(left.entry.version, right.entry.version));
    for (const other of others) {
      run.report.versionConflicts.push({ bundleId, kept: kept.entry.version, dropped: other.entry.version });
    }
    await addEntry(run, kept.target, kept.entry);
  }
  for (const old of oldFiles) {
    if (!old.target.exists && run.changed.has(old.target)) {
      run.report.renamed.push({ from: old.path, to: old.target.location.path });
    } else {
      run.report.mergedFrom.push(old.path);
    }
  }
};

/**
 * User plan (BR20.1–BR20.3): profile entries first, replacing a lone
 * `unknown` entry; then the old user lockfile's bundles nothing holds yet, as
 * `unknown` with no files; then the marker.
 * @param run - Current run.
 * @param target - The user record.
 * @param old - The old user lockfile, when it is read.
 */
const planUser = async (run: MigrationRun, target: LoadedRecord, old: OldFile | undefined): Promise<void> => {
  const profileEntries = run.input.profileEntries ?? [];
  for (const entry of profileEntries) {
    const tools = Object.hasOwn(target.record.bundles, entry.bundleId) ? target.record.bundles[entry.bundleId].tools : undefined;
    const held = Object.keys(tools ?? {});
    if (tools !== undefined && held.length === 1 && held[0] === UNKNOWN_TOOL_NAME) {
      const replaced = tools[UNKNOWN_TOOL_NAME].version;
      delete tools[UNKNOWN_TOOL_NAME];
      if (replaced !== entry.version) {
        run.report.versionConflicts.push({ bundleId: entry.bundleId, kept: entry.version, dropped: replaced });
      }
    } else if (held.length > 0) {
      dropEntry(run.report, entry);
      continue;
    }
    await addEntry(run, target, entry);
  }
  if (profileEntries.length > 0) {
    run.report.mergedFrom.push(PROFILE_STORE_NAME);
  }
  if (old !== undefined) {
    for (const bundleId of Object.keys(old.lock.bundles)) {
      const entry = fromOldEntry(old, bundleId);
      const profile = profileEntries.find((candidate) => candidate.bundleId === bundleId);
      if (profile !== undefined && profile.version !== entry.version) {
        run.report.versionConflicts.push({ bundleId, kept: profile.version, dropped: entry.version });
      } else if (holdsBundle(run.loaded, bundleId)) {
        dropEntry(run.report, entry);
      } else {
        await addEntry(run, target, entry);
      }
    }
    run.report.mergedFrom.push(old.path);
  }
  if (target.record[IMPORTED_USER_LOCKFILE_FIELD] === undefined) {
    target.record[IMPORTED_USER_LOCKFILE_FIELD] = run.report.migratedAt;
    run.changed.add(target);
  }
};

/**
 * The old repository files present at the root, each with the target of its commit mode.
 * @param input - Migration input.
 * @param loaded - Loaded targets.
 */
const readOldRepositoryFiles = async (input: MigrationInput, loaded: readonly LoadedRecord[]): Promise<OldFile[]> => {
  const oldFiles: OldFile[] = [];
  for (const { name, commitMode, origin } of OLD_REPOSITORY_FILES) {
    const file = path.join(input.root, name);
    const target = loaded.find((candidate) => candidate.location.commitMode === commitMode);
    if (target !== undefined && (await input.fs.lstat(file)) !== undefined) {
      oldFiles.push({ path: file, origin, lock: await readOldLockfile(input.fs, file), target });
    }
  }
  return oldFiles;
};

/**
 * The old user lockfile, while the user record has no marker and the file exists (BR20.1).
 * @param input - Migration input.
 * @param target - The loaded user record.
 */
const readOldUserFile = async (input: MigrationInput, target: LoadedRecord): Promise<OldFile | undefined> => {
  const file = input.oldUserLockfile;
  if (file === undefined || target.record[IMPORTED_USER_LOCKFILE_FIELD] !== undefined || (await input.fs.lstat(file)) === undefined) {
    return undefined;
  }
  return { path: file, origin: 'cli-user-lockfile', lock: await readOldLockfile(input.fs, file), target };
};

/**
 * Delete the old repository files after every save (BR19.5).
 * @param fs - Filesystem port.
 * @param oldFiles - Old repository files.
 * @throws {RegistryError} `RECORD.WRITE_FAILED` naming the first file that could not be deleted.
 */
const deleteOldFiles = async (fs: RecordFs, oldFiles: readonly OldFile[]): Promise<void> => {
  for (const old of oldFiles) {
    try {
      await fs.unlink(old.path);
    } catch (error) {
      throw recordError('RECORD.WRITE_FAILED', {
        file: old.path,
        detail: 'the old record could not be deleted after migration',
        message: 'The old install record could not be deleted; the new record is complete.',
        hint: 'Check that the file can be deleted, then run the command again; it will only delete it.',
        cause: error
      });
    }
  }
};

/**
 * Migrate the old stores of a level into its 3.0.0 records (W22).
 *
 * Loads every target and every old store first, plans in memory, saves each
 * changed target atomically (the user record always gets
 * `importedUserLockfileAt` when it is missing), then deletes the old
 * repository files. The CLI user lockfile is never changed or deleted.
 * @param input - Store, filesystem, level, root, targets, the old user lockfile, profile entries and the clock.
 * @returns The report, or `undefined` when there was nothing to do: no old
 * repository file, or at user level no profile entry and the marker already set.
 * @throws {RegistryError} `RECORD.MALFORMED` naming a bad old file, or any
 * `RECORD.*` error from loading a target (nothing is written);
 * `RECORD.WRITE_FAILED` from a save, or naming an old file that could not be
 * deleted after the saves.
 */
export const migrateRecords = async (input: MigrationInput): Promise<MigrationReport | undefined> => {
  const loaded: LoadedRecord[] = [];
  for (const target of input.targets) {
    loaded.push(await input.store.load(target));
  }
  if (loaded.length === 0) {
    return undefined;
  }
  const userTarget = input.level === 'user' ? loaded[0] : undefined;
  const oldFiles = userTarget === undefined ? await readOldRepositoryFiles(input, loaded) : [];
  const oldUser = userTarget === undefined ? undefined : await readOldUserFile(input, userTarget);
  const hasWork = userTarget === undefined
    ? oldFiles.length > 0
    : oldUser !== undefined || (input.profileEntries ?? []).length > 0 || userTarget.record[IMPORTED_USER_LOCKFILE_FIELD] === undefined;
  if (!hasWork) {
    return undefined;
  }
  const run: MigrationRun = {
    input,
    loaded,
    changed: new Set(),
    report: {
      level: input.level, renamed: [], mergedFrom: [], needsReinstall: [], versionConflicts: [],
      droppedFiles: [], droppedEntries: [], migratedAt: input.now().toISOString(), warnings: []
    }
  };
  await (userTarget === undefined ? planRepository(run, oldFiles) : planUser(run, userTarget, oldUser));
  for (const file of loaded) {
    if (run.changed.has(file)) {
      run.report.warnings.push(...(await input.store.save(file.location, file.record)).warnings);
    }
  }
  await deleteOldFiles(input.fs, oldFiles);
  return run.report;
};
