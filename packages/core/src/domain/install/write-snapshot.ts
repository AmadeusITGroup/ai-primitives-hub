/**
 * Domain layer — what an install write replaced, so a rollback can put it back.
 *
 * Install writers overwrite each destination. A rollback that only deletes
 * the written paths loses the bytes a destination held before: a user's
 * own file at an unrecorded destination, or the file of an earlier install
 * the new one changed. Writers take a {@link WriteSnapshots} entry for each
 * destination just before writing it, report the replaced files in
 * `TargetWriteResult.replaced`, and roll back through {@link restoreOrRemove}.
 *
 * Pure domain logic over an injected port subset: no `node:fs`, no IO of
 * its own.
 * @module domain/install/write-snapshot
 */
import type {
  ExtractedFile,
} from '../../ports/bundle-extractor';
import {
  applyFileMode,
  type ExecutableBitSetter,
  withFileMode,
} from './file-mode';

/**
 * Destinations of one write: the file each held before its first write in
 * that write, or `null` when there was none.
 */
export type WriteSnapshots = Map<string, ExtractedFile | null>;

/** The filesystem subset {@link snapshotBeforeWrite} needs. */
export interface SnapshotFs {
  exists(path: string): Promise<boolean>;
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Optional: without it the snapshot keeps no executable bit. */
  stat?(path: string): Promise<{ mode?: number }>;
}

/** The filesystem subset {@link restoreOrRemove} needs. */
export interface RestoreFs extends ExecutableBitSetter {
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * Record what a destination holds before the write replaces it. Only the
 * first call per path counts, so a path written twice in one write keeps
 * what it held before the write. A destination that exists but cannot be
 * read (a directory) gets no snapshot: a rollback removes it as before. A
 * `stat` failure after the read keeps the bytes, without a mode.
 * @param fs Filesystem the write goes through.
 * @param snapshots Snapshots of the current write.
 * @param filePath Absolute destination, as the write will list it in `written`.
 */
export async function snapshotBeforeWrite(fs: SnapshotFs, snapshots: WriteSnapshots, filePath: string): Promise<void> {
  if (snapshots.has(filePath)) {
    return;
  }
  if (!(await fs.exists(filePath))) {
    snapshots.set(filePath, null);
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFileBytes(filePath);
  } catch {
    // No snapshot: the destination is rolled back by removal.
    return;
  }
  let mode: number | undefined;
  try {
    mode = fs.stat === undefined ? undefined : (await fs.stat(filePath)).mode;
  } catch {
    // The bytes are still restored, without an executable bit.
  }
  snapshots.set(filePath, mode === undefined ? bytes : withFileMode(bytes, mode));
}

/**
 * The files a write replaced, for `TargetWriteResult.replaced`.
 * @param snapshots Snapshots of the write.
 * @returns Earlier bytes keyed by absolute path; `undefined` when the write replaced nothing.
 */
export function replacedFiles(snapshots: WriteSnapshots): Record<string, ExtractedFile> | undefined {
  const replaced = [...snapshots].filter((entry): entry is [string, ExtractedFile] => entry[1] !== null);
  return replaced.length === 0 ? undefined : Object.fromEntries(replaced);
}

/** What one write of an install wrote and replaced (`TargetWriteResult` subset). */
export interface WriteOutcome {
  readonly written: readonly string[];
  readonly replaced?: Readonly<Record<string, ExtractedFile>>;
}

/**
 * Merge the `replaced` maps of two writes of one install. For a path the
 * earlier write wrote, only its snapshot counts: a path it created has no
 * snapshot, so the later write's snapshot (the earlier write's own bytes)
 * is dropped and a rollback removes the path.
 * @param first The earlier write.
 * @param second The later write.
 * @returns The merged map; `undefined` when it is empty.
 */
export function mergeReplacedFiles(first: WriteOutcome, second: WriteOutcome): Record<string, ExtractedFile> | undefined {
  const writtenFirst = new Set(first.written);
  const merged = Object.fromEntries([
    ...Object.entries(second.replaced ?? {}).filter(([filePath]) => !writtenFirst.has(filePath)),
    ...Object.entries(first.replaced ?? {})
  ]);
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * Roll written paths back, best effort: a path listed in `replaced` gets
 * its earlier bytes (and executable bit) back, any other path is removed.
 * @param fs Filesystem the write went through.
 * @param written Absolute paths to roll back.
 * @param replaced Earlier bytes keyed by absolute path (`TargetWriteResult.replaced`).
 */
export async function restoreOrRemove(
  fs: RestoreFs,
  written: readonly string[],
  replaced?: Readonly<Record<string, ExtractedFile>>
): Promise<void> {
  for (const filePath of written) {
    try {
      const earlier = replaced !== undefined && Object.hasOwn(replaced, filePath) ? replaced[filePath] : undefined;
      if (earlier === undefined) {
        await fs.remove(filePath);
      } else {
        await fs.writeFileBytes(filePath, earlier);
        await applyFileMode(fs, filePath, earlier);
      }
    } catch {
      // Best effort: the failure that caused the rollback is what the caller reports.
    }
  }
}
