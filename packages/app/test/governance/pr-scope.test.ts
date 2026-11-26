import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
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

  it('accepts in-repository roots whose names start with two dots', async () => {
    await mkdir(path.join(root, '..prompts'));
    await writeFile(path.join(root, '..prompts/b.prompt.md'), 'Body');
    expect(await changedPrimitiveFiles(fs, root, ['..prompts/b.prompt.md'], ['..prompts'])).toEqual(['..prompts/b.prompt.md']);
    expect(await changedPrimitiveFiles(fs, root, ['..prompts/b.prompt.md'], [path.join(root, '..prompts')])).toEqual(['..prompts/b.prompt.md']);
  });

  it('keeps changed explicit file roots of any name when a kind is forced', async () => {
    await writeFile(path.join(root, 'prims/notes.md'), 'Body');
    expect(await changedPrimitiveFiles(fs, root, ['prims/notes.md'], ['prims/notes.md'], 'skill')).toEqual(['prims/notes.md']);
    expect(await changedPrimitiveFiles(fs, root, ['prims/notes.md'], ['prims'], 'skill')).toEqual([]);
  });

  it('re-validates a repository-root skill when a supporting file changes, preferring the nearest skill', async () => {
    await writeFile(path.join(root, 'SKILL.md'), 'Body');
    await mkdir(path.join(root, 'scripts'));
    await writeFile(path.join(root, 'scripts/tool.py'), '');
    await writeFile(path.join(root, 'prims/SKILL.md'), 'Body');
    expect(await changedPrimitiveFiles(fs, root, ['scripts/tool.py'], ['.'])).toEqual(['SKILL.md']);
    expect(await changedPrimitiveFiles(fs, root, ['README.md'], ['.'])).toEqual(['SKILL.md']);
    expect(await changedPrimitiveFiles(fs, root, ['prims/notes.txt'], ['.'])).toEqual(['prims/SKILL.md']);
  });

  it('does not pull in parent skills when a non-skill kind is forced', async () => {
    await writeFile(path.join(root, 'prims/SKILL.md'), 'Body');
    expect(await changedPrimitiveFiles(fs, root, ['prims/notes.txt'], ['prims'], 'mcp-server')).toEqual([]);
    expect(await changedPrimitiveFiles(fs, root, ['prims/notes.txt'], ['prims'], 'skill')).toEqual(['prims/SKILL.md']);
  });

  it('selects both a changed primitive and the skill it supports', async () => {
    await writeFile(path.join(root, 'prims/SKILL.md'), 'Body');
    expect(await changedPrimitiveFiles(fs, root, ['prims/a.prompt.md'], ['prims'])).toEqual(['prims/SKILL.md', 'prims/a.prompt.md']);
    expect(await changedPrimitiveFiles(fs, root, ['prims/a.prompt.md'], ['prims'], 'prompt')).toEqual(['prims/a.prompt.md']);
  });

  it('fails when a changed path cannot be listed, but drops paths whose parent was deleted', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const unreadable = Object.create(fs) as NodeFileSystem;
    Object.defineProperty(unreadable, 'readDir', { value: () => Promise.reject(denied) });
    await expect(changedPrimitiveFiles(unreadable, root, ['prims/a.prompt.md'], ['prims'])).rejects.toThrow('EACCES');
    expect(await changedPrimitiveFiles(fs, root, ['gone/deleted.prompt.md'], ['.'])).toEqual([]);
  });

  it('keeps changed dangling symlinks so path validation reports them, and drops deleted files', async () => {
    await symlink(path.join(root, 'missing.md'), path.join(root, 'prims/broken.prompt.md'));
    await symlink(path.join(root, 'missing.md'), path.join(root, 'prims/notes.md'));
    expect(await changedPrimitiveFiles(fs, root, ['prims/broken.prompt.md', 'prims/deleted.prompt.md'], ['prims']))
      .toEqual(['prims/broken.prompt.md']);
    expect(await changedPrimitiveFiles(fs, root, ['prims/notes.md'], ['prims/notes.md'], 'skill')).toEqual(['prims/notes.md']);
  });
});
