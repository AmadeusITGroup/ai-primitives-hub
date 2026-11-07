/**
 * Prototype-free parsing and the version gate for install records. Forbidden
 * keys are refused at any depth and every object gets a `null` prototype; the
 * schema check runs afterwards in `infra`.
 * @module domain/install/record-parse
 */
import {
  isRegistryError,
} from '../registry-error';
import {
  recordError,
} from './record-errors';
import {
  isJsonObject,
  nullPrototypeCopy,
} from './record-object';
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

/**
 * Prototype-free `JSON.parse` (security layer 2, NFR4.4): a reviver refuses
 * `__proto__`, `constructor` and `prototype` at any depth and rebuilds every
 * object with a `null` prototype. No version or shape check: the record store
 * runs {@link parseRecord} on top of it, and record migration uses it for the
 * old 2.0.0 lockfiles.
 * @param text - File contents, decoded as UTF-8.
 * @param file - File to name in errors, if any.
 * @returns The parsed value, with prototype-free objects throughout.
 * @throws {RegistryError} `RECORD.MALFORMED` for invalid JSON or a forbidden key at any depth.
 */
export const parseJsonWithoutPrototypes = (text: string, file?: string): unknown => {
  try {
    return JSON.parse(text, (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) {
        throw recordError('RECORD.MALFORMED', { file, detail: `forbidden key ${key}` });
      }
      return isJsonObject(value) ? nullPrototypeCopy(value) : value;
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
 * Parse an `ai-primitives-hub.*` record file and check its major version is 3.
 * @param text - File contents.
 * @param file - Record file to name in errors, if any.
 * @throws {RegistryError} `RECORD.MALFORMED`, `RECORD.NEWER_FORMAT` or `RECORD.LEGACY_UNMIGRATED`.
 */
export const parseRecord = (text: string, file?: string): UnvalidatedRecord => {
  const parsed = parseJsonWithoutPrototypes(text, file);
  if (!isJsonObject(parsed)) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'top level is not an object' });
  }
  checkVersion(parsed.version, file);
  return parsed as UnvalidatedRecord;
};
