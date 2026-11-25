import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NodeFileSystem,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  changedPrimitiveFiles,
} from '../../src/governance/pr-scope';

const fs = new NodeFileSystem();
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pr-scope-'));
  await mkdir(path.join(root, 'prims'));
  await writeFile(path.join(root, 'prims/a.prompt.md'), '---\ndescription: A\n---\nBody');
  await writeFile(path.join(root, 'prims/servers.json'), '{}');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('changedPrimitiveFiles', () => {
  it('matches changed files under absolute roots inside the repository', async () => {
    expect(await changedPrimitiveFiles(fs, root, ['prims/a.prompt.md'], [path.join(root, 'prims')])).toEqual(['prims/a.prompt.md']);
    expect(await changedPrimitiveFiles(fs, root, ['prims/a.prompt.md'], [root])).toEqual(['prims/a.prompt.md']);
  });

  it('rejects roots outside the repository', async () => {
    await expect(changedPrimitiveFiles(fs, root, ['prims/a.prompt.md'], [path.dirname(root)])).rejects.toThrow('outside the repository');
    await expect(changedPrimitiveFiles(fs, root, ['prims/a.prompt.md'], ['../elsewhere'])).rejects.toThrow('outside the repository');
  });

  it('selects files of a forced kind whose names are not recognised', async () => {
    expect(await changedPrimitiveFiles(fs, root, ['prims/servers.json'], ['prims'])).toEqual([]);
    expect(await changedPrimitiveFiles(fs, root, ['prims/servers.json', 'prims/a.prompt.md'], ['prims'], 'mcp-server'))
      .toEqual(['prims/servers.json']);
  });
});
