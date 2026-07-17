/**
 * Tests for `framework/parsers.ts`.
 *
 * CSV and enum parsing helpers used by command classes for `--kinds`,
 * `--source`, and similar flags.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  parseCsv,
  parseCsvEnum,
  parseCsvKinds,
  parseCsvNonEmpty,
} from '../../src/framework';

describe('parseCsv', () => {
  it('returns undefined for undefined input', () => {
    expect(parseCsv(undefined)).toBeUndefined();
  });

  it('splits, trims, and filters empty tokens', () => {
    expect(parseCsv(' a, b, ,c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('parseCsvEnum', () => {
  it('returns undefined for undefined input', () => {
    expect(parseCsvEnum(undefined, ['one', 'two'], 'Kind')).toBeUndefined();
  });

  it('returns valid enum values', () => {
    expect(parseCsvEnum('one, two', ['one', 'two', 'three'], 'Kind')).toEqual(['one', 'two']);
  });

  it('throws an error listing invalid values', () => {
    expect(() => parseCsvEnum('bad', ['one', 'two'], 'Kind')).toThrow('Invalid Kind value(s): bad');
  });
});

describe('parseCsvKinds', () => {
  it('returns undefined for undefined input', () => {
    expect(parseCsvKinds(undefined)).toBeUndefined();
  });

  it('parses valid primitive kinds', () => {
    expect(parseCsvKinds('prompt,agent')).toEqual(['prompt', 'agent']);
  });

  it('rejects invalid kinds', () => {
    expect(() => parseCsvKinds('prompt,not-a-kind')).toThrow('PrimitiveKind');
  });
});

describe('parseCsvNonEmpty', () => {
  it('returns undefined for undefined or empty results', () => {
    expect(parseCsvNonEmpty(undefined)).toBeUndefined();
    expect(parseCsvNonEmpty('   ')).toBeUndefined();
  });

  it('returns non-empty arrays', () => {
    expect(parseCsvNonEmpty('a')).toEqual(['a']);
  });
});
