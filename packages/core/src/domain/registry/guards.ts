/**
 * Runtime type guards for registry data crossing an untyped boundary
 * (a `RegistryManager`-shaped orchestrator's return value, cache
 * deserialization, ...).
 *
 * Ported from the extension's `src/utils/type-guards.ts`
 * (`isBundleUpdateArray`/`isSourceArray`) — pure, no `vscode` dependency
 * in the original either, moved here so `app`'s update use cases can
 * validate `UpdateRegistryReader`'s return values the same way the
 * extension's `UpdateChecker` already does.
 * @module domain/registry/guards
 */
import type {
  BundleUpdate,
} from '../bundle/types';

/**
 * Type guard for a `BundleUpdate[]`.
 * @param value - Value to check.
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
    && typeof item.latestVersion === 'string');
}

/**
 * Type guard for a minimal source array (id/type/name present).
 * @param value - Value to check.
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
    && typeof item.name === 'string');
}
