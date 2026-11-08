/**
 * Record migration: move a level's old 2.0.0 stores into its 3.0.0 records
 * before the first record change. Repository level merges the two old
 * `prompt-registry` files at the root and deletes them; user level imports the
 * CLI's old user lockfile once and the extension's profile entries. Old
 * entries go under the `unknown` tool. Entries a record already holds are
 * skipped, so an interrupted run is finished by the next one.
 * @module records/record-migration
 */
import * as path from 'node:path';
import {
  compareVersions,
  IMPORTED_USER_LOCKFILE_FIELD,
  isJsonObject,
  isRecordError,
  parseJsonWithoutPrototypes,
  RECORD_NAME_PATTERN,
  type RecordedFile,
  recordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  type SourceRecord,
  UNKNOWN_TOOL_NAME,
} from '@ai-primitives-hub/core';
import {
  resolveUserConfigPaths,
} from '../registry/user-config-paths';
import {
  LOCAL_LOCKFILE_NAME,
  type Lockfile,
  LOCKFILE_NAME,
} from '../stores/json-lockfile-store';
import {
  confinePath,
} from './confine-path';
import {
  isLoneUnknown,
} from './install-record-service';
import {
  readRecordText,
} from './read-record-text';
import {
  hashRecordedFile,
  putToolEntry,
} from './record-entry';
import {
  recordIdentityOf,
} from './record-identity';
import type {
  LoadedRecord,
  RecordStore,
} from './record-store';
import {
  sanitizeSource,
} from './sanitize-source';

/** Which old store an entry came from. */
export type MigrationOrigin = 'repository-committed' | 'repository-local' | 'cli-user-lockfile' | 'profile-registry-storage';

/** One old entry as it will appear in the 3.0.0 record. */
export interface MigratedEntry {
  bundleId: string;
  /** `unknown` for old-file entries; the host tool for profile entries. */
  tool: string;
  version: string;
  sourceId: string;
  sourceType: string;
  /** ISO 8601 UTC install time; the migration time when missing or not a date-time. */
  installedAt?: string;
  /** Level-relative paths; only safe paths found on disk are kept, re-hashed. */
  files: readonly { path: string; checksum?: string }[];
  /** Source to record when the target has none for `sourceId`; credentials are removed. */
  source?: Readonly<Record<string, unknown>>;
  from: MigrationOrigin;
}

/** What one migration run did. */
export interface MigrationReport {
  level: RecordLevel;
  /** Old repository files written under the new name. */
  renamed: { from: string; to: string }[];
  /** Old stores merged into an existing record; the profile store is `RegistryStorage (this profile)`. */
  mergedFrom: string[];
  /** The `unknown` entries this run created. */
  needsReinstall: { bundleId: string; version: string }[];
  /** Bundles held by two old stores: the version kept and the one dropped. */
  versionConflicts: { bundleId: string; kept: string; dropped: string }[];
  /** Old paths not kept. */
  droppedFiles: { bundleId: string; path: string; reason: string }[];
  /** Old entries not added because the record already holds the bundle. */
  droppedEntries: { bundleId: string; version: string; sourceId: string; reason: string }[];
  /** ISO 8601 time of the run; also the user record's `importedUserLockfileAt`. */
  migratedAt: string;
  /** Non-fatal problems from the saves. */
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
  /** User level only: the CLI's 2.0.0 user lockfile. */
  oldUserLockfile?: string;
  /** User level, extension only: this profile's `RegistryStorage` user entries, under the host tool. */
  profileEntries?: readonly MigratedEntry[];
  now: () => Date;
}

/** The parts of a 2.0.0 lockfile migration reads. */
export type OldLockfile = Pick<Lockfile, 'bundles' | 'sources' | 'hubs' | 'profiles'>;

/** Name of the profile store in `MigrationReport.mergedFrom`. */
export const PROFILE_STORE_NAME = 'RegistryStorage (this profile)';

/** URL recorded for a migrated source the old file did not describe; the record schema requires one. */
const MISSING_SOURCE_URL = UNKNOWN_TOOL_NAME;

const ALREADY_RECORDED = 'already recorded';

const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

// The record schema needs a real calendar date and time, not only the ISO shape.
const isDateTime = (value: string | undefined): value is string => {
  const match = value === undefined ? null : ISO_DATE_TIME.exec(value);
  if (match === null) {
    return false;
  }
  // With a `Z` zone the offset groups are absent, so they are NaN and pass the offset check.
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
    && !(offsetHour > 23 || offsetMinute > 59);
};

const OLD_REPOSITORY_FILES = [
  { name: LOCKFILE_NAME, commitMode: 'commit', origin: 'repository-committed' },
  { name: LOCAL_LOCKFILE_NAME, commitMode: 'local-only', origin: 'repository-local' }
] as const;

const nonEmpty = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const findShapeProblem = (value: unknown): string | undefined => {
  if (!isJsonObject(value)) {
    return 'top level is not an object';
  }
  if (!isJsonObject(value.bundles)) {
    return 'bundles is not an object';
  }
  const map = (['sources', 'hubs', 'profiles'] as const).find((key) => value[key] !== undefined && !isJsonObject(value[key]));
  if (map !== undefined) {
    return `${map} is not an object`;
  }
  for (const [bundleId, entry] of Object.entries(value.bundles)) {
    const name = `bundles.${JSON.stringify(bundleId)}`;
    if (!isJsonObject(entry) || nonEmpty(entry.version) === undefined || nonEmpty(entry.sourceId) === undefined) {
      return `${name} has no version or sourceId`;
    }
    if (typeof entry.sourceType !== 'string' || !RECORD_NAME_PATTERN.test(entry.sourceType)) {
      return `${name}.sourceType is not a source type name`;
    }
    if (!Array.isArray(entry.files) || !entry.files.every((file) => isJsonObject(file) && typeof file.path === 'string')) {
      return `${name}.files is not a list of files with a path`;
    }
  }
  return undefined;
};

/**
 * Read an old 2.0.0 lockfile with the record store's guards: capped size,
 * strict UTF-8, prototype-free parsing and the minimum 2.0.0 shape.
 * @param fs - Filesystem port.
 * @param file - Absolute path of the old file.
 * @throws {RegistryError} `RECORD.MALFORMED` naming the file.
 */
export const readOldLockfile = async (fs: RecordFs, file: string): Promise<OldLockfile> => {
  const parsed = parseJsonWithoutPrototypes(await readRecordText(fs, file, file), file);
  const problem = findShapeProblem(parsed);
  if (problem !== undefined) {
    throw recordError('RECORD.MALFORMED', { file, detail: problem });
  }
  return parsed as OldLockfile;
};

interface OldFile {
  path: string;
  origin: MigrationOrigin;
  lock: OldLockfile;
  target: LoadedRecord;
}

interface MigrationRun {
  input: MigrationInput;
  loaded: LoadedRecord[];
  changed: Set<LoadedRecord>;
  report: MigrationReport;
}

// A version that cannot be compared keeps the order given.
const higherFirst = (left: string, right: string): number => {
  try {
    return compareVersions(right, left);
  } catch {
    return 0;
  }
};

const identityOf = (entry: MigratedEntry): string => recordIdentityOf(entry.bundleId, entry.version);

// Entries of the same identity under any key and, when given, for one tool only.
const entriesOfIdentity = (
  loaded: readonly LoadedRecord[],
  identity: string,
  tool?: string
): { file: LoadedRecord; bundleId: string; tool: string; version: string }[] =>
  loaded.flatMap((file) => Object.entries(file.record.bundles).flatMap(([bundleId, bundle]) =>
    Object.entries(bundle.tools)
      .filter(([name, entry]) => (tool === undefined || name === tool) && recordIdentityOf(bundleId, entry.version) === identity)
      .map(([name, entry]) => ({ file, bundleId, tool: name, version: entry.version }))));

const holdsIdentity = (loaded: readonly LoadedRecord[], identity: string): boolean => entriesOfIdentity(loaded, identity).length > 0;

/**
 * The entries of one identity each, the higher version first in each list;
 * a version that cannot be compared keeps the order given.
 * @param entries - Entries in the order given.
 */
const groupByIdentity = <T extends { entry: MigratedEntry }>(entries: readonly T[]): T[][] => {
  const groups = new Map<string, T[]>();
  for (const item of entries) {
    const identity = identityOf(item.entry);
    groups.set(identity, [...(groups.get(identity) ?? []), item]);
  }
  return [...groups.values()].map((group) => group.toSorted((left, right) => higherFirst(left.entry.version, right.entry.version)));
};

const dropEntry = (report: MigrationReport, entry: MigratedEntry): void => {
  report.droppedEntries.push({ bundleId: entry.bundleId, version: entry.version, sourceId: entry.sourceId, reason: ALREADY_RECORDED });
};

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

// The recorded file for one old path, or why it is dropped.
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
  const kind = (await fs.lstat(path.join(root, ...relative.split('/'))))?.kind;
  if (kind === undefined) {
    return 'not found';
  }
  if (kind !== 'file' && kind !== 'symlink') {
    return 'not a regular file';
  }
  try {
    return await hashRecordedFile(fs, root, relative);
  } catch {
    return 'could not be read';
  }
};

// The record schema needs a type and url the old store may lack.
const toSourceRecord = (entry: MigratedEntry): SourceRecord => {
  const given = entry.source ?? {};
  const source = sanitizeSource({ ...given, type: nonEmpty(given.type) ?? entry.sourceType, url: nonEmpty(given.url) ?? MISSING_SOURCE_URL });
  if (source.url === '') {
    source.url = MISSING_SOURCE_URL;
  }
  return source;
};

// The CLI user lockfile records no target, so none of its files is kept.
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
  const unknown = entry.tool === UNKNOWN_TOOL_NAME;
  const { record } = target;
  putToolEntry(record, entry.bundleId, entry.tool, {
    version: entry.version,
    sourceId: entry.sourceId,
    sourceType: entry.sourceType,
    installedAt: isDateTime(entry.installedAt) ? entry.installedAt : run.report.migratedAt,
    files: [...files.values()],
    ...(unknown ? { needsReinstall: true } : {})
  });
  if (unknown) {
    run.report.needsReinstall.push({ bundleId: entry.bundleId, version: entry.version });
  }
  if (!Object.hasOwn(record.sources, entry.sourceId)) {
    record.sources[entry.sourceId] = toSourceRecord(entry);
  }
  run.changed.add(target);
};

// Carry `hubs` and `profiles` over, keeping any key the target already has.
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

// One entry per identity: the record's wins, otherwise the higher version in the old files, the committed one on a tie.
const planRepository = async (run: MigrationRun, oldFiles: readonly OldFile[]): Promise<void> => {
  const candidates: { entry: MigratedEntry; target: LoadedRecord }[] = [];
  for (const old of oldFiles) {
    carryMaps(run, old);
    for (const bundleId of Object.keys(old.lock.bundles)) {
      candidates.push({ entry: fromOldEntry(old, bundleId), target: old.target });
    }
  }
  for (const [kept, ...others] of groupByIdentity(candidates)) {
    if (holdsIdentity(run.loaded, identityOf(kept.entry))) {
      [kept, ...others].forEach(({ entry }) => dropEntry(run.report, entry));
      continue;
    }
    for (const other of others) {
      run.report.versionConflicts.push({ bundleId: other.entry.bundleId, kept: kept.entry.version, dropped: other.entry.version });
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

// Remove the `unknown` entries found; returns the source ids they used.
const removeUnknown = (target: LoadedRecord, found: readonly { bundleId: string }[]): string[] => {
  const { bundles } = target.record;
  return found.map(({ bundleId }) => {
    const { sourceId } = bundles[bundleId].tools[UNKNOWN_TOOL_NAME];
    delete bundles[bundleId].tools[UNKNOWN_TOOL_NAME];
    if (Object.keys(bundles[bundleId].tools).length === 0) {
      delete bundles[bundleId];
    }
    return sourceId;
  });
};

const dropUnusedSources = (target: LoadedRecord, sourceIds: readonly string[]): void => {
  const { record } = target;
  for (const sourceId of sourceIds) {
    if (!Object.values(record.bundles).some((bundle) => Object.values(bundle.tools).some((entry) => entry.sourceId === sourceId))) {
      delete record.sources[sourceId];
    }
  }
};

// One entry per identity and tool. Profile entries first, the higher version of
// each identity, replacing a lone `unknown` one; then old user lockfile bundles
// nothing holds yet, the higher version of each identity; then the marker.
const planUser = async (run: MigrationRun, target: LoadedRecord, old: OldFile | undefined): Promise<void> => {
  const profileEntries = run.input.profileEntries ?? [];
  const recordedProfile = new Map<string, string>();
  for (const [kept, ...others] of groupByIdentity(profileEntries.map((entry) => ({ entry })))) {
    const { entry } = kept;
    const identity = identityOf(entry);
    if (entriesOfIdentity([target], identity, entry.tool).length > 0) {
      [kept, ...others].forEach((item) => dropEntry(run.report, item.entry));
      continue;
    }
    for (const other of others) {
      run.report.versionConflicts.push({ bundleId: other.entry.bundleId, kept: entry.version, dropped: other.entry.version });
    }
    const held = entriesOfIdentity([target], identity);
    const replacedSources = held.length > 0 && isLoneUnknown(held.map((found) => found.tool)) ? removeUnknown(target, held) : [];
    for (const replaced of new Set(replacedSources.length === 0 ? [] : held.map((found) => found.version))) {
      if (replaced !== entry.version) {
        run.report.versionConflicts.push({ bundleId: entry.bundleId, kept: entry.version, dropped: replaced });
      }
    }
    await addEntry(run, target, entry);
    dropUnusedSources(target, replacedSources);
    recordedProfile.set(identity, entry.version);
  }
  if (profileEntries.length > 0) {
    run.report.mergedFrom.push(PROFILE_STORE_NAME);
  }
  if (old !== undefined) {
    const oldEntries = Object.keys(old.lock.bundles).map((bundleId) => ({ entry: fromOldEntry(old, bundleId) }));
    for (const group of groupByIdentity(oldEntries)) {
      const identity = identityOf(group[0].entry);
      const kept = recordedProfile.get(identity);
      const held = holdsIdentity(run.loaded, identity);
      for (const [index, { entry }] of group.entries()) {
        if (kept !== undefined && kept !== entry.version) {
          run.report.versionConflicts.push({ bundleId: entry.bundleId, kept, dropped: entry.version });
        } else if (held) {
          dropEntry(run.report, entry);
        } else if (index === 0) {
          await addEntry(run, target, entry);
        } else {
          run.report.versionConflicts.push({ bundleId: entry.bundleId, kept: group[0].entry.version, dropped: entry.version });
        }
      }
    }
    run.report.mergedFrom.push(old.path);
  }
  if (target.record[IMPORTED_USER_LOCKFILE_FIELD] === undefined) {
    target.record[IMPORTED_USER_LOCKFILE_FIELD] = run.report.migratedAt;
    run.changed.add(target);
  }
};

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

const readOldUserFile = async (input: MigrationInput, target: LoadedRecord): Promise<OldFile | undefined> => {
  const file = input.oldUserLockfile;
  if (file === undefined || target.record[IMPORTED_USER_LOCKFILE_FIELD] !== undefined || (await input.fs.lstat(file)) === undefined) {
    return undefined;
  }
  return { path: file, origin: 'cli-user-lockfile', lock: await readOldLockfile(input.fs, file), target };
};

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
 * Migrate the old stores of a level into its 3.0.0 records: load everything,
 * plan in memory, save the changed targets, then delete the old repository files.
 * @param input - Migration input.
 * @returns The report, or `undefined` when there was nothing to do.
 * @throws {RegistryError} `RECORD.MALFORMED` for a bad old file (nothing is
 * written), or `RECORD.WRITE_FAILED` from a save or delete.
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

/** Input of {@link migrateLevel}. */
export interface MigrateLevelInput {
  store: RecordStore;
  fs: RecordFs;
  /** Both repository files at one git root, committed first, or the user record. */
  targets: readonly RecordLocation[];
  /** Environment for the CLI's old user lockfile path; read at user level only. */
  env: Record<string, string | undefined>;
  /** User level, extension only: this profile's `RegistryStorage` user entries. */
  profileEntries?: readonly MigratedEntry[];
  now?: () => Date;
}

/**
 * Migrate the level the targets belong to, rooted at their root; the CLI and the extension both use it.
 * @param input - Store, filesystem, targets, environment, profile entries and clock.
 * @throws {RegistryError} As {@link migrateRecords}.
 */
export const migrateLevel = (input: MigrateLevelInput): Promise<MigrationReport | undefined> => {
  const level = input.targets[0].level;
  return migrateRecords({
    store: input.store,
    fs: input.fs,
    level,
    root: input.targets[0].root,
    targets: input.targets,
    ...(level === 'user'
      ? { oldUserLockfile: resolveUserConfigPaths(input.env).userLockfile, profileEntries: input.profileEntries ?? [] }
      : {}),
    now: input.now ?? (() => new Date())
  });
};
