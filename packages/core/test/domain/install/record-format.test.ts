/**
 * Contract tests for the 3.0.0 install record format (C1): the parse and
 * version gate (`parseRecord`) and the recorded-path check (`checkRecordedPath`).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isRecordError,
} from '../../../src/domain/install/record-errors';
import {
  parseRecord,
} from '../../../src/domain/install/record-parse';
import {
  checkRecordedPath,
} from '../../../src/domain/install/record-path';

const FILE = 'ai-primitives-hub.lock.json';

const ENTRY = {
  version: '1.2.0',
  sourceId: 'acme-github',
  sourceType: 'github',
  installedAt: '2026-10-25T15:00:00Z',
  files: [{ path: '.kiro/steering/style.md', checksum: `sha256:${'a'.repeat(64)}` }]
};

const recordText = (overrides: Record<string, unknown> = {}, bundles = `{"acme-tools":{"tools":{"kiro":${JSON.stringify(ENTRY)}}}}`): string => {
  const head = JSON.stringify({
    $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
    version: '3.0.0',
    level: 'repository',
    generatedAt: '2026-10-25T15:00:00Z',
    generatedBy: 'ai-primitives-hub-cli@0.3.0',
    sources: { 'acme-github': { type: 'github', url: 'https://github.com/acme/tools' } },
    ...overrides
  });
  return `${head.slice(0, -1)},"bundles":${bundles}}`;
};

/**
 * Run `fn` and return the `RECORD.*` code it throws.
 * @param fn - Call expected to throw a record error.
 */
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (isRecordError(error)) {
      expect(error.context?.file).toBe(FILE);
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a RECORD.* error');
};

describe('parseRecord', () => {
  it('parses a valid 3.0.0 record and keeps unknown fields', () => {
    const parsed = parseRecord(recordText({ futureField: { kept: true } }), FILE);

    expect(parsed).toEqual({ ...JSON.parse(recordText()), futureField: { kept: true } });
    expect(Object.getPrototypeOf(parsed)).toBeNull();
  });

  it.each([
    ['invalid JSON', '{ "version": "3.0.0", ', 'RECORD.MALFORMED'],
    ['a missing version', recordText({ version: undefined }), 'RECORD.MALFORMED'],
    ['a non-semver version', recordText({ version: '3.0' }), 'RECORD.MALFORMED'],
    ['a numeric version', recordText({ version: 3 }), 'RECORD.MALFORMED'],
    ['a newer major version', recordText({ version: '4.0.0' }), 'RECORD.NEWER_FORMAT'],
    ['an older major version', recordText({ version: '2.0.0' }), 'RECORD.LEGACY_UNMIGRATED']
  ])('refuses %s with %s', (_label, text, code) => {
    expect(codeOf(() => parseRecord(text, FILE))).toBe(code);
  });

  it.each([
    ['__proto__ as a bundle id', `{"__proto__":{"tools":{"kiro":${JSON.stringify(ENTRY)}}}}`],
    ['constructor as a bundle id', `{"constructor":{"tools":{"kiro":${JSON.stringify(ENTRY)}}}}`],
    ['__proto__ nested in an entry', `{"b":{"tools":{"kiro":{"files":[{"__proto__":{"polluted":true}}]}}}}`],
    ['constructor nested in an entry', `{"b":{"tools":{"kiro":{"extra":{"constructor":{"polluted":true}}}}}}`]
  ])('refuses %s and leaves Object.prototype untouched', (_label, bundles) => {
    const before = Object.getOwnPropertyNames(Object.prototype).toSorted();

    expect(codeOf(() => parseRecord(recordText({}, bundles), FILE))).toBe('RECORD.MALFORMED');

    expect(Object.getOwnPropertyNames(Object.prototype).toSorted()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('checkRecordedPath', () => {
  it.each([
    '..',
    String.raw`a\..\b`,
    '/etc/passwd',
    String.raw`C:\x`,
    String.raw`\\server\share`,
    '.',
    '.git/config',
    '.GIT/config',
    'sub/.git/config',
    '.git./config',
    'GIT~1/config',
    '.git::$INDEX_ALLOCATION/config'
  ])('refuses %s with RECORD.PATH_OUTSIDE_ROOT', (recordedPath) => {
    expect(codeOf(() => checkRecordedPath(recordedPath, FILE))).toBe('RECORD.PATH_OUTSIDE_ROOT');
  });

  it.each([
    ['.github/prompts/my.prompt.md', '.github/prompts/my.prompt.md'],
    ['.gitignore', '.gitignore'],
    ['..hidden/file', '..hidden/file'],
    [String.raw`.kiro\steering\style.md`, '.kiro/steering/style.md']
  ])('accepts %s as %s', (recordedPath, expected) => {
    expect(checkRecordedPath(recordedPath, FILE)).toBe(expected);
  });
});
