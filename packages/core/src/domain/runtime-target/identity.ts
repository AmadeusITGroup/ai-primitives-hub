/**
 * Structured, collision-safe identities for runtime-target domain objects.
 * Keys are JSON tuples — no delimiter/path injection is possible. Pure.
 * @module domain/runtime-target/identity
 */
import * as path from 'node:path';
import {
  TARGET_TYPES,
  type TargetType,
} from '../install/target';
import type {
  RuntimeCollectionId,
  RuntimeSelection,
  RuntimeTargetInstance,
  RuntimeTargetScope,
} from './types';

/**
 * Structured key for a collection (sourceId + manifestId).
 * @param collection
 */
export function collectionKey(collection: RuntimeCollectionId): string {
  return JSON.stringify([collection.sourceId, collection.manifestId]);
}

/**
 * Structured key for a target instance (type + scope + canonical root).
 * @param instance
 */
export function instanceKey(instance: RuntimeTargetInstance): string {
  return JSON.stringify([instance.type, instance.scope, instance.root]);
}

/**
 * Structured key for a receipt (instance + collection).
 * @param instance
 * @param collection
 */
export function receiptKey(instance: RuntimeTargetInstance, collection: RuntimeCollectionId): string {
  return JSON.stringify([instance.type, instance.scope, instance.root, collection.sourceId, collection.manifestId]);
}

const UNSAFE_ID = /[/\\\0]|^\.\.?$|^\.{2,}/u;

/**
 * Whether an id segment can never escape or alias another identity.
 * @param value
 */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !UNSAFE_ID.test(value)
    && !/[<>:"|?*]/u.test(value);
}

/**
 * Whether a bundle/state relative path stays inside its root.
 * @param value
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return false;
  }
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    return false;
  }
  if (/^[a-zA-Z]:/u.test(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

/**
 * Whether a path is an absolute path candidate (not necessarily canonical).
 * @param value
 */
export function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string'
    && path.isAbsolute(value)
    && !value.includes('\0')
    && value.length <= 8192;
}

/**
 * Identity helper.
 @param value
 */
export function isTargetType(value: unknown): value is TargetType {
  return typeof value === 'string' && (TARGET_TYPES as readonly string[]).includes(value);
}

/**
 * Identity helper.
 @param value
 */
export function isRuntimeScope(value: unknown): value is RuntimeTargetScope {
  return value === 'user' || value === 'repository';
}

/**
 * Validate a persisted selection record.
 * @param value
 */
export function isRuntimeSelection(value: unknown): value is RuntimeSelection {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  // Harness type only; legacy persisted scope/path are ignored on read and
  // dropped on the next save.
  return isTargetType(v.type);
}
