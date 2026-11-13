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

/** Keys written first, in this order, at each level of the record; the rest follow sorted. */
const KEY_ORDER = {
  top: ['$schema', 'version', 'level', 'generatedAt', 'generatedBy', 'hubs', 'sources', 'bundles'],
  bundle: ['name', 'tools'],
  entry: ['version', 'bundleId', 'sourceId', 'sourceType', 'installedAt', 'installationId', 'integrity', 'root', 'needsReinstall', 'files', 'plugins', 'mcpServers'],
  file: ['path', 'checksum', 'sourcePath', 'mode']
} as const;

// Copy with the given keys first, in that order, then the others in sorted order.
const ordered = (value: unknown, first: readonly string[]): unknown => {
  if (!isJsonObject(value)) {
    return value;
  }
  const copy = Object.create(null) as JsonObject;
  for (const key of [...first.filter((name) => Object.hasOwn(value, name)), ...Object.keys(value).filter((other) => !first.includes(other))]) {
    copy[key] = value[key];
  }
  return copy;
};

const orderRecordKeys = (record: InstallRecord): JsonObject => {
  const top = ordered(record, KEY_ORDER.top) as JsonObject;
  if (isJsonObject(top.bundles)) {
    for (const [key, bundle] of Object.entries(top.bundles)) {
      const bundleCopy = ordered(bundle, KEY_ORDER.bundle) as JsonObject;
      if (isJsonObject(bundleCopy.tools)) {
        for (const [tool, entry] of Object.entries(bundleCopy.tools)) {
          const entryCopy = ordered(entry, KEY_ORDER.entry) as JsonObject;
          if (Array.isArray(entryCopy.files)) {
            entryCopy.files = (entryCopy.files as unknown[]).map((file) => ordered(file, KEY_ORDER.file));
          }
          bundleCopy.tools[tool] = entryCopy;
        }
      }
      top.bundles[key] = bundleCopy;
    }
  }
  return top;
};

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
 * Serialize a record canonically: the record's main fields first in a fixed
 * order, the others sorted, two-space indentation, trailing newline.
 * @param record - Record to write.
 * @throws {RegistryError} `RECORD.MALFORMED` when a forbidden key appears at any depth.
 */
export const serializeRecord = (record: InstallRecord): string =>
  `${JSON.stringify(orderRecordKeys(canonicalizeRecord(record)), null, 2)}\n`;
