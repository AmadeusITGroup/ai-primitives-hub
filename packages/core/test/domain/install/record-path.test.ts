/**
 * Layer A recorded-path checks (NFR4.1, BR1.5).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  checkRecordedPath,
  findRecordedPathProblem,
} from '../../../src/domain/install/record-path';
import {
  isRegistryError,
} from '../../../src/domain/registry-error';

const expectRefused = (recordedPath: string): void => {
  let thrown: unknown;
  try {
    checkRecordedPath(recordedPath, 'ai-primitives-hub.lock.json');
  } catch (error) {
    thrown = error;
  }
  expect(isRegistryError(thrown), `expected ${JSON.stringify(recordedPath)} to be refused`).toBe(true);
  if (isRegistryError(thrown)) {
    expect(thrown.code).toBe('RECORD.PATH_OUTSIDE_ROOT');
    expect(thrown.context?.file).toBe('ai-primitives-hub.lock.json');
  }
};

describe('checkRecordedPath', () => {
  it.each([
    ['empty', ''],
    ['POSIX absolute', '/etc/passwd'],
    ['backslash absolute', '\\Windows\\system.ini'],
    ['parent escape', '../../.ssh/config'],
    ['inner parent segment', '.github/../../outside'],
    ['backslash parent segment', String.raw`a\..\b`],
    ['drive letter', String.raw`C:\x`],
    ['drive letter with forward slash', 'c:/x'],
    ['UNC backslashes', String.raw`\\server\share`],
    ['UNC forward slashes', '//server/share'],
    ['the root itself', '.'],
    ['dot segment', './a'],
    ['empty segment', 'a//b'],
    ['trailing separator', 'a/'],
    ['.git at the root', '.git/config'],
    ['.git upper case', '.GIT/config'],
    ['.git nested', 'sub/.git/config'],
    ['.git with backslash', String.raw`sub\.Git\hooks\pre-commit`],
    ['trailing dot', '.git./config'],
    ['trailing space', '.git /config'],
    ['8.3 short name', 'GIT~1/config'],
    ['NTFS alternate data stream', '.git::$INDEX_ALLOCATION/config'],
    ['colon inside a segment', '.github/prompts/a:b.md']
  ])('refuses %s (%s)', (_label, recordedPath) => {
    expectRefused(recordedPath);
  });

  it.each([
    ['.github/prompts/my-prompt.prompt.md', '.github/prompts/my-prompt.prompt.md'],
    ['.kiro/steering/style.md', '.kiro/steering/style.md'],
    ['.gitignore', '.gitignore'],
    ['.github/.gitkeep', '.github/.gitkeep'],
    ['docs/v1.2/notes.md', 'docs/v1.2/notes.md'],
    ['..hidden/file', '..hidden/file']
  ])('accepts %s', (recordedPath, expected) => {
    expect(checkRecordedPath(recordedPath)).toBe(expected);
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(checkRecordedPath(String.raw`.kiro\steering\style.md`)).toBe('.kiro/steering/style.md');
  });

  it('names the reason and the offending path in the error detail', () => {
    try {
      checkRecordedPath('sub/.git/config');
      expect.unreachable('checkRecordedPath should throw');
    } catch (error) {
      expect(isRegistryError(error)).toBe(true);
      if (isRegistryError(error)) {
        expect(error.context?.detail).toBe('".git" segment: "sub/.git/config"');
        expect(error.context?.file).toBeUndefined();
      }
    }
  });
});

describe('findRecordedPathProblem', () => {
  it('returns undefined for an allowed path', () => {
    expect(findRecordedPathProblem('.github/instructions/a.instructions.md')).toBeUndefined();
  });

  it('refuses a non-string value read from an untrusted record', () => {
    expect(findRecordedPathProblem(42 as unknown as string)).toBe('empty path');
  });

  it('reports a UNC path before treating it as absolute', () => {
    expect(findRecordedPathProblem('//server/share')).toBe('UNC path');
    expect(findRecordedPathProblem('/abs')).toBe('absolute path');
  });
});
