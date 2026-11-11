/**
 * The optional fields of a recorded source and the copy every record source
 * builder uses. Internal to `records`.
 * @module records/source-fields
 */
import type {
  SourceRecord,
} from '@ai-primitives-hub/core';

/** Optional string fields of a recorded source, in addition to `type` and `url`. */
export const SOURCE_FIELDS = ['branch', 'collectionsPath', 'indexFile', 'authMode', 'credentialRef'] as const;

/** The optional fields kept from a record's own copy of a source: never `authMode` or `credentialRef`. */
export const SOURCE_FIELDS_WITHOUT_CREDENTIALS = ['branch', 'collectionsPath', 'indexFile'] as const;

/** One optional source field name. */
export type SourceField = typeof SOURCE_FIELDS[number];

/**
 * A prototype-free `SourceRecord` with `type`, `url` and each listed string field of `from`.
 * @param from - Object to copy the optional fields from.
 * @param type - Source type.
 * @param url - Source URL.
 * @param fields - Optional fields to copy.
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
