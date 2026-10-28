/**
 * Layer B path confinement for recorded paths (NFR4.1, NFR4.2, BR1.5).
 *
 * Layer A (`checkRecordedPath` in core) judges the text of a path. Layer B
 * resolves symlinks through `RecordFs`: the root and the nearest existing
 * ancestor folder of the path are realpath'd, the candidate is rebuilt from
 * the real ancestor, and it must sit under the real root and pass Layer A
 * again relative to it. That catches a symlinked parent that leaves the root,
 * or one that resolves into `.git`.
 *
 * The leaf itself is never followed: a recorded file may be a symlink, and it
 * is the link, not its target, that the record owns (a delete unlinks it).
 * @module records/confine-path
 */
import * as path from 'node:path';
import {
  checkRecordedPath,
  findRecordedPathProblem,
  recordError,
  type RecordFs,
} from '@ai-primitives-hub/core';

/** Outcome of the delete-time check for one recorded path. */
export type DeleteTarget =
  /** Remove `absolute` (a regular file or a symlink, never followed). */
  | { status: 'delete'; absolute: string }
  /** Nothing is there; there is nothing to remove. */
  | { status: 'missing' }
  /** Refused; the caller warns with `reason` and leaves the path alone. */
  | { status: 'skip'; reason: string };

/**
 * Path of `candidate` relative to `realRoot`, with forward slashes, or
 * `undefined` when it is the root itself or not under it.
 * @param realRoot - Realpath of the root.
 * @param candidate - Absolute path built from realpath'd folders.
 */
const relativeInside = (realRoot: string, candidate: string): string | undefined => {
  const relative = path.relative(realRoot, candidate);
  if (relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
};

const realRootOf = async (fs: RecordFs, root: string, file: string | undefined): Promise<string> => {
  try {
    return await fs.realpath(root);
  } catch (error) {
    throw recordError('RECORD.PATH_OUTSIDE_ROOT', { file, detail: 'the root folder does not resolve', cause: error });
  }
};

/**
 * Realpath of the nearest existing ancestor of `segments` under `root`, and
 * the segments below it that do not exist yet.
 * @param fs - Filesystem port.
 * @param root - Level root, as given.
 * @param segments - Folder segments below the root.
 */
const resolveNearestAncestor = async (
  fs: RecordFs,
  root: string,
  segments: readonly string[]
): Promise<{ realAncestor: string; rest: string[] }> => {
  let count = segments.length;
  while (count > 0 && (await fs.lstat(path.join(root, ...segments.slice(0, count)))) === undefined) {
    count -= 1;
  }
  return { realAncestor: await fs.realpath(path.join(root, ...segments.slice(0, count))), rest: segments.slice(count) };
};

/**
 * Check a recorded path with Layer A, then Layer B against the disk.
 * @param fs - Filesystem port.
 * @param root - Absolute level root (the git root at repository level).
 * @param recordedPath - Path relative to the root, as recorded.
 * @param file - Record file to name in the error, if any.
 * @returns The path with forward slashes, relative to the root.
 * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT` when the text is refused, a
 * folder on the way does not resolve, or the resolved path leaves the root or
 * enters `.git`.
 */
export const confinePath = async (fs: RecordFs, root: string, recordedPath: string, file?: string): Promise<string> => {
  const relative = checkRecordedPath(recordedPath, file);
  const realRoot = await realRootOf(fs, root, file);
  const segments = relative.split('/');
  const leaf = segments.pop() as string;
  let resolved: { realAncestor: string; rest: string[] };
  try {
    resolved = await resolveNearestAncestor(fs, root, segments);
  } catch (error) {
    throw recordError('RECORD.PATH_OUTSIDE_ROOT', {
      file,
      detail: `a folder of ${JSON.stringify(relative)} does not resolve`,
      cause: error
    });
  }
  const candidate = path.join(resolved.realAncestor, ...resolved.rest, leaf);
  const inside = relativeInside(realRoot, candidate);
  const problem = inside === undefined ? 'resolves outside the root' : findRecordedPathProblem(inside);
  if (problem !== undefined) {
    throw recordError('RECORD.PATH_OUTSIDE_ROOT', {
      file,
      detail: `${JSON.stringify(relative)} ${inside === undefined ? problem : `resolves to a path with a ${problem}`}`
    });
  }
  return relative;
};

/**
 * Check a recorded path just before deleting it (NFR4.2).
 *
 * Runs Layer A on the text, requires the realpath of the parent folder to be
 * inside the root (with Layer A on the result), then `lstat`s the leaf without
 * following it. Only a regular file or a symlink may be removed; a folder or
 * anything else is skipped. This never throws for a refused path.
 * @param fs - Filesystem port.
 * @param root - Absolute level root.
 * @param recordedPath - Path relative to the root, as recorded.
 * @returns What the caller may do with the path.
 */
export const resolveDeleteTarget = async (fs: RecordFs, root: string, recordedPath: string): Promise<DeleteTarget> => {
  const textProblem = findRecordedPathProblem(recordedPath);
  if (textProblem !== undefined) {
    return { status: 'skip', reason: textProblem };
  }
  const segments = recordedPath.split(/[/\\]/);
  const leaf = segments.pop() as string;
  let realRoot: string;
  let realParent: string;
  try {
    realRoot = await fs.realpath(root);
    realParent = await fs.realpath(path.join(root, ...segments));
  } catch {
    return (await fs.lstat(path.join(root, ...segments))) === undefined
      ? { status: 'missing' }
      : { status: 'skip', reason: 'its folder does not resolve' };
  }
  const absolute = path.join(realParent, leaf);
  const inside = relativeInside(realRoot, absolute);
  if (inside === undefined) {
    return { status: 'skip', reason: 'its folder resolves outside the root' };
  }
  const resolvedProblem = findRecordedPathProblem(inside);
  if (resolvedProblem !== undefined) {
    return { status: 'skip', reason: `its folder resolves to a path with a ${resolvedProblem}` };
  }
  const stat = await fs.lstat(absolute);
  if (stat === undefined) {
    return { status: 'missing' };
  }
  if (stat.kind !== 'file' && stat.kind !== 'symlink') {
    return { status: 'skip', reason: stat.kind === 'directory' ? 'it is a folder' : 'it is not a regular file' };
  }
  return { status: 'delete', absolute };
};
