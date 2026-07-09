/**
 * Validation module tests
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateMarkdown,
  isSafeRepoRelativePath,
  normalizeRepoRelativePath,
  validateAllCollections,
  validateCollectionFile,
  validateCollectionId,
  validateCollectionObject,
  validateItemKind,
  validateVersion,
  VALIDATION_RULES,
} from '../src/validate';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('Validation Module', () => {
  describe('VALIDATION_RULES', () => {
    it('should have expected structure', () => {
      assert.ok(VALIDATION_RULES.collectionId);
      assert.ok(VALIDATION_RULES.collectionId.pattern instanceof RegExp);
      assert.strictEqual(typeof VALIDATION_RULES.collectionId.maxLength, 'number');
      assert.ok(VALIDATION_RULES.version);
      assert.ok(VALIDATION_RULES.version.pattern instanceof RegExp);
      assert.ok(Array.isArray(VALIDATION_RULES.itemKinds));
      assert.ok(VALIDATION_RULES.itemKinds.length > 0);
    });
  });

  describe('validateCollectionId()', () => {
    it('should accept valid lowercase IDs', () => {
      const result = validateCollectionId('my-collection');
      assert.strictEqual(result.valid, true);
    });

    it('should accept IDs with numbers', () => {
      const result = validateCollectionId('collection-123');
      assert.strictEqual(result.valid, true);
    });

    it('should reject empty ID', () => {
      const result = validateCollectionId('');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('required'));
    });

    it('should reject ID with uppercase', () => {
      const result = validateCollectionId('My-Collection');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('lowercase'));
    });

    it('should reject ID with spaces', () => {
      const result = validateCollectionId('my collection');
      assert.strictEqual(result.valid, false);
    });

    it('should reject ID exceeding max length', () => {
      const longId = 'a'.repeat(VALIDATION_RULES.collectionId.maxLength + 1);
      const result = validateCollectionId(longId);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('at most'));
    });
  });

  describe('validateVersion()', () => {
    it('should accept valid semver', () => {
      const result = validateVersion('1.0.0');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.normalized, '1.0.0');
    });

    it('should return default for undefined', () => {
      const result = validateVersion(undefined);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.normalized, VALIDATION_RULES.version.default);
    });

    it('should return default for null', () => {
      const result = validateVersion(null);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.normalized, VALIDATION_RULES.version.default);
    });

    it('should reject invalid version format', () => {
      const result = validateVersion('1.0');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('semantic versioning'));
    });

    it('should reject non-string version', () => {
      const result = validateVersion(123 as unknown as string);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('string'));
    });
  });

  describe('validateItemKind()', () => {
    it('should accept valid kinds', () => {
      // Filter out deprecated kinds that may be in the schema but are rejected by validation
      const validKinds = VALIDATION_RULES.itemKinds.filter(
        (k) => !VALIDATION_RULES.deprecatedKinds[k.toLowerCase()]
      );
      for (const kind of validKinds) {
        const result = validateItemKind(kind);
        assert.strictEqual(result.valid, true, `Expected ${kind} to be valid`);
      }
    });

    it('should accept skill kind', () => {
      const result = validateItemKind('skill');
      assert.strictEqual(result.valid, true);
    });

    it('should reject deprecated chatmode', () => {
      const result = validateItemKind('chatmode');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.deprecated, true);
      assert.strictEqual(result.replacement, 'agent');
    });

    it('should reject deprecated chat-mode', () => {
      const result = validateItemKind('chat-mode');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.deprecated, true);
    });

    it('should reject invalid kind', () => {
      const result = validateItemKind('invalid-kind');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('Must be one of'));
    });

    it('should reject empty kind', () => {
      const result = validateItemKind('');
      assert.strictEqual(result.valid, false);
    });
  });

  describe('normalizeRepoRelativePath()', () => {
    it('should normalize Windows paths', () => {
      const result = normalizeRepoRelativePath('prompts\\test.md');
      assert.strictEqual(result, 'prompts/test.md');
    });

    it('should remove leading slash', () => {
      const result = normalizeRepoRelativePath('/prompts/test.md');
      assert.strictEqual(result, 'prompts/test.md');
    });

    it('should normalize redundant slashes', () => {
      const result = normalizeRepoRelativePath('prompts//test.md');
      assert.strictEqual(result, 'prompts/test.md');
    });

    it('should throw for empty path', () => {
      assert.throws(() => normalizeRepoRelativePath(''), /non-empty string/);
    });

    it('should throw for path traversal', () => {
      assert.throws(() => normalizeRepoRelativePath('../outside'), /traverse outside/);
    });

    it('should handle dot segments', () => {
      const result = normalizeRepoRelativePath('prompts/./test.md');
      assert.strictEqual(result, 'prompts/test.md');
    });
  });

  describe('isSafeRepoRelativePath()', () => {
    it('should return true for valid paths', () => {
      assert.strictEqual(isSafeRepoRelativePath('prompts/test.md'), true);
    });

    it('should return false for traversal paths', () => {
      assert.strictEqual(isSafeRepoRelativePath('../outside'), false);
    });

    it('should return false for empty paths', () => {
      assert.strictEqual(isSafeRepoRelativePath(''), false);
    });
  });

  describe('validateCollectionObject()', () => {
    it('should accept valid collection', () => {
      const collection = {
        id: 'test-collection',
        name: 'Test Collection',
        items: [{ path: 'prompts/test.md', kind: 'prompt' }]
      };
      const result = validateCollectionObject(collection, 'test.yml');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should accept a collection with a skill item', () => {
      const collection = {
        id: 'test-collection',
        name: 'Test Collection',
        items: [{ path: 'skills/my-skill/SKILL.md', kind: 'skill' }]
      };
      const result = validateCollectionObject(collection, 'test.yml');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should reject missing id', () => {
      const collection = {
        name: 'Test Collection',
        items: []
      };
      const result = validateCollectionObject(collection, 'test.yml');
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('id')));
    });

    it('should reject missing name', () => {
      const collection = {
        id: 'test',
        items: []
      };
      const result = validateCollectionObject(collection, 'test.yml');
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('name')));
    });

    it('should reject missing items', () => {
      const collection = {
        id: 'test',
        name: 'Test'
      };
      const result = validateCollectionObject(collection, 'test.yml');
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('items')));
    });

    it('should validate item paths', () => {
      const collection = {
        id: 'test',
        name: 'Test',
        items: [{ path: '../outside', kind: 'prompt' }]
      };
      const result = validateCollectionObject(collection, 'test.yml');
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('repo-root relative')));
    });

    it('should validate item kinds', () => {
      const collection = {
        id: 'test',
        name: 'Test',
        items: [{ path: 'prompts/test.md', kind: 'invalid' }]
      };
      const result = validateCollectionObject(collection, 'test.yml');
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('Invalid item kind')));
    });
  });

  describe('validateCollectionFile()', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('validate-test-');
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    it('should validate valid collection file', () => {
      writeFile(tempDir, 'collections/test.collection.yml', `
id: test
name: Test
items:
  - path: prompts/test.md
    kind: prompt
`);
      writeFile(tempDir, 'prompts/test.md', '# Test Prompt');

      const result = validateCollectionFile(tempDir, 'collections/test.collection.yml');
      assert.strictEqual(result.ok, true);
      assert.ok(result.collection);
      assert.strictEqual(result.collection.id, 'test');
    });

    it('should report missing referenced files', () => {
      writeFile(tempDir, 'collections/test.collection.yml', `
id: test
name: Test
items:
  - path: prompts/missing.md
    kind: prompt
`);

      const result = validateCollectionFile(tempDir, 'collections/test.collection.yml');
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('not found')));
    });

    it('should report YAML parse errors', () => {
      writeFile(tempDir, 'collections/test.collection.yml', `
id: test
name: Test
items: [unclosed
`);

      const result = validateCollectionFile(tempDir, 'collections/test.collection.yml');
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('YAML parse error')));
    });

    it('should report missing collection file', () => {
      const result = validateCollectionFile(tempDir, 'collections/missing.collection.yml');
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('not found')));
    });
  });

  describe('validateAllCollections()', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = createTempDir('validate-all-test-');
    });

    afterEach(() => {
      cleanup(tempDir);
    });

    it('should validate multiple collections', () => {
      writeFile(tempDir, 'collections/first.collection.yml', `
id: first
name: First
items: []
`);
      writeFile(tempDir, 'collections/second.collection.yml', `
id: second
name: Second
items: []
`);

      const result = validateAllCollections(tempDir, [
        'collections/first.collection.yml',
        'collections/second.collection.yml'
      ]);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.fileResults.length, 2);
    });

    it('should detect duplicate IDs', () => {
      writeFile(tempDir, 'collections/first.collection.yml', `
id: duplicate
name: First
items: []
`);
      writeFile(tempDir, 'collections/second.collection.yml', `
id: duplicate
name: Second
items: []
`);

      const result = validateAllCollections(tempDir, [
        'collections/first.collection.yml',
        'collections/second.collection.yml'
      ]);
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('Duplicate collection ID')));
    });

    it('should detect duplicate names', () => {
      writeFile(tempDir, 'collections/first.collection.yml', `
id: first
name: Same Name
items: []
`);
      writeFile(tempDir, 'collections/second.collection.yml', `
id: second
name: Same Name
items: []
`);

      const result = validateAllCollections(tempDir, [
        'collections/first.collection.yml',
        'collections/second.collection.yml'
      ]);
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes('Duplicate collection name')));
    });
  });

  describe('generateMarkdown()', () => {
    it('should generate success markdown', () => {
      const result = {
        ok: true,
        errors: [],
        warnings: [],
        fileResults: []
      };
      const md = generateMarkdown(result, 2);
      assert.ok(md.includes('✅'));
      assert.ok(md.includes('2 collection(s)'));
    });

    it('should generate failure markdown with errors', () => {
      const result = {
        ok: false,
        errors: ['Error 1', 'Error 2'],
        warnings: [],
        fileResults: []
      };
      const md = generateMarkdown(result, 2);
      assert.ok(md.includes('❌'));
      assert.ok(md.includes('2 error(s)'));
      assert.ok(md.includes('Error 1'));
      assert.ok(md.includes('Error 2'));
    });

    it('should include warnings in markdown', () => {
      const result = {
        ok: true,
        errors: [],
        warnings: ['test.yml: Collection has no readme. Consider adding a readme to help users understand this collection.'],
        fileResults: []
      };
      const md = generateMarkdown(result, 1);
      assert.ok(md.includes('⚠️'));
      assert.ok(md.includes('no readme'));
    });
  });
});
