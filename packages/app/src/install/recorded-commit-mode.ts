/**
 * Commit-mode switch of an installed record.
 *
 * Moving a repository install between `commit` and `local-only` changes
 * which of its files git should ignore. The record is located with the
 * writer of the target type that placed it (see `recorded-files.ts`) and
 * its located paths are added to, or removed from, the repository's
 * exclusion list. Moving the entry between lockfiles stays with the
 * delivery's record store.
 * @module install/recorded-commit-mode
 */
import * as path from 'node:path';
import type {
  RepositoryExclusion,
  Target,
  TargetWriter,
} from '@ai-primitives-hub/core';
import type {
  InstallRecord,
} from '../stores/install-record-store';
import type {
  RepositoryCommitMode,
} from '../stores/json-lockfile-store';
import {
  locateRecord,
} from './recorded-files';

/** Inputs of {@link switchRecordedCommitMode}. */
export interface SwitchRecordedCommitModeInput {
  /** Writer factory; the record's writer is built from its `targetType`. */
  writerFactory: (target: Target) => TargetWriter;
  /** Effective repository target: scope and root set. */
  target: Target;
  /** The record whose files change mode. */
  record: InstallRecord;
  /** Exclusion list of the repository. */
  exclusion: RepositoryExclusion;
  /** Commit mode the record moves to. */
  newMode: RepositoryCommitMode;
}

/** Outcome of {@link switchRecordedCommitMode}. */
export interface SwitchRecordedCommitModeResult {
  /** The workspace is not a git repository: the exclusion list was not changed. */
  exclusionSkipped: boolean;
  /** Exclusion list updates that failed. */
  exclusionErrors: string[];
  /** Why the record could not be located, when it couldn't; the exclusion list was not changed. */
  unresolvable?: string;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Every ancestor directory of the locations strictly below `root`.
 * @param root Absolute root of the record's writer.
 * @param locations Absolute file locations below `root`.
 * @returns The directories, without duplicates.
 */
const ancestorsBelow = (root: string, locations: readonly string[]): string[] => {
  const base = path.resolve(root);
  const below = (dir: string): boolean => dir.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
  const directories = new Set<string>();
  for (const location of locations) {
    for (let dir = path.dirname(path.resolve(location)); dir !== base && below(dir); dir = path.dirname(dir)) {
      directories.add(dir);
    }
  }
  return [...directories];
};

/**
 * Update the exclusion list for a record's commit-mode switch.
 *
 * `local-only` excludes the record's located paths. `commit` stops
 * excluding them and every ancestor directory of them strictly below the
 * writer's root, which drops the directory lines earlier extension
 * versions wrote for a skill (`.github/skills/<id>`). Files with no
 * location are left out. Nothing changes when the record can't be located
 * (`unresolvable`) or the workspace is not a git repository
 * (`exclusionSkipped`); an exclusion failure is caught and reported in
 * `exclusionErrors`, never thrown.
 * @param input Writer factory, target, record, exclusion and new mode.
 * @returns The outcome.
 */
export async function switchRecordedCommitMode(input: SwitchRecordedCommitModeInput): Promise<SwitchRecordedCommitModeResult> {
  const { writerFactory, target, record, exclusion, newMode } = input;
  const result: SwitchRecordedCommitModeResult = { exclusionSkipped: false, exclusionErrors: [] };
  const located = await locateRecord(writerFactory, target, record);
  if (located.kind === 'unresolvable') {
    return { ...result, unresolvable: located.reason };
  }
  if (located.kind === 'no-locate') {
    return { ...result, unresolvable: `the writer of target type "${located.target.type}" cannot locate files` };
  }
  const locations = located.located.paths.filter((p): p is string => p !== null);
  if (locations.length === 0) {
    return result;
  }
  try {
    if (!(await exclusion.isAvailable?.() ?? true)) {
      return { ...result, exclusionSkipped: true };
    }
    await (newMode === 'local-only'
      ? exclusion.add(locations)
      : exclusion.remove([...locations, ...ancestorsBelow(located.located.root, locations)]));
  } catch (err) {
    result.exclusionErrors.push(messageOf(err));
  }
  return result;
}
