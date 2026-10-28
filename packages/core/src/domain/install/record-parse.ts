/**
 * Prototype-free parsing and the version gate for install records
 * (security layer 2: NFR1.1, NFR1.2, NFR4.4; BR1.8, BR1.9, BR1.10).
 *
 * `JSON.parse` runs with a reviver that refuses `__proto__`, `constructor`
 * and `prototype` at any depth and rebuilds every object with
 * `Object.create(null)`, so a hostile record can never reach
 * `Object.prototype`. The major version is checked before the schema: only
 * major 3 is returned, for the schema gate (`RecordSchemaValidator` in
 * `infra`) to validate next. Unknown fields are kept.
 * @module domain/install/record-parse
 */
import {
  isRegistryError,
} from '../registry-error';
import {
  recordError,
} from './record-errors';
import {
  FORBIDDEN_KEYS,
  RECORD_FORMAT_MAJOR,
} from './record-types';

const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * A parsed record that passed the version gate but not yet the schema gate.
 * Every object in it has a `null` prototype.
 */
export interface UnvalidatedRecord {
  readonly version: string;
  readonly [key: string]: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNullPrototype = (value: Record<string, unknown>): Record<string, unknown> => {
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    copy[key] = value[key];
  }
  return copy;
};

const parseJson = (text: string, file: string | undefined): unknown => {
  try {
    return JSON.parse(text, (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) {
        throw recordError('RECORD.MALFORMED', { file, detail: `forbidden key ${key}` });
      }
      return isPlainObject(value) ? toNullPrototype(value) : value;
    });
  } catch (error) {
    if (isRegistryError(error)) {
      throw error;
    }
    // The SyntaxError message can quote file contents, so it stays in `cause` only.
    throw recordError('RECORD.MALFORMED', { file, detail: 'not valid JSON', cause: error });
  }
};

const checkVersion = (version: unknown, file: string | undefined): void => {
  if (version === undefined) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'missing version' });
  }
  if (typeof version !== 'string') {
    throw recordError('RECORD.MALFORMED', { file, detail: 'version is not a string' });
  }
  const match = SEMVER_CORE.exec(version);
  if (match === null) {
    throw recordError('RECORD.MALFORMED', { file, detail: `version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH` });
  }
  const major = Number(match[1]);
  if (major > RECORD_FORMAT_MAJOR) {
    throw recordError('RECORD.NEWER_FORMAT', { file, detail: `format ${version}` });
  }
  if (major < RECORD_FORMAT_MAJOR) {
    throw recordError('RECORD.LEGACY_UNMIGRATED', { file, detail: `format ${version}` });
  }
};

/**
 * Parse the text of a new-named record file and apply the version gate.
 *
 * Only call this for `ai-primitives-hub.*` record files: a major version
 * below 3 under a new name is refused as unmigrated.
 * @param text - File contents, decoded as UTF-8.
 * @param file - Record file to name in errors, if any.
 * @returns The parsed record, with prototype-free objects throughout.
 * @throws {RegistryError} `RECORD.MALFORMED` for invalid JSON, a forbidden key at
 * any depth, a non-object top level, or a missing, non-string or non-semver
 * version; `RECORD.NEWER_FORMAT` above major 3; `RECORD.LEGACY_UNMIGRATED` below it.
 */
export const parseRecord = (text: string, file?: string): UnvalidatedRecord => {
  const parsed = parseJson(text, file);
  if (!isPlainObject(parsed)) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'top level is not an object' });
  }
  checkVersion(parsed.version, file);
  return parsed as UnvalidatedRecord;
};
