/**
 * Canonical source snapshot identity shared by CLI and VS Code.
 * @module harvest/source-revision
 */
import {
  createHash,
} from 'node:crypto';

export interface SourceRevisionEntry {
  sourceId: string;
  url: string;
  branch: string;
  revision: string;
}

/**
 * Hash the normalized source coordinates and revisions represented by an index.
 * Keeping this representation client-neutral lets CLI and VS Code resolve the
 * same namespaced semantic index when they harvested the same source commits.
 * @param entries
 */
export function createSourceRevision(entries: readonly SourceRevisionEntry[]): string {
  const normalized = entries
    .map((entry) => ({
      sourceId: entry.sourceId.trim(),
      url: entry.url.trim(),
      branch: entry.branch.trim(),
      revision: entry.revision.trim()
    }))
    .toSorted((a, b) => a.sourceId.localeCompare(b.sourceId));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
