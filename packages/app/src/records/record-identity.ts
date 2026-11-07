/**
 * Bundle identity of a record key: the key without its version, so a tool
 * keeps one entry per bundle in a record level.
 * @module records/record-identity
 */
import {
  bundleIdentityOf,
} from '@ai-primitives-hub/core';

/**
 * Identity of a recorded key; an id past the helper's length guard is its own identity.
 * @param bundleId - Recorded key.
 * @param version - Version recorded for it.
 */
export const recordIdentityOf = (bundleId: string, version: string): string => {
  try {
    return bundleIdentityOf(bundleId, version);
  } catch {
    return bundleId;
  }
};

