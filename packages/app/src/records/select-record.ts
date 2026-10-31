/**
 * Record selection: which install record file(s) a command acts on. The level
 * comes from `--lockfile`, `--scope` or the target; without one, a record or old
 * lockfile in the repository picks the repository level. Selected files are
 * loaded, so a bad record stops the command before anything is written. At user
 * level, the shared user record (rooted at home) is used when it is passed in.
 * @module records/select-record
 */
import * as path from 'node:path';
import {
  type InstallationScope,
  type RecordFs,
  type RecordLevel,
  type RecordLocation,
  repositoryLocations,
} from '@ai-primitives-hub/core';
import type {
  RecordStore,
} from './record-store';

/** Why a {@link RecordSelection} picked its level. */
export type RecordSelectionReason =
  | 'lockfile-flag'
  | 'explicit-scope'
  | 'target-scope'
  | 'repository-record-found'
  | 'user-fallback';

/** The record file(s) a command acts on. Never stored. */
export interface RecordSelection {
  level: RecordLevel;
  /** The git root or `--lockfile` folder, the home folder, or the user lockfile's folder. */
  root: string;
  /** Loaded record files, committed first; empty at user level and for an old `--lockfile`. */
  locations: RecordLocation[];
  /** Old-format lockfile for the same level, read with the old code. */
  oldLockfile?: string;
  /** `true` when no level was given and it was inferred. */
  inferred: boolean;
  reason: RecordSelectionReason;
}

/** Inputs of {@link selectRecord}. */
export interface SelectRecordOptions {
  store: RecordStore;
  fs: RecordFs;
  /** Current folder; where the walk starts when no target root is given. */
  cwd: string;
  /** What the command was given; nothing for `status` and a bare `install`. */
  given?: {
    /** `--lockfile <path>`, absolute or relative to `cwd`. */
    lockfile?: string;
    scope?: InstallationScope;
    target?: { scope: InstallationScope; rootPath?: string };
  };
  /** Upward walk for an old `prompt-registry.*` file; a result equal to the user lockfile is ignored. */
  findOldLockfile: (start: string) => Promise<string | null>;
  /** Absolute path of the user lockfile. */
  userLockfile: string;
  /**
   * The shared 3.0.0 user record (`AppStoragePaths.userRecord`, BR14.1). With
   * {@link home}, the user level selects it (BR15.1); without, the user level
   * keeps the old user lockfile only.
   */
  userRecord?: string;
  /** Home folder from `resolveUserHome`; the user level's root (BR14.3). */
  home?: string;
}

/**
 * Record level for an install scope; user and workspace scopes are both `user`.
 * @param scope - Install scope.
 */
export const recordLevelForScope = (scope: InstallationScope): RecordLevel =>
  scope === 'repository' ? 'repository' : 'user';

const userSelection = (userLockfile: string, reason: RecordSelectionReason, inferred: boolean): RecordSelection => ({
  level: 'user',
  root: path.dirname(userLockfile),
  locations: [],
  oldLockfile: userLockfile,
  inferred,
  reason
});

/**
 * User selection on the shared user record (BR15.1): the loaded user
 * location, rooted at home, with the old user lockfile as old store when it
 * exists. Falls back to the old-only selection when the caller did not pass
 * the user record and home, and for workspace scope (RQ4).
 * @param options - Selection inputs.
 * @param reason - Why the user level was picked.
 * @param inferred - Whether the level was inferred.
 * @param scope - The given or target scope, when there is one.
 */
const sharedUserSelection = async (
  options: SelectRecordOptions,
  reason: RecordSelectionReason,
  inferred: boolean,
  scope?: InstallationScope
): Promise<RecordSelection> => {
  if (options.userRecord === undefined || options.home === undefined || scope === 'workspace') {
    return userSelection(options.userLockfile, reason, inferred);
  }
  const location = options.store.resolveUser({ home: options.home, path: options.userRecord });
  await options.store.load(location);
  const oldExists = await options.fs.exists(options.userLockfile);
  return {
    level: 'user',
    root: location.root,
    locations: [location],
    ...(oldExists ? { oldLockfile: options.userLockfile } : {}),
    inferred,
    reason
  };
};

/**
 * The old repository file found from `start`, ignoring the user lockfile the walk may fall back to.
 * @param options - Selection inputs.
 * @param start - Walk start.
 */
const findOldRepositoryFile = async (options: SelectRecordOptions, start: string): Promise<string | undefined> => {
  const found = await options.findOldLockfile(start);
  return found === null || path.resolve(found) === path.resolve(options.userLockfile) ? undefined : found;
};

/**
 * Repository selection at the git root of `start`, with both record files loaded.
 * @param options - Selection inputs.
 * @param start - Target root or current folder.
 * @param reason - Why the repository level was picked.
 * @param oldLockfile - Old file already found, if any.
 */
const repositorySelection = async (
  options: SelectRecordOptions,
  start: string,
  reason: RecordSelectionReason,
  oldLockfile?: string
): Promise<RecordSelection> => {
  const locations = await options.store.resolveRepository({ start });
  for (const location of locations) {
    await options.store.load(location);
  }
  const old = oldLockfile ?? await findOldRepositoryFile(options, start);
  return {
    level: 'repository',
    root: locations[0].root,
    locations,
    ...(old === undefined ? {} : { oldLockfile: old }),
    inferred: reason === 'repository-record-found',
    reason
  };
};

/**
 * Selection for `--lockfile <path>`; the file decides the level and format.
 * @param options - Selection inputs.
 * @param lockfile - The flag's value.
 */
const lockfileSelection = async (options: SelectRecordOptions, lockfile: string): Promise<RecordSelection> => {
  const absolute = path.resolve(options.cwd, lockfile);
  if (absolute === path.resolve(options.userLockfile)) {
    return userSelection(options.userLockfile, 'lockfile-flag', false);
  }
  if (options.userRecord !== undefined && absolute === path.resolve(options.userRecord)) {
    return sharedUserSelection(options, 'lockfile-flag', false);
  }
  const root = path.dirname(absolute);
  const name = path.basename(absolute);
  // The record file name gives the commit mode.
  const location = repositoryLocations(root).find((candidate) => path.basename(candidate.path) === name);
  if (location === undefined) {
    return { level: 'repository', root, locations: [], oldLockfile: absolute, inferred: false, reason: 'lockfile-flag' };
  }
  // Both files are checked, as an install of the selected file also loads its counterpart.
  for (const candidate of repositoryLocations(root)) {
    await options.store.load(candidate);
  }
  return { level: 'repository', root, locations: [location], inferred: false, reason: 'lockfile-flag' };
};

/**
 * Choose the record file(s) a command acts on.
 * @param options - Selection inputs.
 * @throws {RegistryError} Any `RECORD.*` error from loading a selected file.
 */
export const selectRecord = async (options: SelectRecordOptions): Promise<RecordSelection> => {
  const { given, cwd } = options;
  if (given?.lockfile !== undefined && given.lockfile !== '') {
    return lockfileSelection(options, given.lockfile);
  }
  const start = path.resolve(cwd, given?.target?.rootPath ?? cwd);
  if (given?.scope !== undefined) {
    return recordLevelForScope(given.scope) === 'repository'
      ? repositorySelection(options, start, 'explicit-scope')
      : sharedUserSelection(options, 'explicit-scope', false, given.scope);
  }
  if (given?.target !== undefined) {
    return recordLevelForScope(given.target.scope) === 'repository'
      ? repositorySelection(options, start, 'target-scope')
      : sharedUserSelection(options, 'target-scope', false, given.target.scope);
  }
  const [committed, localOnly] = await options.store.resolveRepository({ start: path.resolve(cwd) });
  const hasNewRecord = (await options.fs.exists(committed.path)) || (await options.fs.exists(localOnly.path));
  const old = hasNewRecord ? undefined : await findOldRepositoryFile(options, path.resolve(cwd));
  if (hasNewRecord || old !== undefined) {
    return repositorySelection(options, path.resolve(cwd), 'repository-record-found', old);
  }
  return sharedUserSelection(options, 'user-fallback', true);
};
