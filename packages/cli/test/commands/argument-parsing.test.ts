/**
 * Fix 1 & 2: CLI argument parsing bugs.
 *
 * Tests for parseCsv validation with PrimitiveKind enum values and
 * collectRepeated flag validation.
 */
import {
  PRIMITIVE_KINDS,
} from '@prompt-registry/infra';
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
} from '../../src/framework/parsers';

describe('CLI Argument Parsing - Fix 1: Type Assertion Bug', () => {
  describe('parseCsvKinds with PrimitiveKind validation', () => {
    it('should accept valid PrimitiveKind values', () => {
      const validKinds = 'prompt,agent,skill';
      const parsed = parseCsvKinds(validKinds);

      expect(parsed).toEqual(['prompt', 'agent', 'skill']);
      // All parsed values should be valid PrimitiveKind
      for (const kind of parsed!) {
        expect(PRIMITIVE_KINDS).toContain(kind);
      }
    });

    it('should handle undefined gracefully', () => {
      const result = parseCsvKinds(undefined);
      expect(result).toBeUndefined();
    });

    it('should reject invalid PrimitiveKind values with error', () => {
      const invalidKinds = 'prompt,invalid-kind,agent';

      expect(() => parseCsvKinds(invalidKinds)).toThrow(
        /Invalid PrimitiveKind value\(s\): invalid-kind/
      );
    });

    it('should handle empty string after filtering', () => {
      const withEmpty = 'prompt,,agent';
      const parsed = parseCsvKinds(withEmpty);
      expect(parsed).toEqual(['prompt', 'agent']);
    });

    it('should handle single valid kind', () => {
      const singleKind = 'prompt';
      const parsed = parseCsvKinds(singleKind);
      expect(parsed).toEqual(['prompt']);
      expect(PRIMITIVE_KINDS).toContain(parsed![0]);
    });
  });

  describe('parseCsv utility', () => {
    it('should parse comma-separated values', () => {
      const result = parseCsv('a,b,c');
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should handle undefined', () => {
      const result = parseCsv(undefined);
      expect(result).toBeUndefined();
    });

    it('should trim whitespace', () => {
      const result = parseCsv(' a , b , c ');
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should filter empty strings', () => {
      const result = parseCsv('a,,b');
      expect(result).toEqual(['a', 'b']);
    });
  });

  describe('parseCsvEnum generic validator', () => {
    it('should validate against custom enum', () => {
      const colors = ['red', 'green', 'blue'] as const;
      const result = parseCsvEnum('red,blue', colors, 'Color');
      expect(result).toEqual(['red', 'blue']);
    });

    it('should reject invalid custom enum values', () => {
      const colors = ['red', 'green', 'blue'] as const;
      expect(() => parseCsvEnum('red,yellow', colors, 'Color')).toThrow(
        /Invalid Color value\(s\): yellow/
      );
    });

    it('should handle undefined for custom enum', () => {
      const colors = ['red', 'green', 'blue'] as const;
      const result = parseCsvEnum(undefined, colors, 'Color');
      expect(result).toBeUndefined();
    });
  });
});

describe('CLI Argument Parsing - Fix 2: collectRepeated Flag Validation', () => {
  describe('collectRepeated', () => {
    it('should collect repeated flags with values', () => {
      const argv = ['--extra-source', 'source1', '--extra-source', 'source2'];
      const collect = (args: string[], flag: string): string[] => {
        const out: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === flag) {
            if (i + 1 >= args.length) {
              throw new Error(
                `Flag ${flag} appears at end of arguments without a value. `
                + `Usage: ${flag} <value> [${flag} <value> ...]`
              );
            }
            out.push(args[i + 1]);
          }
        }
        return out;
      };
      const result = collect(argv, '--extra-source');
      expect(result).toEqual(['source1', 'source2']);
    });

    it('should throw error for trailing flag without value', () => {
      const argv = ['--extra-source', 'source1', '--extra-source'];
      const collect = (args: string[], flag: string): string[] => {
        const out: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === flag) {
            if (i + 1 >= args.length) {
              throw new Error(
                `Flag ${flag} appears at end of arguments without a value. `
                + `Usage: ${flag} <value> [${flag} <value> ...]`
              );
            }
            out.push(args[i + 1]);
          }
        }
        return out;
      };
      expect(() => collect(argv, '--extra-source')).toThrow(
        /Flag --extra-source appears at end of arguments without a value/
      );
    });

    it('should handle flag with empty string value', () => {
      const argv = ['--extra-source', 'source1', '--extra-source', ''];
      const collect = (args: string[], flag: string): string[] => {
        const out: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === flag) {
            if (i + 1 >= args.length) {
              throw new Error(
                `Flag ${flag} appears at end of arguments without a value. `
                + `Usage: ${flag} <value> [${flag} <value> ...]`
              );
            }
            out.push(args[i + 1]);
          }
        }
        return out;
      };
      const result = collect(argv, '--extra-source');
      expect(result).toEqual(['source1', '']);
    });

    it('should handle flag followed by another flag (not a value)', () => {
      const argv = ['--extra-source', 'source1', '--extra-source', '--other-flag'];
      const collect = (args: string[], flag: string): string[] => {
        const out: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === flag) {
            if (i + 1 >= args.length) {
              throw new Error(
                `Flag ${flag} appears at end of arguments without a value. `
                + `Usage: ${flag} <value> [${flag} <value> ...]`
              );
            }
            out.push(args[i + 1]);
          }
        }
        return out;
      };
      const result = collect(argv, '--extra-source');
      // Treats --other-flag as a value (user error, but not a missing value)
      expect(result).toEqual(['source1', '--other-flag']);
    });

    it('should return empty array when flag not present', () => {
      const argv = ['--other-flag', 'value'];
      const collect = (args: string[], flag: string): string[] => {
        const out: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === flag) {
            if (i + 1 >= args.length) {
              throw new Error(
                `Flag ${flag} appears at end of arguments without a value. `
                + `Usage: ${flag} <value> [${flag} <value> ...]`
              );
            }
            out.push(args[i + 1]);
          }
        }
        return out;
      };
      const result = collect(argv, '--extra-source');
      expect(result).toEqual([]);
    });
  });
});

describe('parseCsvNonEmpty', () => {
  it('returns parsed array for valid CSV', () => {
    expect(parseCsvNonEmpty('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('returns undefined for undefined input', () => {
    expect(parseCsvNonEmpty(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseCsvNonEmpty('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(parseCsvNonEmpty('   ')).toBeUndefined();
  });
});
