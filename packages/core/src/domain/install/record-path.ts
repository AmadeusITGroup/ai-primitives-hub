/**
 * Layer A path checks for recorded paths (NFR4.1, BR1.5).
 *
 * Pure text checks on a recorded file `path`, with no filesystem access. They run
 * on every path read from a record and again on the realpath'd path relative
 * to the root (Layer B, `confinePath` in `app`). Both `/` and `\` count as
 * separators, so a path is judged the same way on every OS.
 *
 * {@link relativeInside} is the one "is this path below the root" check every
 * record reader and writer uses on absolute paths.
 * @module domain/install/record-path
 */
import * as path from 'node:path';
import {
  recordError,
} from './record-errors';

const DRIVE_LETTER = /^[A-Za-z]:/;
const SHORT_NAME = /~\d/;
const SEPARATORS = /[/\\]/;

const segmentProblem = (segment: string): string | undefined => {
  if (segment === '' || segment === '.' || segment === '..') {
    return 'empty, "." or ".." segment';
  }
  if (segment.toLowerCase() === '.git') {
    return '".git" segment';
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return 'segment ends in a dot or a space';
  }
  if (SHORT_NAME.test(segment)) {
    return 'segment looks like an 8.3 short name';
  }
  if (segment.includes(':')) {
    return 'segment contains ":"';
  }
  return undefined;
};

/**
 * Find why a recorded path is not allowed.
 * @param recordedPath - Path as written in the record.
 * @returns The reason, or `undefined` when the path is allowed.
 */
export const findRecordedPathProblem = (recordedPath: string): string | undefined => {
  if (typeof recordedPath !== 'string' || recordedPath === '') {
    return 'empty path';
  }
  if (recordedPath.startsWith('//') || recordedPath.startsWith('\\\\')) {
    return 'UNC path';
  }
  if (recordedPath.startsWith('/') || recordedPath.startsWith('\\')) {
    return 'absolute path';
  }
  if (DRIVE_LETTER.test(recordedPath)) {
    return 'drive letter';
  }
  for (const segment of recordedPath.split(SEPARATORS)) {
    const problem = segmentProblem(segment);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
};

/**
 * Check a recorded path and normalize it to forward slashes.
 *
 * Refuses an empty, absolute, UNC or drive-letter path; any empty, `.` or `..`
 * segment (which also refuses the root itself); a `.git` segment in any case;
 * a segment ending in a dot or a space; an 8.3 short name (`~` and a digit);
 * and a `:` in a segment (NTFS alternate data streams).
 * @param recordedPath - Path as written in the record, relative to the level root.
 * @param file - Record file to name in the error, if any.
 * @returns The path with forward slashes.
 * @throws {RegistryError} `RECORD.PATH_OUTSIDE_ROOT` when the path is not allowed.
 */
export const checkRecordedPath = (recordedPath: string, file?: string): string => {
  const problem = findRecordedPathProblem(recordedPath);
  if (problem !== undefined) {
    throw recordError('RECORD.PATH_OUTSIDE_ROOT', {
      file,
      detail: `${problem}: ${JSON.stringify(recordedPath)}`
    });
  }
  return recordedPath.split(SEPARATORS).join('/');
};

/** Options of {@link relativeInside}. */
export interface RelativeInsideOptions {
  /** Count the root itself as inside; it then gives `''`. Defaults to `false`. */
  allowRoot?: boolean;
}

/**
 * Path of `candidate` relative to `root`, with forward slashes, when it sits
 * below `root` (NFR4.1). Path segments are compared, never a string prefix:
 * `..`, anything starting with `../` and a result on another drive are outside,
 * while a name such as `..notes` below the root is inside.
 * @param root - Absolute folder.
 * @param candidate - Absolute path.
 * @param options - Whether the root itself counts as inside.
 * @returns The relative path, or `undefined` for anything outside the root,
 * and for the root itself unless `allowRoot` is set.
 */
export const relativeInside = (root: string, candidate: string, options: RelativeInsideOptions = {}): string | undefined => {
  const relative = path.relative(root, candidate);
  if (relative === '') {
    return options.allowRoot === true ? '' : undefined;
  }
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
};
