/**
 * Repository root detection and the local-only `info/exclude` entry
 * (BR2.1, BR2.3, NFR4.6, NFR4.7).
 *
 * Everything goes through `RecordFs`: no `git` subprocess, no shell. The root
 * is the nearest folder, from the start folder upward, holding an entry named
 * `.git` (a folder, or a file as in worktrees and submodules). The git
 * directory behind a `.git` file is only trusted when it looks like one (it
 * holds `HEAD`, or `commondir` for a worktree), so a crafted `gitdir:` cannot
 * make the hub write into an arbitrary folder.
 * @module records/git-root
 */
import * as path from 'node:path';
import {
  addExcludeEntries,
  type RecordFs,
  removeExcludeEntries,
} from '@ai-primitives-hub/core';
import {
  findAncestorFile,
} from '../diagnostics/find-ancestor-file';
import {
  writeFileAtomically,
} from './atomic-write';

/** Largest `.git` file, `commondir` file or `info/exclude` file read, in bytes. */
const SMALL_FILE_MAX_BYTES = 1024 * 1024;

/** Outcome of {@link ensureExcluded}. */
export interface ExcludeResult {
  /** `added` wrote the entry, `present` found it already there, `skipped` wrote nothing. */
  status: 'added' | 'present' | 'skipped';
  /** `info/exclude` path used, when a git directory was found. */
  excludePath?: string;
  /** Why nothing was written, for the caller to log (status `skipped` only). */
  warning?: string;
}

/**
 * Find the nearest folder, from `start` upward (inclusive), that holds `.git`.
 * @param fs - Filesystem port.
 * @param start - Folder to start from; resolved to an absolute path.
 * @returns The folder, or `undefined` when no ancestor holds `.git`.
 */
export const findGitRoot = async (fs: RecordFs, start: string): Promise<string | undefined> => {
  const dotGit = await findAncestorFile(fs, path.resolve(start), ['.git']);
  return dotGit === undefined ? undefined : path.dirname(dotGit);
};

/**
 * Repository root for a start folder (BR2.1): the git root, or the start folder itself when there is none.
 * @param fs - Filesystem port.
 * @param start - Target root path, or the current folder.
 * @returns Absolute repository root.
 */
export const resolveRepositoryRoot = async (fs: RecordFs, start: string): Promise<string> =>
  (await findGitRoot(fs, start)) ?? path.resolve(start);

const readSmallText = async (fs: RecordFs, file: string): Promise<string | undefined> => {
  const bytes = await fs.readCapped(file, SMALL_FILE_MAX_BYTES + 1);
  if (bytes.byteLength > SMALL_FILE_MAX_BYTES) {
    return undefined;
  }
  return new TextDecoder('utf-8').decode(bytes);
};

/**
 * Kind of the entry at `file`, following symlinks.
 * @param fs - Filesystem port.
 * @param file - Path to inspect.
 */
const followedKind = async (fs: RecordFs, file: string): Promise<string | undefined> => {
  const stat = await fs.lstat(file);
  if (stat?.kind !== 'symlink') {
    return stat?.kind;
  }
  try {
    return (await fs.lstat(await fs.realpath(file)))?.kind;
  } catch {
    return undefined;
  }
};

const gitDirFromFile = async (fs: RecordFs, dotGit: string): Promise<string | undefined> => {
  const text = await readSmallText(fs, dotGit);
  const match = text === undefined ? null : /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
  return match === null ? undefined : path.resolve(path.dirname(dotGit), match[1]);
};

/**
 * Folder that holds `info/exclude` for a repository root (NFR4.6).
 * @param fs - Filesystem port.
 * @param root - Repository root holding `.git`.
 * @returns The common git directory, or a warning when none can be trusted.
 */
export const resolveExcludeDir = async (fs: RecordFs, root: string): Promise<{ dir: string } | { warning: string }> => {
  const dotGit = path.join(root, '.git');
  const kind = await followedKind(fs, dotGit);
  let gitDir: string | undefined;
  if (kind === 'directory') {
    gitDir = dotGit;
  } else if (kind === 'file') {
    gitDir = await gitDirFromFile(fs, dotGit);
    if (gitDir === undefined) {
      return { warning: `${dotGit} has no "gitdir:" line` };
    }
  } else {
    return { warning: `no git directory at ${dotGit}` };
  }
  const commondirFile = path.join(gitDir, 'commondir');
  const hasCommondir = (await followedKind(fs, commondirFile)) === 'file';
  if (!hasCommondir && !(await fs.exists(path.join(gitDir, 'HEAD')))) {
    return { warning: `${gitDir} does not look like a git directory (no HEAD or commondir)` };
  }
  if (!hasCommondir) {
    return { dir: gitDir };
  }
  const commondir = (await readSmallText(fs, commondirFile))?.trim();
  if (!commondir) {
    return { warning: `${commondirFile} is empty or too large` };
  }
  return { dir: path.resolve(gitDir, commondir) };
};

/**
 * The `info/exclude` file for a repository root (NFR4.6): `info/exclude` in
 * the folder {@link resolveExcludeDir} trusts. Every writer of the hub's
 * section uses this file, so a worktree's entries all land in the common git
 * directory.
 * @param fs - Filesystem port.
 * @param root - Repository root holding `.git`.
 * @returns The absolute file path (it may not exist yet), or a warning when no git directory can be trusted.
 */
export const resolveExcludeFile = async (fs: RecordFs, root: string): Promise<{ file: string } | { warning: string }> => {
  const resolved = await resolveExcludeDir(fs, root);
  return 'warning' in resolved ? resolved : { file: path.join(resolved.dir, 'info', 'exclude') };
};

/**
 * Add `name` to the repository's `info/exclude` under
 * `GIT_EXCLUDE_SECTION_HEADER`, once (BR2.3). The text change is
 * `addExcludeEntries` from core, shared with the repository-scope writer.
 *
 * Failures never throw: the record is still written and the caller logs the warning.
 * @param fs - Filesystem port.
 * @param root - Repository root holding `.git`.
 * @param name - File name to exclude, relative to the root.
 * @returns What happened.
 */
export const ensureExcluded = async (fs: RecordFs, root: string, name: string): Promise<ExcludeResult> => {
  let excludePath: string | undefined;
  try {
    const resolved = await resolveExcludeFile(fs, root);
    if ('warning' in resolved) {
      return { status: 'skipped', warning: `${name} was not added to info/exclude: ${resolved.warning}` };
    }
    excludePath = resolved.file;
    const existing = (await fs.exists(excludePath)) ? await readSmallText(fs, excludePath) : '';
    if (existing === undefined) {
      return { status: 'skipped', excludePath, warning: `${name} was not added to ${excludePath}: the file is too large` };
    }
    const updated = addExcludeEntries(existing, [name]);
    if (updated === undefined) {
      return { status: 'present', excludePath };
    }
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await writeFileAtomically(fs, excludePath, updated);
    return { status: 'added', excludePath };
  } catch (error) {
    return {
      status: 'skipped',
      excludePath,
      warning: `${name} was not added to info/exclude: ${error instanceof Error ? error.message : String(error)}`
    };
  }
};

/** Outcome of {@link removeExcluded}. */
export interface RemoveExcludedResult {
  /** `removed` took the entry out, `absent` found nothing to remove, `skipped` changed nothing because of a problem. */
  status: 'removed' | 'absent' | 'skipped';
  /** `info/exclude` path used, when a git directory was found. */
  excludePath?: string;
  /** Why nothing was changed, for the caller to log (status `skipped` only). */
  warning?: string;
}

/**
 * Remove `name` from the repository's `info/exclude`, the reverse of {@link ensureExcluded} (BR2.3).
 *
 * The text change is `removeExcludeEntries` from core: only lines below
 * `GIT_EXCLUDE_SECTION_HEADER` that are `name` or `/name` go; the header
 * (even when its section is now empty) and every other line stay as they
 * are. Failures never throw: the caller logs the warning.
 * @param fs - Filesystem port.
 * @param root - Repository root holding `.git`.
 * @param name - File name to remove, relative to the root.
 * @returns What happened.
 */
export const removeExcluded = async (fs: RecordFs, root: string, name: string): Promise<RemoveExcludedResult> => {
  let excludePath: string | undefined;
  try {
    const resolved = await resolveExcludeFile(fs, root);
    if ('warning' in resolved) {
      return { status: 'skipped', warning: `${name} was not removed from info/exclude: ${resolved.warning}` };
    }
    excludePath = resolved.file;
    if (!(await fs.exists(excludePath))) {
      return { status: 'absent', excludePath };
    }
    const existing = await readSmallText(fs, excludePath);
    if (existing === undefined) {
      return { status: 'skipped', excludePath, warning: `${name} was not removed from ${excludePath}: the file is too large` };
    }
    const updated = removeExcludeEntries(existing, [name]);
    if (updated === undefined) {
      return { status: 'absent', excludePath };
    }
    await writeFileAtomically(fs, excludePath, updated);
    return { status: 'removed', excludePath };
  } catch (error) {
    return {
      status: 'skipped',
      excludePath,
      warning: `${name} was not removed from info/exclude: ${error instanceof Error ? error.message : String(error)}`
    };
  }
};
