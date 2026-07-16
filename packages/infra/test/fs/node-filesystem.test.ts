import {
  join,
} from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  NodeFileSystem,
} from '../../src/fs/node-filesystem';
import {
  createTempDir,
} from '../helpers/temp-dir';

describe('NodeFileSystem', () => {
  let dir: string;
  let cleanup: () => void;
  let fs: NodeFileSystem;

  beforeEach(() => {
    [dir, cleanup] = createTempDir('node-filesystem-');
    fs = new NodeFileSystem();
  });

  afterEach(() => {
    cleanup();
  });

  it('writes then reads back a text file', async () => {
    const filePath = join(dir, 'hello.txt');
    await fs.writeFile(filePath, 'hello world');

    expect(await fs.readFile(filePath)).toBe('hello world');
  });

  it('rejects reading a file that does not exist', async () => {
    await expect(fs.readFile(join(dir, 'missing.txt'))).rejects.toThrow();
  });

  it('writes then reads back JSON, pretty-printed with a trailing newline', async () => {
    const filePath = join(dir, 'data.json');
    await fs.writeJson(filePath, { a: 1, b: [2, 3] });

    expect(await fs.readJson(filePath)).toEqual({ a: 1, b: [2, 3] });
    expect(await fs.readFile(filePath)).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
  });

  it('exists() is true for files and directories, false otherwise', async () => {
    const filePath = join(dir, 'file.txt');
    await fs.writeFile(filePath, 'x');

    expect(await fs.exists(filePath)).toBe(true);
    expect(await fs.exists(dir)).toBe(true);
    expect(await fs.exists(join(dir, 'nope'))).toBe(false);
  });

  it('mkdir creates nested directories only when recursive is set', async () => {
    const nested = join(dir, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });

    expect(await fs.exists(nested)).toBe(true);
  });

  it('rejects a non-recursive mkdir when the parent is missing', async () => {
    await expect(fs.mkdir(join(dir, 'a', 'b'))).rejects.toThrow();
  });

  it('readDir lists entry names; readDirEntries adds directory/file typing', async () => {
    await fs.writeFile(join(dir, 'file.txt'), 'x');
    await fs.mkdir(join(dir, 'subdir'));

    expect((await fs.readDir(dir)).toSorted()).toEqual(['file.txt', 'subdir']);
    expect((await fs.readDirEntries(dir)).toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'file.txt', isDirectory: false },
      { name: 'subdir', isDirectory: true }
    ]);
  });

  it('stat reports file size, directory/file flags, and mtime', async () => {
    const filePath = join(dir, 'file.txt');
    await fs.writeFile(filePath, 'hello');

    const fileStat = await fs.stat(filePath);
    expect(fileStat.isFile).toBe(true);
    expect(fileStat.isDirectory).toBe(false);
    expect(fileStat.size).toBe(5);
    expect(fileStat.mtimeMs).toBeGreaterThan(0);

    const dirStat = await fs.stat(dir);
    expect(dirStat.isDirectory).toBe(true);
    expect(dirStat.isFile).toBe(false);
  });

  it('rejects stat on a missing path', async () => {
    await expect(fs.stat(join(dir, 'missing'))).rejects.toThrow();
  });

  it('remove deletes a single file without recursive', async () => {
    const filePath = join(dir, 'file.txt');
    await fs.writeFile(filePath, 'x');
    await fs.remove(filePath);

    expect(await fs.exists(filePath)).toBe(false);
  });

  it('remove is a no-op (not a throw) for an already-missing path', async () => {
    await expect(fs.remove(join(dir, 'missing'))).resolves.toBeUndefined();
  });

  it('remove deletes a non-empty directory only when recursive is set', async () => {
    const subdir = join(dir, 'subdir');
    await fs.mkdir(subdir);
    await fs.writeFile(join(subdir, 'file.txt'), 'x');

    await fs.remove(subdir, { recursive: true });

    expect(await fs.exists(subdir)).toBe(false);
  });
});
