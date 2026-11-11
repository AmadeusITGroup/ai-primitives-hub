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

/**
 * The key of a versioned id at another version, with the same `-` or `-v` form; any other id is kept.
 * @param bundleId - Recorded key.
 * @param version - Version recorded for it.
 * @param nextVersion - Version now installed.
 */
export const recordKeyForVersion = (bundleId: string, version: string, nextVersion: string): string => {
  const identity = recordIdentityOf(bundleId, version);
  if (identity === bundleId || nextVersion === version) {
    return bundleId;
  }
  const marker = bundleId.slice(identity.length) === `-v${version}` ? '-v' : '-';
  const next = `${identity}${marker}${nextVersion}`;
  // A key the identity rule cannot match back would leave the old entry behind.
  return recordIdentityOf(next, nextVersion) === identity ? next : bundleId;
};
