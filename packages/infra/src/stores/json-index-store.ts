/**
 * JSON persistence for the primitive index.
 *
 * Ported unchanged from the reference branch's
 * `infra/src/stores/json-index-store.ts`. Note: this is the only file
 * ported from the reference's `stores/*` module for now — the rest
 * (`active-hub-store.ts`, `json-lockfile-store.ts`, `layout-config-store.ts`,
 * `profile-activation-store.ts`, `target-state-store.ts`, `target-store.ts`,
 * `yaml-hub-store.ts`) are hub/profile/lockfile/target-state concerns for
 * later phases (install pipeline, target writers), out of scope for the
 * Phase 3b harvest/search port.
 * @module stores/json-index-store
 */

import {
  randomUUID,
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PrimitiveIndex,
} from '../search/primitive-index';

/**
 * Serialise the index as pretty JSON to disk, creating parent dirs as needed.
 * @param idx - Index to serialise.
 * @param filePath - Destination file path.
 */
export function saveIndex(idx: PrimitiveIndex, filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temporaryPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(idx.toJSON(), null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Parsed-index cache keyed by absolute path. A persisted index can be tens of
 * megabytes (dense embeddings), and `fromJSON` rebuilds every `Float32Array`,
 * so re-reading it on each search made interactive search (one search per
 * keystroke) noticeably laggy. The cache is invalidated by file identity
 * (mtime + size): {@link saveIndex} writes to a temp file and renames it into
 * place, so any rebuild changes the mtime and evicts the stale entry. A CLI
 * one-shot process simply misses once, with no behavioural change.
 */
const indexCache = new Map<string, { mtimeMs: number; size: number; index: PrimitiveIndex }>();

/**
 * Clear the in-memory parsed-index cache. Primarily for tests and for callers
 * that must force a fresh read (e.g. after out-of-band file replacement).
 * @param filePath - Optional path to evict; clears the whole cache when omitted.
 */
export function clearIndexCache(filePath?: string): void {
  if (filePath === undefined) {
    indexCache.clear();
    return;
  }
  indexCache.delete(filePath);
}

/**
 * Load an index JSON file from disk; throws on missing file or bad schema.
 *
 * Repeated loads of an unchanged file return a cached, parsed index without
 * re-reading or re-parsing. {@link PrimitiveIndex.search} is read-only, so the
 * shared instance is safe to reuse across searches.
 * @param filePath - Path to a previously-saved index file.
 * @returns Loaded PrimitiveIndex.
 */
export function loadIndex(filePath: string): PrimitiveIndex {
  const stat = fs.statSync(filePath);
  const cached = indexCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.index;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const index = PrimitiveIndex.fromJSON(JSON.parse(raw) as unknown);
  indexCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, index });
  return index;
}

/**
 * Load an index, returning null if the file is missing or unreadable.
 * @param filePath - Path to a previously-saved index file.
 * @returns Loaded PrimitiveIndex or null.
 */
export function tryLoadIndex(filePath: string): PrimitiveIndex | null {
  try {
    return loadIndex(filePath);
  } catch {
    return null;
  }
}
