/**
 * Install record store: locate, load and atomically save record files.
 *
 * `load` checks the file type and size, parses, validates the schema, then
 * confines every recorded path. `save` only writes a location whose last load
 * succeeded, so a rejected file is never overwritten. The repository root is
 * the git root, not `AppStorage`.
 * @module records/record-store
 */
import * as path from 'node:path';
import {
  type InstallRecord,
  isJsonObject,
  isRecordError,
  nullPrototypeCopy,
  parseRecord,
  RECORD_FORMAT_VERSION,
  RECORD_MAX_BYTES,
  RECORD_SCHEMA_URL,
  recordError,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  relativeInside,
  repositoryLocations,
  type UnvalidatedRecord,
} from '@ai-primitives-hub/core';
import {
  writeFileAtomically,
} from './atomic-write';
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
  /** @throws {RegistryError} `RECORD.MALFORMED` when the record does not match the schema. */
  validate(record: UnvalidatedRecord, file?: string): InstallRecord;
}

/** A loaded record. */
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

/**
 * Build an empty, prototype-free record for a level.
 * @param level - Record level.
 * @param generatedBy - Writer stamp.
 * @param now - Time stamped as `generatedAt`.
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
    return relativeInside(location.root, location.path) ?? location.path;
  }

  /**
   * The path to read: a regular file, or a symlink to one inside the root; `undefined` when missing.
   * @param location - Record location.
   * @param file - Record file to name in errors.
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
    if (relativeInside(realRoot, target) === undefined) {
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
   * Confine every recorded path; one failure stops the load.
   * @param location - Record location.
   * @param record - Record to check.
   * @param file - Record file to name in errors.
   */
  private async checkPaths(location: RecordLocation, record: InstallRecord, file: string): Promise<void> {
    for (const bundle of Object.values(record.bundles)) {
      for (const entry of Object.values(bundle.tools)) {
        for (const recorded of entry.files) {
          await confinePath(this.fs, location.root, recorded.path, file);
        }
      }
    }
  }

  /**
   * Every tool entry's `sourceId` must be a key of `sources`.
   * @param record - Record to check.
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
   * @param record - Record to write.
   */
  private stamp(location: RecordLocation, record: InstallRecord): InstallRecord {
    const stamped = nullPrototypeCopy(record);
    stamped.version = RECORD_FORMAT_VERSION;
    stamped.level = location.level;
    stamped.generatedAt = this.now().toISOString();
    stamped.generatedBy = this.generatedBy;
    if (!isJsonObject(stamped.bundles)) {
      stamped.bundles = Object.create(null) as InstallRecord['bundles'];
    }
    if (!isJsonObject(stamped.sources)) {
      stamped.sources = Object.create(null) as InstallRecord['sources'];
    }
    return stamped;
  }

  /**
   * Write atomically; an allowed symlink keeps its link and has its target replaced.
   * @param location - Record location.
   * @param text - Serialized record.
   * @param file - Record file to name in errors.
   */
  private async writeAtomically(location: RecordLocation, text: string, file: string): Promise<void> {
    try {
      const target = (await this.fs.lstat(location.path))?.kind === 'symlink'
        ? await this.resolveAllowedLink(location, file)
        : location.path;
      await writeFileAtomically(this.fs, target, text);
    } catch (error) {
      if (isRecordError(error)) {
        throw error;
      }
      throw recordError('RECORD.WRITE_FAILED', { file, cause: error });
    }
  }

  /**
   * Both repository record locations at the git root above `start` (or `start` itself), committed first.
   * @param input - Where the git-root walk starts.
   * @param input.start - Target root, or the current folder.
   */
  public async resolveRepository(input: { start: string }): Promise<[RecordLocation, RecordLocation]> {
    const root = await resolveRepositoryRoot(this.fs, input.start);
    return repositoryLocations(root);
  }

  /**
   * Load and check a record file. A missing file gives an empty record.
   * @param location - Record location.
   * @throws {RegistryError} A `RECORD.*` error; the file is left untouched.
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
   * Stamp, validate and atomically write a record whose location was loaded first.
   * @param location - Record location.
   * @param record - Record to write; left unchanged.
   * @throws {RegistryError} `RECORD.MALFORMED` or `RECORD.WRITE_FAILED`; the previous file is intact.
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
