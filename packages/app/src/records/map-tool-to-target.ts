/**
 * Maps a recorded tool to the configured target that writes it, at the
 * record's level and git root, so a command never reads one level and writes another.
 * @module records/map-tool-to-target
 */
import * as path from 'node:path';
import {
  compareCodeUnits,
  type RecordFs,
  type RecordLevel,
  type Target,
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
  fs: RecordFs;
  /** Recorded tool key (a target type). */
  tool: string;
  level: RecordLevel;
  /** The record's git root; ignored at user level. */
  gitRoot: string;
  targets: readonly Target[];
  /** The target named by `--target`. */
  explicit?: Target;
  /** Root of a target without `rootPath`. */
  cwd: string;
}

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

const isOnRecordLevel = async (options: MapToolToTargetOptions, target: Target): Promise<boolean> => {
  // Workspace-scope targets keep the old lockfile and never write the user record (RQ4).
  if (recordLevelForScope(target.scope) !== options.level || target.scope === 'workspace') {
    return false;
  }
  if (options.level !== 'repository') {
    return true;
  }
  const targetRoot = await resolveRepositoryRoot(options.fs, path.resolve(options.cwd, target.rootPath ?? options.cwd));
  return isSameFolder(options.fs, targetRoot, options.gitRoot);
};

/**
 * Map a recorded tool to the configured target that writes it; of several, the first by name.
 * @param options - Mapping inputs.
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
  const [first, ...rest] = candidates.toSorted((left, right) => compareCodeUnits(left.name, right.name));
  return rest.length === 0
    ? { target: first }
    : { target: first, note: `several ${tool} targets match; using ${first.name}` };
};
