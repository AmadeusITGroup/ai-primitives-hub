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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(idx.toJSON(), null, 2), 'utf8');
}

/**
 * Load an index JSON file from disk; throws on missing file or bad schema.
 * @param filePath - Path to a previously-saved index file.
 * @returns Loaded PrimitiveIndex.
 */
export function loadIndex(filePath: string): PrimitiveIndex {
  const raw = fs.readFileSync(filePath, 'utf8');
  return PrimitiveIndex.fromJSON(JSON.parse(raw) as unknown);
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
