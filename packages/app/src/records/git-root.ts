/**
 * Repository root detection and the local-only `info/exclude` entry, through
 * `RecordFs` only (no `git` process). A `gitdir:` target is trusted only when
 * it holds `HEAD` or `commondir`, so a crafted `.git` file cannot redirect writes.
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
 * Nearest folder from `start` upward that holds `.git`, or `undefined`.
 * @param fs - Filesystem port.
 * @param start - Folder to start from.
 */
export const findGitRoot = async (fs: RecordFs, start: string): Promise<string | undefined> => {
  const dotGit = await findAncestorFile(fs, path.resolve(start), ['.git']);
  return dotGit === undefined ? undefined : path.dirname(dotGit);
};

/**
 * Repository root for a start folder: the git root, or the start folder itself when there is none.
 * @param fs - Filesystem port.
 * @param start - Folder to start from.
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
 * Common git directory for a repository root, or a warning when none can be trusted.
 * @param fs - Filesystem port.
 * @param root - Repository root.
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
 * The `info/exclude` file for a repository root, in the common git directory, or a warning.
 * @param fs - Filesystem port.
 * @param root - Repository root.
 */
export const resolveExcludeFile = async (fs: RecordFs, root: string): Promise<{ file: string } | { warning: string }> => {
  const resolved = await resolveExcludeDir(fs, root);
  return 'warning' in resolved ? resolved : { file: path.join(resolved.dir, 'info', 'exclude') };
};

/**
 * Add `name` to the hub's section of `info/exclude`. Never throws; failures come back as a warning.
 * @param fs - Filesystem port.
 * @param root - Repository root.
 * @param name - Root-relative file name.
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
 * Remove `name` from the hub's section of `info/exclude`. Never throws; failures come back as a warning.
 * @param fs - Filesystem port.
 * @param root - Repository root.
 * @param name - Root-relative file name.
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
