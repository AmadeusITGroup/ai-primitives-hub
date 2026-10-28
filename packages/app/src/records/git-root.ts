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
import type {
  RecordFs,
} from '@ai-primitives-hub/core';

/** Section header written above the hub's `info/exclude` entries. */
export const EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

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
  let dir = path.resolve(start);
  for (;;) {
    if (await fs.exists(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
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

const hasEntry = (text: string, name: string): boolean =>
  text.split(/\r?\n/).some((line) => {
    const entry = line.trim();
    return entry === name || entry === `/${name}`;
  });

/**
 * Add `name` to the repository's `info/exclude` under {@link EXCLUDE_SECTION_HEADER}, once (BR2.3).
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
    const resolved = await resolveExcludeDir(fs, root);
    if ('warning' in resolved) {
      return { status: 'skipped', warning: `${name} was not added to info/exclude: ${resolved.warning}` };
    }
    const infoDir = path.join(resolved.dir, 'info');
    excludePath = path.join(infoDir, 'exclude');
    const existing = (await fs.exists(excludePath)) ? await readSmallText(fs, excludePath) : '';
    if (existing === undefined) {
      return { status: 'skipped', excludePath, warning: `${name} was not added to ${excludePath}: the file is too large` };
    }
    if (hasEntry(existing, name)) {
      return { status: 'present', excludePath };
    }
    await fs.mkdir(infoDir, { recursive: true });
    const lines = existing.split('\n');
    const headerIndex = lines.findIndex((line) => line.replace(/\r$/, '').trim() === EXCLUDE_SECTION_HEADER);
    if (headerIndex === -1) {
      const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
      await fs.appendFile(excludePath, `${separator}${EXCLUDE_SECTION_HEADER}\n${name}\n`);
      return { status: 'added', excludePath };
    }
    // Insert right below the existing header, so the file keeps one section
    // shared with the repository-scope writer and the extension.
    lines.splice(headerIndex + 1, 0, name);
    const temp = `${excludePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, lines.join('\n'));
    try {
      await fs.rename(temp, excludePath);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
    return { status: 'added', excludePath };
  } catch (error) {
    return {
      status: 'skipped',
      excludePath,
      warning: `${name} was not added to info/exclude: ${error instanceof Error ? error.message : String(error)}`
    };
  }
};
