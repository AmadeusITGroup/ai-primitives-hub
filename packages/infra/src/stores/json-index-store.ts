/**
 * JSON persistence for the primitive index.
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
