/**
 * CLI argument parsing utilities with type-safe validation.
 *
 * Provides typed parsers for common CLI argument patterns like CSV lists
 * and enum validation.
 * @module framework/parsers
 */

import type {
  PrimitiveKind,
} from '@ai-primitives-hub/core';
import {
  PRIMITIVE_KINDS,
} from '@ai-primitives-hub/core';

/**
 * Parse a comma-separated string into an array of trimmed strings.
 * Returns undefined if the input is undefined.
 * @param raw - Raw CSV string or undefined.
 * @returns Trimmed array or undefined.
 */
export const parseCsv = (raw: string | undefined): string[] | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
};

/**
 * Parse a comma-separated string into an array of validated enum values.
 * Returns undefined if the input is undefined.
 * Throws an error if any value is not in the allowed enum values.
 * @param raw - Raw CSV string or undefined.
 * @param enumValues - Readonly array of allowed enum values.
 * @param enumName - Name of the enum for error messages.
 * @returns Array of validated enum values or undefined.
 */
export const parseCsvEnum = <T extends string>(
  raw: string | undefined,
  enumValues: readonly T[],
  enumName: string
): T[] | undefined => {
  const parsed = parseCsv(raw);
  if (parsed === undefined) {
    return undefined;
  }

  const invalid = parsed.filter((v) => !enumValues.includes(v as T));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid ${enumName} value(s): ${invalid.join(', ')}. `
      + `Valid values: ${enumValues.join(', ')}`
    );
  }

  return parsed as T[];
};

/**
 * Parse a comma-separated string into PrimitiveKind array.
 * Validates that all values are valid PrimitiveKind enum values.
 * @param raw - Raw CSV string or undefined.
 * @returns Array of PrimitiveKind values or undefined.
 */
export const parseCsvKinds = (raw: string | undefined): PrimitiveKind[] | undefined => {
  return parseCsvEnum(raw, PRIMITIVE_KINDS, 'PrimitiveKind');
};

/**
 * Parse a comma-separated string into a non-empty array.
 * Returns undefined if the input is undefined or results in an empty array.
 * @param raw - Raw CSV string or undefined.
 * @returns Non-empty array or undefined.
 */
export const parseCsvNonEmpty = (raw: string | undefined): string[] | undefined => {
  const parsed = parseCsv(raw);
  if (parsed === undefined || parsed.length === 0) {
    return undefined;
  }
  return parsed;
};
