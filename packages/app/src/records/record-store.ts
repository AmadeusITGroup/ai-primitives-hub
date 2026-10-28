/**
 * Install record store: locate, load and atomically save record files
 * (contract C2; BR1.5, BR1.9, BR2.1–BR2.3, BR4.1; NFR1.3, NFR4.1, NFR7.1).
 *
 * `load` runs the four security layers in order and stops at the first
 * failure with a `RECORD.*` error:
 * 1. file gate — a regular file, or a symlink to a regular file inside the
 *    root; read capped at 10 MB + 1 byte;
 * 2. `parseRecord` — prototype-free JSON and the version gate;
 * 3. the schema validator (`RecordSchemaValidator` from infra);
 * 4. every `installedPath` through Layer A and Layer B (`confinePath`), then
 *    every tool entry's `sourceId` must be a key of `sources`.
 *
 * `save` refuses to write a location unless its last `load` succeeded, so a
 * rejected file is never overwritten (BR1.9). It writes a temp file created
 * exclusively in the same folder and renames it over the target (BR4.1); a
 * record that is an allowed symlink keeps its link and has its target
 * replaced. The repository root is the git root (BR2.1), not `AppStorage`,
 * which governs per-user roots only.
 * @module records/record-store
 */
import {
  randomBytes,
} from 'node:crypto';
import * as path from 'node:path';
import {
  type InstallRecord,
  isRecordError,
  LOCAL_RECORD_FILE_NAME,
  parseRecord,
  RECORD_FILE_NAME,
  RECORD_FORMAT_VERSION,
  RECORD_MAX_BYTES,
  RECORD_SCHEMA_URL,
  recordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  type UnvalidatedRecord,
} from '@ai-primitives-hub/core';
import {
  confinePath,
} from './confine-path';
import {
  ensureExcluded,
  resolveRepositoryRoot,
} from './git-root';
import {
  serializeRecord,
} from './serialize-record';

/** Schema gate the store runs after `parseRecord`; `RecordSchemaValidator` in infra implements it. */
export interface RecordValidator {
  /**
   * @param record - Output of `parseRecord`.
   * @param file - Record file to name in the error.
   * @returns The record, typed.
   * @throws {RegistryError} `RECORD.MALFORMED` when the record does not match the schema.
   */
  validate(record: UnvalidatedRecord, file?: string): InstallRecord;
}

/** A loaded record (contract C2). */
export interface LoadedRecord {
  location: RecordLocation;
  /** Parsed and validated record, with prototype-free objects; empty when the file is missing. */
  record: InstallRecord;
  /** `false` when the file is not there yet. */
  exists: boolean;
}

/** Outcome of {@link RecordStore.save}. */
export interface RecordSaveResult {
  /** Non-fatal problems for the caller to log, e.g. an `info/exclude` that could not be updated. */
  warnings: string[];
}

/** Dependencies of a {@link RecordStore}. */
export interface RecordStoreOptions {
  /** Filesystem port; `NodeRecordFs` from infra in production. */
  fs: RecordFs;
  /** Schema gate; `RecordSchemaValidator` from infra in production. */
  validator: RecordValidator;
  /** Writer stamp for `generatedBy`, e.g. `ai-primitives-hub-cli@0.3.0`. */
  generatedBy: string;
  /** Clock for `generatedAt`; defaults to the current time. */
  now?: () => Date;
}

const LARGE_RECORD_HINT = 'The record is larger than 10 MB. Fix or remove the file, then run the command again.';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInside = (realRoot: string, candidate: string): boolean => {
  const relative = path.relative(realRoot, candidate);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

/**
 * Build an empty record for a level.
 * @param level - Record level.
 * @param generatedBy - Writer stamp.
 * @param now - Time to stamp as `generatedAt`.
 * @returns A record with no bundles and no sources, prototype-free.
 */
export const createEmptyRecord = (level: RecordLevel, generatedBy: string, now: Date): InstallRecord => {
  const record = Object.create(null) as InstallRecord;
  record.$schema = RECORD_SCHEMA_URL;
  record.version = RECORD_FORMAT_VERSION;
  record.level = level;
  record.generatedAt = now.toISOString();
  record.generatedBy = generatedBy;
  record.bundles = Object.create(null) as InstallRecord['bundles'];
  record.sources = Object.create(null) as InstallRecord['sources'];
  return record;
};

/** Locates, loads and saves install record files. */
export class RecordStore {
  private readonly fs: RecordFs;
  private readonly validator: RecordValidator;
  private readonly generatedBy: string;
  private readonly now: () => Date;
  /** Paths whose last load succeeded; only these may be saved. */
  private readonly loadedPaths = new Set<string>();

  public constructor(options: RecordStoreOptions) {
    this.fs = options.fs;
    this.validator = options.validator;
    this.generatedBy = options.generatedBy;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Record path relative to its root, for messages.
   * @param location - Record location.
   */
  private labelOf(location: RecordLocation): string {
    const relative = path.relative(location.root, location.path);
    return relative === '' || relative.startsWith('..') ? location.path : relative.split(path.sep).join('/');
  }

  /**
   * File gate (NFR1.3).
   * @param location - Record location.
   * @param file - Record file to name in errors.
   * @returns The path to read, or `undefined` when nothing is there.
   */
  private async gateRecordFile(location: RecordLocation, file: string): Promise<string | undefined> {
    const stat = await this.fs.lstat(location.path);
    if (stat === undefined) {
      return undefined;
    }
    if (stat.kind === 'symlink') {
      const target = await this.resolveAllowedLink(location, file);
      if ((await this.fs.lstat(target))?.kind !== 'file') {
        throw recordError('RECORD.MALFORMED', { file, detail: 'not a regular file (symlink target)' });
      }
      return target;
    }
    if (stat.kind !== 'file') {
      throw recordError('RECORD.MALFORMED', { file, detail: 'not a regular file' });
    }
    return location.path;
  }

  /**
   * Realpath of a record symlink, required to be inside the root.
   * @param location - Record location.
   * @param file - Record file to name in errors.
   */
  private async resolveAllowedLink(location: RecordLocation, file: string): Promise<string> {
    let target: string;
    let realRoot: string;
    try {
      target = await this.fs.realpath(location.path);
      realRoot = await this.fs.realpath(location.root);
    } catch (error) {
      throw recordError('RECORD.MALFORMED', { file, detail: 'symlink does not resolve', cause: error });
    }
    if (!isInside(realRoot, target)) {
      throw recordError('RECORD.MALFORMED', { file, detail: 'symlink target is outside the root' });
    }
    return target;
  }

  private async readAndCheck(location: RecordLocation, readPath: string, file: string): Promise<InstallRecord> {
    const bytes = await this.fs.readCapped(readPath, RECORD_MAX_BYTES + 1);
    if (bytes.byteLength > RECORD_MAX_BYTES) {
      throw recordError('RECORD.MALFORMED', { file, detail: 'record larger than 10 MB', hint: LARGE_RECORD_HINT });
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw recordError('RECORD.MALFORMED', { file, detail: 'not valid UTF-8', cause: error });
    }
    const record = this.validator.validate(parseRecord(text, file), file);
    await this.checkPaths(location, record, file);
    this.checkSourceIds(record, file);
    return record;
  }

  /**
   * Layers A and B on every recorded path (BR1.5); one failure stops the load.
   * @param location - Record location.
   * @param record - Record being checked or written.
   * @param file - Record file to name in errors.
   */
  private async checkPaths(location: RecordLocation, record: InstallRecord, file: string): Promise<void> {
    for (const bundle of Object.values(record.bundles)) {
      for (const entry of Object.values(bundle.tools)) {
        for (const recorded of entry.files) {
          await confinePath(this.fs, location.root, recorded.installedPath, file);
        }
      }
    }
  }

  /**
   * Every tool entry's `sourceId` must be a key of `sources` (C1).
   * @param record - Record being checked or written.
   * @param file - Record file to name in errors.
   */
  private checkSourceIds(record: InstallRecord, file: string): void {
    for (const [bundleId, bundle] of Object.entries(record.bundles)) {
      for (const [tool, entry] of Object.entries(bundle.tools)) {
        if (!Object.hasOwn(record.sources, entry.sourceId)) {
          throw recordError('RECORD.MALFORMED', {
            file,
            detail: `bundles.${bundleId}.tools.${tool}.sourceId ${JSON.stringify(entry.sourceId)} is not a key of sources`
          });
        }
      }
    }
  }

  /**
   * Prototype-free shallow copy with the writer fields set.
   * @param location - Record location.
   * @param record - Record being checked or written.
   */
  private stamp(location: RecordLocation, record: InstallRecord): InstallRecord {
    const stamped = Object.create(null) as InstallRecord;
    for (const key of Object.keys(record)) {
      stamped[key] = record[key];
    }
    stamped.version = RECORD_FORMAT_VERSION;
    stamped.level = location.level;
    stamped.generatedAt = this.now().toISOString();
    stamped.generatedBy = this.generatedBy;
    if (!isObject(stamped.bundles)) {
      stamped.bundles = Object.create(null) as InstallRecord['bundles'];
    }
    if (!isObject(stamped.sources)) {
      stamped.sources = Object.create(null) as InstallRecord['sources'];
    }
    return stamped;
  }

  /**
   * Temp file created exclusively beside the target, then renamed over it (BR4.1, NFR7.1).
   * @param location - Record location.
   * @param text - Serialized record.
   * @param file - Record file to name in errors.
   */
  private async writeAtomically(location: RecordLocation, text: string, file: string): Promise<void> {
    let target = location.path;
    let temp: string | undefined;
    try {
      if ((await this.fs.lstat(location.path))?.kind === 'symlink') {
        target = await this.resolveAllowedLink(location, file);
      }
      temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      await this.fs.writeFile(temp, text);
      await this.fs.rename(temp, target);
    } catch (error) {
      if (temp !== undefined) {
        await this.fs.unlink(temp).catch(() => undefined);
      }
      if (isRecordError(error)) {
        throw error;
      }
      throw recordError('RECORD.WRITE_FAILED', { file, cause: error });
    }
  }

  /**
   * Both repository record locations for a start folder (BR2.1, BR2.2).
   * @param input - Where the git-root walk starts.
   * @param input.start - The target's root path, or the current folder.
   * @returns The committed location, then the local-only one, at the git root (or `start` without one).
   */
  public async resolveRepository(input: { start: string }): Promise<[RecordLocation, RecordLocation]> {
    const root = await resolveRepositoryRoot(this.fs, input.start);
    return [
      { level: 'repository', root, path: path.join(root, RECORD_FILE_NAME), commitMode: 'commit' },
      { level: 'repository', root, path: path.join(root, LOCAL_RECORD_FILE_NAME), commitMode: 'local-only' }
    ];
  }

  /**
   * Load and check a record file (workflow W3). A missing file gives an empty record.
   * @param location - Where the record lives.
   * @returns The loaded record.
   * @throws {RegistryError} `RECORD.MALFORMED`, `RECORD.NEWER_FORMAT`,
   * `RECORD.LEGACY_UNMIGRATED` or `RECORD.PATH_OUTSIDE_ROOT`; the file is left untouched.
   */
  public async load(location: RecordLocation): Promise<LoadedRecord> {
    this.loadedPaths.delete(location.path);
    const file = this.labelOf(location);
    try {
      const readPath = await this.gateRecordFile(location, file);
      const loaded: LoadedRecord = readPath === undefined
        ? { location, record: createEmptyRecord(location.level, this.generatedBy, this.now()), exists: false }
        : { location, record: await this.readAndCheck(location, readPath, file), exists: true };
      this.loadedPaths.add(location.path);
      return loaded;
    } catch (error) {
      if (isRecordError(error)) {
        throw error;
      }
      throw recordError('RECORD.MALFORMED', { file, detail: 'the file could not be read', cause: error });
    }
  }

  /**
   * Write a record atomically (BR4.1). Stamps `version`, `level`,
   * `generatedAt` and `generatedBy`, validates, and serializes canonically.
   * @param location - Where the record lives; must have been loaded successfully first.
   * @param record - Record to write; left unchanged.
   * @returns Warnings for the caller to log.
   * @throws {RegistryError} `RECORD.MALFORMED` when the location's last load
   * failed or never happened, or the record does not match the schema;
   * `RECORD.WRITE_FAILED` when the write or rename fails (the previous file is intact).
   */
  public async save(location: RecordLocation, record: InstallRecord): Promise<RecordSaveResult> {
    const file = this.labelOf(location);
    if (!this.loadedPaths.has(location.path)) {
      throw recordError('RECORD.MALFORMED', { file, detail: 'the record was not loaded successfully, so it is not overwritten' });
    }
    const stamped = this.stamp(location, record);
    this.validator.validate(stamped, file);
    const text = serializeRecord(stamped);
    await this.writeAtomically(location, text, file);
    const warnings: string[] = [];
    if (location.level === 'repository' && location.commitMode === 'local-only') {
      const exclude = await ensureExcluded(this.fs, location.root, path.basename(location.path));
      if (exclude.warning !== undefined) {
        warnings.push(exclude.warning);
      }
    }
    return { warnings };
  }
}
