import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  isPrimitiveKind,
  normalizePrimitiveKind,
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

describe('normalizePrimitiveKind', () => {
  it('returns canonical kinds unchanged', () => {
    for (const kind of PRIMITIVE_KINDS) {
      expect(normalizePrimitiveKind(kind)).toBe(kind);
    }
  });

  it('maps legacy route and manifest aliases to canonical kinds', () => {
    expect(normalizePrimitiveKind('prompts')).toBe('prompt');
    expect(normalizePrimitiveKind('instructions')).toBe('instruction');
    expect(normalizePrimitiveKind('chatmode')).toBe('chat-mode');
    expect(normalizePrimitiveKind('skills')).toBe('skill');
    expect(normalizePrimitiveKind('mcp')).toBe('mcp-server');
  });

  it('normalizes surrounding whitespace and casing', () => {
    expect(normalizePrimitiveKind('  OUTPUT-STYLES ')).toBe('output-style');
  });

  it('returns null for unknown and non-string values', () => {
    expect(normalizePrimitiveKind('not-a-kind')).toBeNull();
    expect(normalizePrimitiveKind(undefined)).toBeNull();
    expect(normalizePrimitiveKind(null)).toBeNull();
  });
});
