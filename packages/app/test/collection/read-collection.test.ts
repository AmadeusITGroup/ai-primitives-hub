import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  generateMarkdown,
  resolveCollectionReadmePath,
  validateAllCollections,
  validateCollectionFile,
} from '../../src/collection/read-collection';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-collection-test-'));
  fs.mkdirSync(path.join(tempDir, 'collections'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'prompts', 'hello.prompt.md'), '# Hello\n');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const writeCollection = (content: string): string => {
  const collectionFile = path.join('collections', 'foo.collection.yml');
  fs.writeFileSync(path.join(tempDir, collectionFile), content);
  return collectionFile;
};

describe('collection README handling', () => {
  it('resolves a normalized nested README path', () => {
    expect(resolveCollectionReadmePath({ readme: { path: 'docs\\collection-overview.md' } })).toBe('docs/collection-overview.md');
  });

  it('validates an existing README without warnings', () => {
    fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'docs', 'collection-overview.md'), '# Overview\n');
    const collectionPath = writeCollection(`id: foo
name: Foo
readme:
  path: docs/collection-overview.md
items:
  - path: prompts/hello.prompt.md
    kind: prompt
`);

    const result = validateCollectionFile(tempDir, collectionPath);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('rejects a declared README that does not exist', () => {
    const collectionPath = writeCollection(`id: foo
name: Foo
readme:
  path: docs/missing.md
items: []
`);

    const result = validateCollectionFile(tempDir, collectionPath);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('collections/foo.collection.yml: readme referenced file not found: docs/missing.md');
  });

  it('collects an invalid README path without aborting validation of other collections', () => {
    const invalidCollection = writeCollection(`id: foo
name: Foo
readme:
  path: ../README.md
items: []
`);
    const validCollection = path.join('collections', 'bar.collection.yml');
    fs.writeFileSync(path.join(tempDir, validCollection), `id: bar
name: Bar
items: []
`);

    const result = validateAllCollections(tempDir, [invalidCollection, validCollection]);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('readme.path'))).toBe(true);
    expect(result.fileResults).toHaveLength(2);
    expect(result.fileResults[1].collection?.id).toBe('bar');
  });

  it('warns when no README is declared and includes it in markdown output', () => {
    const collectionPath = writeCollection(`id: foo
name: Foo
items: []
`);

    const result = validateAllCollections(tempDir, [collectionPath]);

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('collections/foo.collection.yml: Collection has no readme. Consider adding a readme to help users understand this collection.');
    expect(generateMarkdown(result, 1)).toContain('### Warnings');
  });
});
