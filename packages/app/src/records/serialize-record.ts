/**
 * Canonical serialization of install records, shared by the CLI and the
 * extension so the same content always gives the same bytes.
 * @module records/serialize-record
 */
import {
  compareCodeUnits,
  FORBIDDEN_KEYS,
  type InstallRecord,
  isJsonObject,
  RECORD_SCHEMA_URL,
  recordError,
} from '@ai-primitives-hub/core';

type JsonObject = Record<string, unknown>;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const copy = Object.create(null) as JsonObject;
  for (const key of Object.keys(value).toSorted(compareCodeUnits)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw recordError('RECORD.MALFORMED', { detail: `forbidden key ${key}` });
    }
    copy[key] = canonicalize(value[key]);
  }
  return copy;
};

const filePathOf = (file: unknown): string =>
  isJsonObject(file) && typeof file.path === 'string' ? file.path : '';

const sortEntryFiles = (record: JsonObject): void => {
  const bundles = isJsonObject(record.bundles) ? record.bundles : undefined;
  for (const bundle of Object.values(bundles ?? {})) {
    const tools = isJsonObject(bundle) && isJsonObject(bundle.tools) ? bundle.tools : undefined;
    for (const entry of Object.values(tools ?? {})) {
      if (isJsonObject(entry) && Array.isArray(entry.files)) {
        entry.files = (entry.files as unknown[]).toSorted((left, right) => compareCodeUnits(filePathOf(left), filePathOf(right)));
      }
    }
  }
};

/**
 * Deep, prototype-free copy with sorted keys and files and the canonical `$schema`.
 * @param record - Record to copy; left unchanged.
 * @throws {RegistryError} `RECORD.MALFORMED` when a forbidden key appears at any depth.
 */
export const canonicalizeRecord = (record: InstallRecord): InstallRecord => {
  const copy = canonicalize(record) as JsonObject;
  sortEntryFiles(copy);
  copy.$schema = RECORD_SCHEMA_URL;
  // Rebuild so `$schema` sits in sorted position even when the input had none.
  const result = Object.create(null) as JsonObject;
  for (const key of Object.keys(copy).toSorted(compareCodeUnits)) {
    result[key] = copy[key];
  }
  return result as InstallRecord;
};

/**
 * Serialize a record canonically: sorted keys, two-space indentation, trailing newline.
 * @param record - Record to write.
 * @throws {RegistryError} `RECORD.MALFORMED` when a forbidden key appears at any depth.
 */
export const serializeRecord = (record: InstallRecord): string =>
  `${JSON.stringify(canonicalizeRecord(record), null, 2)}\n`;
