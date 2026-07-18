/**
 * Type guard utilities for runtime type checking
 * Provides safe type validation for external data
 */

import {
  BundleUpdate,
} from '../types/registry';

/**
 * Type guard for array validation
 * @param value
 */
export function isArray<T>(value: unknown): value is T[] {
  return Array.isArray(value);
}

/**
 * Type guard for BundleUpdate array
 * @param value
 */
export function isBundleUpdateArray(value: unknown): value is BundleUpdate[] {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((item) =>
    typeof item === 'object'
    && item !== null
    && typeof item.bundleId === 'string'
    && typeof item.currentVersion === 'string'
    && typeof item.latestVersion === 'string'
  );
}

/**
 * Type guard for source array
 * @param value
 */
export function isSourceArray(value: unknown): value is { id: string; type: string; name: string }[] {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((item) =>
    typeof item === 'object'
    && item !== null
    && typeof item.id === 'string'
    && typeof item.type === 'string'
    && typeof item.name === 'string'
  );
}

/**
 * Convert unknown error to Error object
 * @param error
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    return new Error(String(error.message));
  }

  return new Error('Unknown error occurred');
}

/**
 * Type guard for string validation
 * @param value
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Type guard for non-empty string validation
 * @param value
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
