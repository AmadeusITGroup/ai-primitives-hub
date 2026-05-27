/**
 * Collections module tests
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listCollectionFiles,
  readCollection,
  resolveCollectionItemPaths,
} from '@prompt-registry/cli';

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

describe('Collections Module', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collections-test-');
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  describe('listCollectionFiles()', () => {
    it('should find .collection.yml files', () => {
      writeFile(tempDir, 'collections/first.collection.yml', 'id: first\nname: First\nitems: []');
      writeFile(tempDir, 'collections/second.collection.yml', 'id: second\nname: Second\nitems: []');
      writeFile(tempDir, 'collections/readme.md', '# Collections');

      const files = listCollectionFiles(tempDir);

      assert.strictEqual(files.length, 2);
      assert.ok(files.every((f: string) => f.endsWith('.collection.yml')));
      assert.ok(files.some((f: string) => f.includes('first.collection.yml')));
      assert.ok(files.some((f: string) => f.includes('second.collection.yml')));
    });

    it('should return empty array when no collections exist', () => {
      fs.mkdirSync(path.join(tempDir, 'collections'), { recursive: true });
      writeFile(tempDir, 'collections/readme.md', '# Collections');

      const files = listCollectionFiles(tempDir);

      assert.strictEqual(files.length, 0);
    });
  });

  describe('readCollection()', () => {
    it('should parse required fields', () => {
      writeFile(tempDir, 'collections/test.collection.yml', `
id: test-collection
name: Test Collection
description: A test collection
version: "1.0.0"
items:
  - path: prompts/test.md
    kind: prompt
`);

      const collection = readCollection(tempDir, 'collections/test.collection.yml');

      assert.strictEqual(collection.id, 'test-collection');
      assert.strictEqual(collection.name, 'Test Collection');
      assert.ok(Array.isArray(collection.items));
      assert.strictEqual(collection.items.length, 1);
    });

    it('should handle optional fields', () => {
      writeFile(tempDir, 'collections/minimal.collection.yml', `
id: minimal
name: Minimal
items: []
`);

      const collection = readCollection(tempDir, 'collections/minimal.collection.yml');

      assert.strictEqual(collection.id, 'minimal');
      assert.strictEqual(collection.name, 'Minimal');
      assert.deepStrictEqual(collection.items, []);
      assert.strictEqual(collection.version, undefined);
    });

    it('should throw for invalid YAML', () => {
      writeFile(tempDir, 'collections/invalid.collection.yml', `
id: test
name: Test
items: [unclosed bracket
`);

      assert.throws(
        () => readCollection(tempDir, 'collections/invalid.collection.yml'),
        /yaml|parse/i
      );
    });

    it('should accept absolute paths', () => {
      writeFile(tempDir, 'collections/test.collection.yml', `
id: test
name: Test
items: []
`);

      const absPath = path.join(tempDir, 'collections/test.collection.yml');
      const collection = readCollection(tempDir, absPath);

      assert.strictEqual(collection.id, 'test');
    });
  });

  describe('resolveCollectionItemPaths()', () => {
    it('should return repo-root relative paths', () => {
      const collection = {
        id: 'test',
        name: 'Test',
        items: [
          { path: 'prompts/first.md', kind: 'prompt' },
          { path: 'prompts/second.md', kind: 'prompt' },
          { path: 'instructions/inst.md', kind: 'instruction' }
        ]
      };

      const paths = resolveCollectionItemPaths(tempDir, collection);

      assert.strictEqual(paths.length, 3);
      assert.ok(paths.every((p: string) => !p.startsWith('..')));
      assert.ok(paths.every((p: string) => !p.startsWith('/')));
      assert.deepStrictEqual(paths, [
        'prompts/first.md',
        'prompts/second.md',
        'instructions/inst.md'
      ]);
    });

    it('should handle empty items array', () => {
      const collection = {
        id: 'empty',
        name: 'Empty',
        items: []
      };

      const paths = resolveCollectionItemPaths(tempDir, collection);

      assert.deepStrictEqual(paths, []);
    });

    it('should normalize Windows-style paths', () => {
      const collection = {
        id: 'test',
        name: 'Test',
        items: [{ path: 'prompts\\windows\\style.md', kind: 'prompt' }]
      };

      const paths = resolveCollectionItemPaths(tempDir, collection);

      assert.strictEqual(paths.length, 1);
      assert.ok(!paths[0].includes('\\'));
    });

    it('should filter out items without path', () => {
      const collection = {
        id: 'test',
        name: 'Test',
        items: [
          { path: 'prompts/valid.md', kind: 'prompt' },
          { kind: 'prompt' } as any, // Missing path
          { path: '', kind: 'prompt' }, // Empty path
          { path: 'prompts/another.md', kind: 'prompt' }
        ]
      };

      const paths = resolveCollectionItemPaths(tempDir, collection);

      assert.strictEqual(paths.length, 2);
      assert.deepStrictEqual(paths, ['prompts/valid.md', 'prompts/another.md']);
    });

    it('should include all files in skill directory when kind is skill', () => {
      // Create a skill directory structure
      writeFile(tempDir, 'skills/my-skill/SKILL.md', '# My Skill\nDescription here');
      writeFile(tempDir, 'skills/my-skill/assets/diagram.png', 'fake-png-content');
      writeFile(tempDir, 'skills/my-skill/references/doc.md', '# Reference Doc');
      writeFile(tempDir, 'skills/my-skill/scripts/helper.js', 'console.log("helper")');

      const collection = {
        id: 'test',
        name: 'Test',
        items: [{ path: 'skills/my-skill/SKILL.md', kind: 'skill' }]
      };

      const paths = resolveCollectionItemPaths(tempDir, collection);

      assert.ok(paths.length >= 4, `Should include all skill files, got ${paths.length}`);
      assert.ok(paths.includes('skills/my-skill/SKILL.md'));
      assert.ok(paths.includes('skills/my-skill/assets/diagram.png'));
      assert.ok(paths.includes('skills/my-skill/references/doc.md'));
      assert.ok(paths.includes('skills/my-skill/scripts/helper.js'));
    });

    it('should include skill directory files alongside regular prompts', () => {
      // Create skill directory
      writeFile(tempDir, 'skills/my-skill/SKILL.md', '# My Skill');
      writeFile(tempDir, 'skills/my-skill/assets/image.png', 'fake-png');

      // Create regular prompt
      writeFile(tempDir, 'prompts/simple.prompt.md', '# Simple Prompt');

      const collection = {
        id: 'test',
        name: 'Test',
        items: [
          { path: 'skills/my-skill/SKILL.md', kind: 'skill' },
          { path: 'prompts/simple.prompt.md', kind: 'prompt' }
        ]
      };

      const paths = resolveCollectionItemPaths(tempDir, collection);

      assert.ok(paths.includes('skills/my-skill/SKILL.md'));
      assert.ok(paths.includes('skills/my-skill/assets/image.png'));
      assert.ok(paths.includes('prompts/simple.prompt.md'));
    });
  });
});
