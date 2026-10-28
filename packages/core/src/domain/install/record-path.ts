/**
 * Layer A path checks for recorded paths (NFR4.1, BR1.5).
 *
 * Pure text checks on an `installedPath`, with no filesystem access. They run
 * on every path read from a record and again on the realpath'd path relative
 * to the root (Layer B, `confinePath` in `app`). Both `/` and `\` count as
 * separators, so a path is judged the same way on every OS.
 * @module domain/install/record-path
 */
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
