/**
 * Tool-to-target mapping for record replay and update (BR6.4, NFR4.10).
 *
 * Each recorded tool key is written by one configured target of that type,
 * at the record's level and, at repository level, on the same git root, so a
 * command never loads one level and writes another. With an explicit
 * `--target`, only that target is used, and only for its own type.
 * @module records/map-tool-to-target
 */
import * as path from 'node:path';
import type {
  RecordFs,
  RecordLevel,
  Target,
} from '@ai-primitives-hub/core';
import {
  resolveRepositoryRoot,
} from './git-root';
import {
  recordLevelForScope,
} from './select-record';

/** Outcome of {@link mapToolToTarget}. */
export type TargetMapping =
  /** Write the tool's entry with `target`; `note` says why it was picked when several matched. */
  | { target: Target; note?: string }
  /** No target writes this tool here; the entry is skipped and `skip` is the reason to report. */
  | { skip: string };

/** Inputs of {@link mapToolToTarget}. */
export interface MapToolToTargetOptions {
  /** Filesystem port, to find each target's git root. */
  fs: RecordFs;
  /** Recorded tool key (a target type). */
  tool: string;
  /** Level of the record the entry is in. */
  level: RecordLevel;
  /** The record's git root (repository level); ignored at user level. */
  gitRoot: string;
  /** Configured targets. */
  targets: readonly Target[];
  /** The target named by `--target`, when the command was given one. */
  explicit?: Target;
  /** Current folder: the root of a target without `rootPath`. */
  cwd: string;
}

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/**
 * Whether two folders are the same, also through a symlink.
 * @param fs - Filesystem port.
 * @param left - First folder.
 * @param right - Second folder.
 */
const isSameFolder = async (fs: RecordFs, left: string, right: string): Promise<boolean> => {
  if (path.resolve(left) === path.resolve(right)) {
    return true;
  }
  try {
    return (await fs.realpath(left)) === (await fs.realpath(right));
  } catch {
    return false;
  }
};

/**
 * Whether a target writes at the record's level and, at repository level, on its git root.
 * @param options - Mapping inputs.
 * @param target - Candidate target.
 */
const isOnRecordLevel = async (options: MapToolToTargetOptions, target: Target): Promise<boolean> => {
  if (recordLevelForScope(target.scope) !== options.level) {
    return false;
  }
  if (options.level !== 'repository') {
    return true;
  }
  const targetRoot = await resolveRepositoryRoot(options.fs, path.resolve(options.cwd, target.rootPath ?? options.cwd));
  return isSameFolder(options.fs, targetRoot, options.gitRoot);
};

/**
 * Map a recorded tool to the configured target that writes it (BR6.4).
 *
 * The explicit `--target` is used for its own type only. Otherwise the
 * candidates are the configured targets of that type at the level (and on the
 * same git root at repository level): one is used; of several, the first by
 * name is used and a note says so; none skips the entry.
 * @param options - The tool, level, git root, configured targets, explicit target and filesystem.
 * @returns The target to write with, or the reason the entry is skipped.
 */
export const mapToolToTarget = async (options: MapToolToTargetOptions): Promise<TargetMapping> => {
  const { tool, explicit } = options;
  if (explicit !== undefined) {
    if (explicit.type !== tool) {
      return { skip: `--target ${explicit.name} is a ${explicit.type} target, not ${tool}` };
    }
    return (await isOnRecordLevel(options, explicit))
      ? { target: explicit }
      : { skip: `--target ${explicit.name} does not write to the ${options.level} record at ${options.gitRoot}` };
  }
  const candidates: Target[] = [];
  for (const target of options.targets) {
    if (target.type === tool && await isOnRecordLevel(options, target)) {
      candidates.push(target);
    }
  }
  if (candidates.length === 0) {
    return { skip: `no ${tool} target configured; add one with \`target add\`` };
  }
  const [first, ...rest] = candidates.toSorted((left, right) => compareText(left.name, right.name));
  return rest.length === 0
    ? { target: first }
    : { target: first, note: `several ${tool} targets match; using ${first.name}` };
};
