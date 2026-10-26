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

/**
 * Labels of the executable files under `root` (any execute bit set).
 * @param fs - Filesystem.
 * @param root - Absolute directory to walk; a missing root gives an empty set.
 * @param roots - Labelled sandbox roots.
 * @returns The labels, or undefined when the filesystem reports no permission bits.
 * @throws {Error} When a file lies outside every root (a harness defect).
 */
export async function listExecutableLabels(
  fs: Pick<FileSystem, 'exists' | 'readDirEntries' | 'stat'>,
  root: string,
  roots: readonly SnapshotRoot[]
): Promise<ReadonlySet<string> | undefined> {
  const labels = new Set<string>();
  if (!(await fs.exists(root))) {
    return labels;
  }
  let modesKnown = true;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readDirEntries(dir)) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(absolute);
        continue;
      }
      const { mode } = await fs.stat(absolute);
      if (mode === undefined) {
        modesKnown = false;
        continue;
      }
      // eslint-disable-next-line no-bitwise -- any execute bit
      if ((mode & 0o111) === 0) {
        continue;
      }
      const label = labelSandboxPath(roots, absolute);
      if (label === undefined) {
        throw new Error(`snapshot path is outside every sandbox root: ${absolute}`);
      }
      labels.add(label);
    }
  };
  await walk(root);
  return modesKnown ? labels : undefined;
}
