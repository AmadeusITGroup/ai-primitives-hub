/**
 * Which collections a set of changed paths touches: the collection file itself,
 * its README, or any item it references.
 * @module app/collection/affected-collections
 */
import * as path from 'node:path';
import {
  normalizePrimitiveKind,
  normalizeRepoRelativePath,
} from '@ai-primitives-hub/core';
import {
  listCollectionFiles,
  readCollection,
  resolveCollectionItemPaths,
  resolveCollectionReadmePath,
} from './read-collection';

export interface AffectedCollection {
  id: string;
  file: string;
}

/**
 * Normalize a path for comparison: backslash-to-slash, strip a leading `/`, trim.
 * @param p Path to normalize.
 */
const normalize = (p: string): string => String(p).replaceAll('\\', '/').replaceAll(/^\/+/g, '').trim();

/**
 * Collections under `<repoRoot>/collections/` affected by the changed paths.
 * @param repoRoot Repository root.
 * @param changedPaths Repository-relative changed paths (for example from `git diff --name-only`).
 */
export function affectedCollections(repoRoot: string, changedPaths: readonly string[]): AffectedCollection[] {
  const changed = changedPaths.map((p) => normalize(p)).filter((p) => p.length > 0);
  const changedSet = new Set(changed);
  const overlaps = (file: string): boolean => {
    if (changedSet.has(file)) {
      return true;
    }
    // Git reports a submodule update as the gitlink path, not its child files.
    for (let slash = file.lastIndexOf('/'); slash > 0; slash = file.lastIndexOf('/', slash - 1)) {
      if (changedSet.has(file.slice(0, slash))) {
        return true;
      }
    }
    return false;
  };
  const affected: AffectedCollection[] = [];
  for (const file of listCollectionFiles(repoRoot)) {
    const collection = readCollection(repoRoot, file);
    const readmePath = resolveCollectionReadmePath(collection);
    const items = Array.isArray(collection.items) ? collection.items : [];
    const itemPaths = resolveCollectionItemPaths(repoRoot, collection).map((p) => normalize(p));
    // Git includes deleted files that the current on-disk skill expansion cannot see.
    const skillDirectories = items
      .filter((item) => item?.path && normalizePrimitiveKind(item.kind) === 'skill')
      .map((item) => path.posix.dirname(normalizeRepoRelativePath(item.path)))
      .map((dir) => dir === '.' ? '' : `${dir}/`);
    if (overlaps(normalize(file))
      || (readmePath !== null && overlaps(normalize(readmePath)))
      || itemPaths.some((p) => overlaps(p))
      || changed.some((p) => skillDirectories.some((dir) => p.startsWith(dir)))) {
      affected.push({ id: collection.id, file });
    }
  }
  return affected;
}
