/**
 * AppStorage-backed primitive-index location resolver.
 * @module storage/primitive-index-store
 */
import type {
  Dirent,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AppStorage,
  PrimitiveIndexKey,
  PrimitiveIndexStore,
} from '@ai-primitives-hub/core';

const INDEX_FILENAME = 'primitive-index.v2.json';

/**
 * Convert an external identity into one safe, deterministic path segment.
 * @param value
 */
function safeSegment(value: string): string {
  const segment = value.trim()
    .replaceAll(/[^a-zA-Z0-9._-]/gu, '_')
    .replaceAll(/\.{2,}/gu, '_');
  return segment.length > 0 ? segment : '_';
}

function indexHubNamespaces(hubId: string, entries: Dirent[]): string[] {
  const normalized = hubId.trim();
  const base = normalized.replace(/-\d{6}$/u, '');
  const prefix = `${safeSegment(base)}-`;
  return entries
    .filter((entry) => entry.isDirectory() && (
      entry.name === safeSegment(base)
      || (entry.name.startsWith(prefix) && /^\d{6}$/u.test(entry.name.slice(prefix.length)))
    ))
    .map((entry) => entry.name);
}

/**
 * Resolves shared semantic index paths below an injected application cache.
 */
export class AppStoragePrimitiveIndexStore implements PrimitiveIndexStore {
  private readonly cacheRoot: string;

  public constructor(storage: Pick<AppStorage, 'getPaths'>) {
    this.cacheRoot = storage.getPaths().cache;
  }

  public getIndexPath(key: PrimitiveIndexKey): string {
    return path.join(
      this.cacheRoot,
      'indexes',
      safeSegment(key.hubId),
      safeSegment(key.sourceRevision),
      safeSegment(key.searchProfileId),
      INDEX_FILENAME
    );
  }

  /**
   * Find the best persisted revision for a hub/profile pair.
   * @param hubId Stable hub identity.
   * @param searchProfileId Search profile to load.
   * @param sourceIds Locally known source IDs used to reject incompatible snapshots.
   * @returns The best compatible index path, or undefined when none exists.
   */
  public async findLatestIndexPath(
    hubId: string,
    searchProfileId: string,
    sourceIds?: readonly string[]
  ): Promise<string | undefined> {
    const indexesRoot = path.join(this.cacheRoot, 'indexes');
    let hubNamespaces: Dirent[];
    try {
      hubNamespaces = await fs.readdir(indexesRoot, { withFileTypes: true });
    } catch {
      return undefined;
    }

    const expectedSourceIds = sourceIds && new Set(sourceIds);
    const candidates: { file: string; mtimeMs: number; sourceOverlap: number; hasSourceRevisions: boolean }[] = [];
    for (const hubNamespace of indexHubNamespaces(hubId, hubNamespaces)) {
      const profileRoot = path.join(indexesRoot, safeSegment(hubNamespace));
      let revisions: Dirent[];
      try {
        revisions = await fs.readdir(profileRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const revision of revisions.filter((entry) => entry.isDirectory())) {
        const file = path.join(profileRoot, revision.name, safeSegment(searchProfileId), INDEX_FILENAME);
        try {
          const raw = await fs.readFile(file, 'utf8');
          const index = JSON.parse(raw) as {
            sourceRevisions?: Record<string, unknown> | null;
            primitives?: { bundle?: { sourceId?: unknown } }[];
          };
          if (!Array.isArray(index.primitives) || index.primitives.length === 0) {
            continue;
          }
          const sourceOverlap = computeSnapshotSourceOverlap(index, expectedSourceIds);
          if (sourceOverlap < 0) {
            continue;
          }
          const stat = await fs.stat(file);
          candidates.push({
            file,
            mtimeMs: stat.mtimeMs,
            sourceOverlap,
            hasSourceRevisions: Boolean(index.sourceRevisions && typeof index.sourceRevisions === 'object' && Object.keys(index.sourceRevisions).length > 0)
          });
        } catch {
          // Ignore malformed or concurrently removed snapshots.
        }
      }
    }
    return candidates
      .toSorted((a, b) =>
        b.sourceOverlap - a.sourceOverlap
        || Number(b.hasSourceRevisions) - Number(a.hasSourceRevisions)
        || b.mtimeMs - a.mtimeMs
      )[0]?.file;
  }
}

function computeSnapshotSourceOverlap(
  index: {
    sourceRevisions?: Record<string, unknown> | null;
    primitives?: { bundle?: { sourceId?: unknown } }[];
  },
  expectedSourceIds: ReadonlySet<string> | undefined
): number {
  if (!expectedSourceIds) {
    return 0;
  }
  const indexedSourceIds = new Set<string>();
  if (index.sourceRevisions && typeof index.sourceRevisions === 'object') {
    for (const sourceId of Object.keys(index.sourceRevisions)) {
      indexedSourceIds.add(sourceId);
    }
  }
  for (const primitive of index.primitives ?? []) {
    if (typeof primitive.bundle?.sourceId === 'string') {
      indexedSourceIds.add(primitive.bundle.sourceId);
    }
  }
  const overlap = [...indexedSourceIds].filter((sourceId) => expectedSourceIds.has(sourceId)).length;
  return overlap === 0 ? -1 : overlap;
}
