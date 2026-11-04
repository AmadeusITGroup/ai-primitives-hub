import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  NodeFileSystem,
} from '../../src/fs/node-filesystem';
import {
  FileCollectionIndex,
} from '../../src/governance/file-collection-index';

describe('authoritative file collection index', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'file-collection-index-'));
    await writeFile(path.join(root, 'hub-config.yml'), 'sources:\n  - id: tools\n    enabled: true\n    url: https://github.com/owner/tools\nprofiles: []\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads each document once and exposes canonical ID lookups as a Map', async () => {
    await writeFile(path.join(root, 'collection-index.yml'), 'schemaVersion: 1\ncollections:\n  tools: {sourceId: tools}\n');
    const fs = new NodeFileSystem();
    const read = vi.spyOn(fs, 'readFile');
    const inventory = await new FileCollectionIndex(fs, path.join(root, 'hub-config.yml')).read();
    expect(read).toHaveBeenCalledTimes(2);
    expect(inventory.registry?.owners).toBeInstanceOf(Map);
    expect(inventory.registry?.owners.get('tools')).toBe('tools');
    expect(inventory.unverifiedSources).toEqual([]);
  });

  it.each([
    'schemaVersion: 1\nschemaVersion: 1\ncollections: {}\n',
    'schemaVersion: 1\ncollections:\n  tools: {sourceId: tools, sourceId: other}\n',
    'schemaVersion: 1\ncollections: []\n',
    'schemaVersion: 1\ncollections:\n  tools: null\n'
  ])('rejects duplicate and malformed registrations', async (content) => {
    await writeFile(path.join(root, 'collection-index.yml'), content);
    await expect(new FileCollectionIndex(new NodeFileSystem(), path.join(root, 'hub-config.yml')).read()).rejects.toThrow();
  });
});
