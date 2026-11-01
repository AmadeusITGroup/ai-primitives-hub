/**
 * Which collections a set of changed paths touches: the collection file itself,
 * its README, or any item it references.
 * @module app/collection/affected-collections
 */
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
  const affected: AffectedCollection[] = [];
  for (const file of listCollectionFiles(repoRoot)) {
    const collection = readCollection(repoRoot, file);
    const readmePath = resolveCollectionReadmePath(collection);
    const itemPaths = new Set(resolveCollectionItemPaths(repoRoot, collection).map((p) => normalize(p)));
    if (changedSet.has(normalize(file))
      || (readmePath !== null && changedSet.has(normalize(readmePath)))
      || changed.some((p) => itemPaths.has(p))) {
      affected.push({ id: collection.id, file });
    }
  }
  return affected;
}
