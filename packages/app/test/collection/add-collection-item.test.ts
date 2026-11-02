import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Collection,
} from '@ai-primitives-hub/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  addCollectionItem,
} from '../../src/collection/add-collection-item';
import {
  validateCollectionFile,
  writeCollection,
} from '../../src/collection/read-collection';

const baseCollection = (): Collection => ({ id: 'foo', name: 'Foo', description: 'Foo collection', items: [] });

describe('addCollectionItem', () => {
  it('appends path, kind, title and description and returns the same collection', () => {
    const collection = baseCollection();
    const result = addCollectionItem(collection, { path: 'prompts/hello.prompt.md', kind: 'prompt', title: 'Hello', description: 'Says hello' });
    expect(result).toBe(collection);
    expect(collection.items).toEqual([{ path: 'prompts/hello.prompt.md', kind: 'prompt', title: 'Hello', description: 'Says hello' }]);
  });

  it('omits title and description when they are absent or empty, and never writes name', () => {
    const collection = baseCollection();
    addCollectionItem(collection, { path: 'plugins/p/plugin.json', kind: 'plugin', title: '', description: undefined });
    expect(collection.items).toHaveLength(1);
    const item = collection.items[0];
    expect(item).toEqual({ path: 'plugins/p/plugin.json', kind: 'plugin' });
    expect(Object.keys(item)).toEqual(['path', 'kind']);
    expect(item).not.toHaveProperty('name');
  });

  it('initializes items when missing or null', () => {
    const missing = { id: 'foo', name: 'Foo' } as unknown as Collection;
    addCollectionItem(missing, { path: 'a.prompt.md', kind: 'prompt' });
    expect(missing.items).toEqual([{ path: 'a.prompt.md', kind: 'prompt' }]);
    const nullItems = { id: 'foo', name: 'Foo', items: null } as unknown as Collection;
    addCollectionItem(nullItems, { path: 'a.prompt.md', kind: 'prompt' });
    expect(nullItems.items).toEqual([{ path: 'a.prompt.md', kind: 'prompt' }]);
  });

  it.each([
    ['a mapping', { 'prompts/a.prompt.md': 'prompt' }],
    ['a string', 'prompts/a.prompt.md'],
    ['a number', 0]
  ])('rejects items that is %s and leaves it unchanged', (_label, items) => {
    const collection = { id: 'foo', name: 'Foo', items } as unknown as Collection;
    expect(() => addCollectionItem(collection, { path: 'b.prompt.md', kind: 'prompt' })).toThrow(
      'Collection items must be an array; fix the collection file before adding items'
    );
    expect(collection.items).toEqual(items);
  });

  describe('written collection', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-collection-item-test-'));
      fs.mkdirSync(path.join(tempDir, 'collections'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'prompts'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'prompts', 'hello.prompt.md'), '# Hello\n');
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('passes validateCollectionFile with no errors', () => {
      const collectionFile = path.join('collections', 'foo.collection.yml');
      const collection = addCollectionItem(baseCollection(), { path: 'prompts/hello.prompt.md', kind: 'prompt', title: 'Hello', description: 'Says hello' });
      writeCollection(tempDir, collectionFile, collection);
      const result = validateCollectionFile(tempDir, collectionFile);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });
});
