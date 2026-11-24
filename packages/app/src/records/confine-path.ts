/**
 * Filesystem confinement for recorded paths: symlinked parent folders must not
 * leave the root or enter `.git`. The leaf is never followed, since the record
 * owns a link, not its target.
 * @module records/confine-path
 */
import * as path from 'node:path';
import {
  checkRecordedPath,
  findRecordedPathProblem,
  recordError,
  type RecordFs,
  relativeInside,
} from '@ai-primitives-hub/core';

/** Outcome of the delete-time check for one recorded path. */
export type DeleteTarget =
  /** Remove `absolute` (a regular file or a symlink, never followed). */
  | { status: 'delete'; absolute: string }
  /** Nothing is there; there is nothing to remove. */
  | { status: 'missing' }
  /** Refused; the caller warns with `reason` and leaves the path alone. */
  | { status: 'skip'; reason: string };

const realRootOf = async (fs: RecordFs, root: string, file: string | undefined): Promise<string> => {
  try {
    return await fs.realpath(root);
  } catch (error) {
    throw recordError('RECORD.PATH_OUTSIDE_ROOT', { file, detail: 'the root folder does not resolve', cause: error });
  }
};

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
 * Check a recorded path's text, then its resolved folders against the disk.
 * @param fs - Filesystem port.
 * @param root - Absolute level root.
 * @param recordedPath - Path as recorded.
 * @param file - Record file to name in the error.
 * @returns The path with forward slashes, relative to the root.
 * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT` when the path is refused.
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
 * Check a recorded path just before deleting it; never throws for a refused path.
 * @param fs - Filesystem port.
 * @param root - Absolute level root.
 * @param recordedPath - Path as recorded.
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
