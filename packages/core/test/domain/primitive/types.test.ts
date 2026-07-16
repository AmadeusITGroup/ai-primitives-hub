import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isPrimitiveKind,
  PRIMITIVE_KINDS,
} from '../../../src/domain/primitive/types';

describe('isPrimitiveKind', () => {
  it('accepts every declared primitive kind', () => {
    for (const kind of PRIMITIVE_KINDS) {
      expect(isPrimitiveKind(kind)).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(isPrimitiveKind('not-a-kind')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isPrimitiveKind(undefined)).toBe(false);
    expect(isPrimitiveKind(null)).toBe(false);
    expect(isPrimitiveKind(42)).toBe(false);
  });
});
