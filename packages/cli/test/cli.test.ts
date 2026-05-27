/**
 * CLI utilities tests
 */
import * as assert from 'node:assert';
import {
  getPositionalArg,
  hasFlag,
  parseMultiArg,
  parseSingleArg,
} from '../src/cli';

describe('CLI Module', () => {
  describe('parseSingleArg()', () => {
    it('should parse single argument', () => {
      const argv = ['--collection-file', 'test.yml'];
      const result = parseSingleArg(argv, '--collection-file');
      assert.strictEqual(result, 'test.yml');
    });

    it('should return undefined for missing argument', () => {
      const argv = ['--other', 'value'];
      const result = parseSingleArg(argv, '--collection-file');
      assert.strictEqual(result, undefined);
    });

    it('should return undefined for flag without value', () => {
      const argv = ['--collection-file'];
      const result = parseSingleArg(argv, '--collection-file');
      assert.strictEqual(result, undefined);
    });

    it('should handle multiple arguments', () => {
      const argv = ['--first', 'one', '--second', 'two', '--third', 'three'];
      assert.strictEqual(parseSingleArg(argv, '--first'), 'one');
      assert.strictEqual(parseSingleArg(argv, '--second'), 'two');
      assert.strictEqual(parseSingleArg(argv, '--third'), 'three');
    });
  });

  describe('parseMultiArg()', () => {
    it('should parse multiple occurrences', () => {
      const argv = ['--changed-path', 'file1.md', '--changed-path', 'file2.md'];
      const result = parseMultiArg(argv, '--changed-path');
      assert.deepStrictEqual(result, ['file1.md', 'file2.md']);
    });

    it('should return empty array for missing argument', () => {
      const argv = ['--other', 'value'];
      const result = parseMultiArg(argv, '--changed-path');
      assert.deepStrictEqual(result, []);
    });

    it('should handle single occurrence', () => {
      const argv = ['--changed-path', 'file1.md'];
      const result = parseMultiArg(argv, '--changed-path');
      assert.deepStrictEqual(result, ['file1.md']);
    });
  });

  describe('hasFlag()', () => {
    it('should return true for present flag', () => {
      const argv = ['--verbose', '--dry-run'];
      assert.strictEqual(hasFlag(argv, '--verbose'), true);
      assert.strictEqual(hasFlag(argv, '--dry-run'), true);
    });

    it('should return false for missing flag', () => {
      const argv = ['--verbose'];
      assert.strictEqual(hasFlag(argv, '--dry-run'), false);
    });

    it('should handle empty argv', () => {
      assert.strictEqual(hasFlag([], '--verbose'), false);
    });
  });

  describe('getPositionalArg()', () => {
    it('should get positional argument by index', () => {
      const argv = ['first', 'second', 'third'];
      assert.strictEqual(getPositionalArg(argv, 0), 'first');
      assert.strictEqual(getPositionalArg(argv, 1), 'second');
      assert.strictEqual(getPositionalArg(argv, 2), 'third');
    });

    it('should skip flags and their values', () => {
      const argv = ['--flag', 'value', 'positional'];
      assert.strictEqual(getPositionalArg(argv, 0), 'positional');
    });

    it('should return undefined for out of range index', () => {
      const argv = ['first'];
      assert.strictEqual(getPositionalArg(argv, 1), undefined);
    });

    it('should handle mixed flags and positionals', () => {
      // Note: getPositionalArg treats any non-flag after a flag as its value
      // So '--bool-flag' consumes 'pos3' as its value
      const argv = ['pos1', '--flag', 'value', 'pos2'];
      assert.strictEqual(getPositionalArg(argv, 0), 'pos1');
      assert.strictEqual(getPositionalArg(argv, 1), 'pos2');
    });
  });
});
