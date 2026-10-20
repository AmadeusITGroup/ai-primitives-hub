/**
 * Sandbox snapshot walker of `doctor diagnostics --primitives`.
 *
 * Walking and hashing are the only I/O; labelling, diffing and judging
 * happen in core (`labelSandboxPath`, `diffSnapshots`, the evaluators).
 * @module diagnostics/sandbox-snapshot
 */
import * as path from 'node:path';
import {
  type FileSystem,
  labelSandboxPath,
  sha256Hex,
  type Snapshot,
  type SnapshotRoot,
} from '@ai-primitives-hub/core';

/**
 * Snapshot every file under `root`: label → sha256 hex of its bytes.
 * @param fs - Filesystem.
 * @param root - Absolute directory to walk; a missing root gives an empty snapshot.
 * @param roots - Labelled sandbox roots.
 * @returns The snapshot, keys sorted.
 * @throws {Error} When a file lies outside every root (a harness defect).
 */
export async function snapshotTree(
  fs: Pick<FileSystem, 'exists' | 'readDirEntries' | 'readFileBytes'>,
  root: string,
  roots: readonly SnapshotRoot[]
): Promise<Snapshot> {
  const entries: [string, string][] = [];
  if (!(await fs.exists(root))) {
    return new Map();
  }
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readDirEntries(dir)) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(absolute);
        continue;
      }
      const label = labelSandboxPath(roots, absolute);
      if (label === undefined) {
        throw new Error(`snapshot path is outside every sandbox root: ${absolute}`);
      }
      entries.push([label, sha256Hex(await fs.readFileBytes(absolute))]);
    }
  };
  await walk(root);
  return new Map(entries.toSorted(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0))));
}
