/**
 * Text-only checks for recorded paths. Both `/` and `\` count as separators,
 * so a path is judged the same way on every OS; `confinePath` in `app` adds
 * the filesystem check.
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
 * Why a recorded path is not allowed, or `undefined` when it is.
 * @param recordedPath - Path as recorded.
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
 * @param recordedPath - Path as recorded.
 * @param file - Record file to name in the error, if any.
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
 * Path of `candidate` relative to `root`, with forward slashes, or `undefined`
 * when it is outside. Segments are compared, not string prefixes.
 * @param root - Absolute folder.
 * @param candidate - Absolute path.
 * @param options - Whether the root itself counts as inside.
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
