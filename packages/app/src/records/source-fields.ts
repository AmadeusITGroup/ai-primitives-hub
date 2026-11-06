/**
 * The optional fields of a recorded source (contract C1) and the one copy
 * loop every record source builder uses: the sanitizer, the trust gate and
 * {@link toRecordSource}. Internal to `records`; not exported from the barrel.
 * @module records/source-fields
 */
import type {
  SourceRecord,
} from '@ai-primitives-hub/core';

/** Optional C1 string fields of a recorded source, in addition to `type` and `url`. */
export const SOURCE_FIELDS = ['branch', 'collectionsPath', 'indexFile', 'authMode', 'credentialRef'] as const;

/** The optional fields kept from a record's own copy of a source: never `authMode` or `credentialRef` (NFR4.11). */
export const SOURCE_FIELDS_WITHOUT_CREDENTIALS = ['branch', 'collectionsPath', 'indexFile'] as const;

/** One optional C1 field name. */
export type SourceField = typeof SOURCE_FIELDS[number];

/**
 * A prototype-free `SourceRecord` with `type` and `url`, and each listed
 * field of `from` that is a string. Any other field is dropped.
 * @param from - Object to copy the optional fields from.
 * @param type - Source type.
 * @param url - Source URL.
 * @param fields - Optional fields to copy.
 * @returns The new source.
 */
export const copySourceFields = (
  from: Readonly<Record<string, unknown>> | undefined,
  type: string,
  url: string,
  fields: readonly SourceField[]
): SourceRecord => {
  const source = Object.create(null) as SourceRecord;
  source.type = type;
  source.url = url;
  for (const field of fields) {
    const value = from?.[field];
    if (typeof value === 'string') {
      source[field] = value;
    }
  }
  return source;
};
