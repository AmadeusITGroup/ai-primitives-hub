/**
 * Canonical serialization of install records (BR1.11, FR1.6).
 *
 * The CLI and the extension both write records through this one function, so
 * the same content always gives the same bytes: keys sorted at every depth,
 * each tool entry's `files` sorted by `installedPath`, two-space indentation,
 * a trailing newline, and `$schema` set to the canonical URL. The copy it
 * builds uses prototype-free objects only and refuses forbidden keys, so a
 * hostile key can neither pollute a prototype nor reach the file (NFR4.4).
 * @module records/serialize-record
 */
import {
  FORBIDDEN_KEYS,
  type InstallRecord,
  RECORD_SCHEMA_URL,
  recordError,
} from '@ai-primitives-hub/core';

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Code-unit order, independent of locale.
 * @param left - First text.
 * @param right - Second text.
 */
const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isObject(value)) {
    return value;
  }
  const copy = Object.create(null) as JsonObject;
  for (const key of Object.keys(value).toSorted(compareText)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw recordError('RECORD.MALFORMED', { detail: `forbidden key ${key}` });
    }
    copy[key] = canonicalize(value[key]);
  }
  return copy;
};

const installedPathOf = (file: unknown): string =>
  isObject(file) && typeof file.installedPath === 'string' ? file.installedPath : '';

const sortEntryFiles = (record: JsonObject): void => {
  const bundles = isObject(record.bundles) ? record.bundles : undefined;
  for (const bundle of Object.values(bundles ?? {})) {
    const tools = isObject(bundle) && isObject(bundle.tools) ? bundle.tools : undefined;
    for (const entry of Object.values(tools ?? {})) {
      if (isObject(entry) && Array.isArray(entry.files)) {
        entry.files = (entry.files as unknown[]).toSorted((left, right) => compareText(installedPathOf(left), installedPathOf(right)));
      }
    }
  }
};

/**
 * Build the canonical, prototype-free copy of a record.
 * @param record - Record to copy; left unchanged.
 * @returns A deep copy with sorted keys and files and the canonical `$schema`.
 * @throws {RegistryError} `RECORD.MALFORMED` when a forbidden key appears at any depth.
 */
export const canonicalizeRecord = (record: InstallRecord): InstallRecord => {
  const copy = canonicalize(record) as JsonObject;
  sortEntryFiles(copy);
  copy.$schema = RECORD_SCHEMA_URL;
  // Rebuild so `$schema` sits in sorted position even when the input had none.
  const result = Object.create(null) as JsonObject;
  for (const key of Object.keys(copy).toSorted(compareText)) {
    result[key] = copy[key];
  }
  return result as InstallRecord;
};

/**
 * Serialize a record in the one canonical form both delivery layers write.
 * @param record - Record to write.
 * @returns JSON text with sorted keys, two-space indentation and a trailing newline.
 * @throws {RegistryError} `RECORD.MALFORMED` when a forbidden key appears at any depth.
 */
export const serializeRecord = (record: InstallRecord): string =>
  `${JSON.stringify(canonicalizeRecord(record), null, 2)}\n`;
