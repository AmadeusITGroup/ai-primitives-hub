/**
 * Prototype-free parse and version gate (NFR1.1, NFR1.2, NFR4.4, BR1.8–BR1.10).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseRecord,
} from '../../../src/domain/install/record-parse';
import {
  isRegistryError,
} from '../../../src/domain/registry-error';

const FILE = 'ai-primitives-hub.lock.json';

const validRecord = (): Record<string, unknown> => ({
  $schema: 'https://github.com/AmadeusITGroup/ai-primitives-hub/schemas/lockfile.schema.json',
  version: '3.0.0',
  level: 'repository',
  generatedAt: '2026-10-25T15:00:00Z',
  generatedBy: 'ai-primitives-hub-cli@0.2.1',
  bundles: {
    'acme-tools': {
      tools: {
        kiro: {
          version: '1.2.0',
          sourceId: 'acme-github',
          sourceType: 'github',
          installedAt: '2026-10-25T15:00:00Z',
          files: [{ installedPath: '.kiro/steering/style.md', checksum: `sha256:${'a'.repeat(64)}` }]
        }
      }
    }
  },
  sources: { 'acme-github': { type: 'github', url: 'https://github.com/acme/tools' } }
});

/**
 * Parse and return the thrown error's code and context.
 * @param text - Record text.
 * @returns The code and context of the RegistryError thrown.
 */
const failure = (text: string): { code: string; detail: unknown; file: unknown } => {
  try {
    parseRecord(text, FILE);
  } catch (error) {
    if (isRegistryError(error)) {
      return { code: error.code, detail: error.context?.detail, file: error.context?.file };
    }
    throw error;
  }
  throw new Error('parseRecord should have thrown');
};

const prototypeSnapshot = (): string[] => Object.getOwnPropertyNames(Object.prototype).toSorted();

describe('parseRecord: valid records', () => {
  it('parses a 3.0.0 record', () => {
    const parsed = parseRecord(JSON.stringify(validRecord()), FILE);
    expect(parsed.version).toBe('3.0.0');
    expect(parsed).toEqual(validRecord());
  });

  it('accepts later 3.x versions', () => {
    const record = { ...validRecord(), version: '3.4.12' };
    expect(parseRecord(JSON.stringify(record)).version).toBe('3.4.12');
  });

  it('keeps unknown fields at every level', () => {
    const record = validRecord() as any;
    record.futureTop = { nested: [1, 2] };
    record.bundles['acme-tools'].owner = 'team-a';
    record.bundles['acme-tools'].tools.kiro.pinned = true;
    record.bundles['acme-tools'].tools.kiro.files[0].mode = 'copy';
    record.sources['acme-github'].mirror = 'https://mirror.example';
    const parsed = parseRecord(JSON.stringify(record)) as any;
    expect(parsed.futureTop).toEqual({ nested: [1, 2] });
    expect(parsed.bundles['acme-tools'].owner).toBe('team-a');
    expect(parsed.bundles['acme-tools'].tools.kiro.pinned).toBe(true);
    expect(parsed.bundles['acme-tools'].tools.kiro.files[0].mode).toBe('copy');
    expect(parsed.sources['acme-github'].mirror).toBe('https://mirror.example');
  });

  it('builds every object with a null prototype, inside arrays too', () => {
    const parsed = parseRecord(JSON.stringify(validRecord())) as any;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed.bundles)).toBeNull();
    expect(Object.getPrototypeOf(parsed.bundles['acme-tools'].tools.kiro)).toBeNull();
    expect(Array.isArray(parsed.bundles['acme-tools'].tools.kiro.files)).toBe(true);
    expect(Object.getPrototypeOf(parsed.bundles['acme-tools'].tools.kiro.files[0])).toBeNull();
  });
});

describe('parseRecord: forbidden keys (NFR4.4)', () => {
  const kiroEntry = '{"version":"1.0.0","sourceId":"s","sourceType":"github","installedAt":"2026-10-25T15:00:00Z","files":[]}';
  const wrap = (bundles: string, sources = '{}'): string =>
    `{"$schema":"x","version":"3.0.0","level":"repository","generatedAt":"2026-10-25T15:00:00Z","generatedBy":"t","bundles":${bundles},"sources":${sources}}`;

  it.each([
    ['__proto__ as a bundle id', wrap(`{"__proto__":{"tools":{"kiro":${kiroEntry}}}}`), '__proto__'],
    ['constructor as a bundle id', wrap(`{"constructor":{"tools":{"kiro":${kiroEntry}}}}`), 'constructor'],
    ['__proto__ as a source id', wrap('{}', '{"__proto__":{"type":"github","url":"u"}}'), '__proto__'],
    ['prototype as a tool key', wrap(`{"b":{"tools":{"prototype":${kiroEntry}}}}`), 'prototype'],
    ['__proto__ nested in an unknown field', wrap(`{"b":{"tools":{"kiro":${kiroEntry}},"extra":{"deep":{"__proto__":{"polluted":true}}}}}`), '__proto__'],
    ['__proto__ inside a files item', wrap('{"b":{"tools":{"kiro":{"version":"1","sourceId":"s","sourceType":"github","installedAt":"x","files":[{"__proto__":{"polluted":true}}]}}}}'), '__proto__'],
    ['__proto__ at the top level', '{"__proto__":{"polluted":true},"version":"3.0.0"}', '__proto__']
  ])('refuses %s and leaves Object.prototype unchanged', (_label, text, key) => {
    const before = prototypeSnapshot();
    const result = failure(text);
    expect(result.code).toBe('RECORD.MALFORMED');
    expect(result.detail).toBe(`forbidden key ${key}`);
    expect(result.file).toBe(FILE);
    expect(prototypeSnapshot()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('parseRecord: version gate before the schema (NFR1.2)', () => {
  const withVersion = (version: unknown): string => {
    const record = validRecord();
    if (version === undefined) {
      delete record.version;
    } else {
      record.version = version;
    }
    return JSON.stringify(record);
  };

  it.each([
    ['missing', undefined, 'missing version'],
    ['a number', 3, 'version is not a string'],
    ['null', null, 'version is not a string'],
    ['not semver', '3.0', 'version "3.0" is not MAJOR.MINOR.PATCH'],
    ['a prerelease', '3.0.0-beta.1', 'version "3.0.0-beta.1" is not MAJOR.MINOR.PATCH'],
    ['a leading zero', '03.0.0', 'version "03.0.0" is not MAJOR.MINOR.PATCH']
  ])('refuses a version that is %s as malformed', (_label, version, detail) => {
    expect(failure(withVersion(version))).toEqual({ code: 'RECORD.MALFORMED', detail, file: FILE });
  });

  it('refuses a newer major version', () => {
    expect(failure(withVersion('4.0.0'))).toEqual({ code: 'RECORD.NEWER_FORMAT', detail: 'format 4.0.0', file: FILE });
  });

  it('refuses an older major version under the new file name', () => {
    expect(failure(withVersion('2.0.0'))).toEqual({ code: 'RECORD.LEGACY_UNMIGRATED', detail: 'format 2.0.0', file: FILE });
  });

  it('checks the version before the shape, so a 4.0.0 record with an unknown shape is NEWER_FORMAT', () => {
    expect(failure('{"version":"4.0.0","bundles":"a future shape"}').code).toBe('RECORD.NEWER_FORMAT');
  });
});

describe('parseRecord: invalid JSON (NFR1.1)', () => {
  it('refuses invalid JSON without quoting the file contents', () => {
    const secretLooking = '{"version": "3.0.0", "token": "s3cr3t" ';
    try {
      parseRecord(secretLooking, FILE);
      expect.unreachable('parseRecord should throw');
    } catch (error) {
      expect(isRegistryError(error)).toBe(true);
      if (isRegistryError(error)) {
        expect(error.code).toBe('RECORD.MALFORMED');
        expect(error.context?.detail).toBe('not valid JSON');
        expect(JSON.stringify(error.toJSON())).not.toContain('s3cr3t');
        expect(error.cause).toBeInstanceOf(SyntaxError);
      }
    }
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"3.0.0"'],
    ['empty text', '']
  ])('refuses a top level that is %s', (_label, text) => {
    expect(failure(text).code).toBe('RECORD.MALFORMED');
  });

  it('works without a file name', () => {
    try {
      parseRecord('{');
      expect.unreachable('parseRecord should throw');
    } catch (error) {
      expect(isRegistryError(error) && error.context?.file).toBe(undefined);
    }
  });
});
