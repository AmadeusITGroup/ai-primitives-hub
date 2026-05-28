/**
 * Tests for regex utility functions
 */

import * as assert from 'node:assert';
import {
  createSafeRegex,
  escapeRegex,
  replaceAll,
  replaceVariables,
} from '../../src/utils/regex-utils';

suite('regexUtils', () => {
  suite('escapeRegex', () => {
    test('should escape all special regex characters', () => {
      const input = '.*+?^${}()|[]\\';
      const escaped = escapeRegex(input);

      // All special chars should be escaped
      assert.strictEqual(escaped, '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');

      // Should create valid regex
      const regex = new RegExp(escaped);
      assert.ok(regex.test(input), 'Escaped regex should match original string');
    });

    test('should handle Windows paths', () => {
      const windowsPath = 'C:\\Users\\Test\\file.txt';
      const escaped = escapeRegex(windowsPath);

      // Should not throw
      const regex = new RegExp(escaped);
      assert.ok(regex.test(windowsPath), 'Should match Windows path');
    });

    test('should handle paths with parentheses', () => {
      const path = 'C:\\Program Files (x86)\\App';
      const escaped = escapeRegex(path);

      const regex = new RegExp(escaped);
      assert.ok(regex.test(path), 'Should match path with parentheses');
    });

    test('should handle paths with brackets', () => {
      const path = '/usr/local/[config]/file';
      const escaped = escapeRegex(path);

      const regex = new RegExp(escaped);
      assert.ok(regex.test(path), 'Should match path with brackets');
    });

    test('should handle empty string', () => {
      const escaped = escapeRegex('');
      assert.strictEqual(escaped, '');
    });

    test('should handle string with no special chars', () => {
      const input = 'simple-string_123';
      const escaped = escapeRegex(input);
      assert.strictEqual(escaped, input, 'Should not modify string without special chars');
    });

    test('should handle unicode characters', () => {
      const unicode = 'path/with/émojis/🎉/file.txt';
      const escaped = escapeRegex(unicode);
      const regex = new RegExp(escaped);
      assert.ok(regex.test(unicode), 'Should handle unicode characters');
    });

    test('should handle very long strings efficiently', () => {
      const longPath = 'C:\\' + 'folder\\'.repeat(100) + 'file.txt';
      const start = Date.now();
      const escaped = escapeRegex(longPath);
      const duration = Date.now() - start;
      assert.ok(duration < 100, 'Should escape long strings quickly');
      assert.ok(escaped.length > longPath.length, 'Should escape backslashes');
    });
  });

  suite('createSafeRegex', () => {
    test('should create regex from string with special chars', () => {
      const pattern = 'path.with.dots';
      const regex = createSafeRegex(pattern);

      assert.ok(regex.test('path.with.dots'), 'Should match literal string');
      assert.ok(!regex.test('pathXwithXdots'), 'Should not match with different chars');
    });

    test('should support regex flags', () => {
      const pattern = 'test';
      const regex = createSafeRegex(pattern, 'i');

      assert.ok(regex.test('TEST'), 'Should be case-insensitive with i flag');
      assert.ok(regex.test('Test'), 'Should be case-insensitive with i flag');
    });

    test('should support global flag', () => {
      const pattern = 'a';
      const regex = createSafeRegex(pattern, 'g');
      const text = 'aaa';

      const matches = text.match(regex);
      assert.strictEqual(matches?.length, 3, 'Should match all occurrences with g flag');
    });
  });

  suite('replaceAll', () => {
    test('should replace all occurrences', () => {
      const text = 'foo bar foo baz foo';
      const result = replaceAll(text, 'foo', 'qux');

      assert.strictEqual(result, 'qux bar qux baz qux');
    });

    test('should handle Windows paths in replacement', () => {
      const template = 'Path: PLACEHOLDER';
      const windowsPath = 'C:\\Users\\Test\\file.txt';
      const result = replaceAll(template, 'PLACEHOLDER', windowsPath);

      assert.strictEqual(result, `Path: ${windowsPath}`);
      assert.ok(result.includes('\\Users\\'), 'Should preserve backslashes');
    });

    test('should handle $ in replacement', () => {
      const template = 'Price: AMOUNT';
      const result = replaceAll(template, 'AMOUNT', '$100');

      assert.strictEqual(result, 'Price: $100');
    });

    test('should handle special regex chars in search', () => {
      const text = 'Value: {{KEY}}';
      const result = replaceAll(text, '{{KEY}}', 'value');

      assert.strictEqual(result, 'Value: value');
    });

    test('should handle dots in search pattern', () => {
      const text = 'file.txt is a file.txt';
      const result = replaceAll(text, 'file.txt', 'doc.pdf');

      assert.strictEqual(result, 'doc.pdf is a doc.pdf');
    });

    test('should handle empty replacement', () => {
      const text = 'foo bar foo';
      const result = replaceAll(text, 'foo', '');

      assert.strictEqual(result, ' bar ');
    });

    test('should handle no matches', () => {
      const text = 'foo bar baz';
      const result = replaceAll(text, 'qux', 'replacement');

      assert.strictEqual(result, text, 'Should return original text if no matches');
    });
  });

  suite('replaceVariables', () => {
    test('should replace multiple variables', () => {
      const template = 'Hello {{NAME}}, you are {{AGE}} years old';
      const result = replaceVariables(template, {
        NAME: 'Alice',
        AGE: '30'
      });

      assert.strictEqual(result, 'Hello Alice, you are 30 years old');
    });

    test('should handle Windows paths in values', () => {
      const template = 'Install to: {{PATH}}';
      const result = replaceVariables(template, {
        PATH: 'C:\\Users\\Test\\AppData'
      });

      assert.strictEqual(result, 'Install to: C:\\Users\\Test\\AppData');
    });

    test('should handle special characters in values', () => {
      const template = 'Price: {{PRICE}}, Path: {{PATH}}';
      const result = replaceVariables(template, {
        PRICE: '$100',
        PATH: 'C:\\Program Files (x86)'
      });

      assert.strictEqual(result, 'Price: $100, Path: C:\\Program Files (x86)');
    });

    test('should support custom prefix and suffix', () => {
      const template = 'Hello {NAME}, version {VERSION}';
      const result = replaceVariables(template, {
        NAME: 'Bob',
        VERSION: '1.0.0'
      }, {
        prefix: '{',
        suffix: '}'
      });

      assert.strictEqual(result, 'Hello Bob, version 1.0.0');
    });

    test('should handle missing variables', () => {
      const template = 'Hello {{NAME}}, {{MISSING}}';
      const result = replaceVariables(template, {
        NAME: 'Alice'
      });

      assert.strictEqual(result, 'Hello Alice, {{MISSING}}', 'Should leave unmatched placeholders');
    });

    test('should handle empty variables object', () => {
      const template = 'Hello {{NAME}}';
      const result = replaceVariables(template, {});

      assert.strictEqual(result, template, 'Should return original template');
    });

    test('should handle variables with dots in names', () => {
      const template = 'Value: {{MY.KEY}}';
      const result = replaceVariables(template, {
        'MY.KEY': 'test-value'
      });

      assert.strictEqual(result, 'Value: test-value');
    });

    test('should handle nested template syntax', () => {
      const template = 'Value: {{{{KEY}}}}';
      const result = replaceVariables(template, { KEY: 'value' });
      // Should replace inner {{KEY}} first, leaving outer braces
      assert.strictEqual(result, 'Value: {{value}}');
    });

    test('should handle malformed template syntax gracefully', () => {
      const template = 'Value: {{KEY} or {KEY}} or {{KEY';
      const result = replaceVariables(template, { KEY: 'value' });
      // Should only replace properly formed {{KEY}}
      assert.strictEqual(result, 'Value: {{KEY} or {KEY}} or {{KEY');
    });
  });
});
