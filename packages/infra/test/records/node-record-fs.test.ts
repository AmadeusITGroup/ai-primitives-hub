/**
 * Tests for infra/records/node-record-fs.ts against a real temp folder.
 */
import {
  createHash,
} from 'node:crypto';
import * as fs from 'node:fs';
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
  NodeRecordFs,
} from '../../src/records/node-record-fs';
import {
  createTempDir,
} from '../helpers/temp-dir';

const canSymlink = (dir: string): boolean => {
  try {
    fs.symlinkSync(join(dir, 'probe-target'), join(dir, 'probe-link'), 'file');
    fs.unlinkSync(join(dir, 'probe-link'));
    return true;
  } catch {
    return false;
  }
};

describe('NodeRecordFs', () => {
  let dir: string;
  let cleanup: () => void;
  let recordFs: NodeRecordFs;

  beforeEach(() => {
    [dir, cleanup] = createTempDir('node-record-fs-');
    recordFs = new NodeRecordFs();
  });

  afterEach(() => {
    cleanup();
  });

  describe('lstat', () => {
    it('reports files and folders, and undefined for a missing path', async () => {
      fs.writeFileSync(join(dir, 'a.txt'), 'abc');
      fs.mkdirSync(join(dir, 'sub'));
      expect(await recordFs.lstat(join(dir, 'a.txt'))).toEqual({ kind: 'file', size: 3 });
      expect((await recordFs.lstat(join(dir, 'sub')))?.kind).toBe('directory');
      expect(await recordFs.lstat(join(dir, 'missing'))).toBeUndefined();
      expect(await recordFs.lstat(join(dir, 'a.txt', 'below-a-file'))).toBeUndefined();
    });

    it('does not follow a final symlink', async (context) => {
      if (!canSymlink(dir)) {
        context.skip();
      }
      fs.writeFileSync(join(dir, 'target.txt'), 'x');
      fs.symlinkSync(join(dir, 'target.txt'), join(dir, 'link.txt'), 'file');
      expect((await recordFs.lstat(join(dir, 'link.txt')))?.kind).toBe('symlink');
      expect(await recordFs.realpath(join(dir, 'link.txt'))).toBe(fs.realpathSync(join(dir, 'target.txt')));
      expect(await recordFs.exists(join(dir, 'link.txt'))).toBe(true);
    });
  });

  describe('readCapped', () => {
    it('reads a file shorter than the cap whole, across several chunks', async () => {
      const bytes = Buffer.alloc(200 * 1024, 7);
      fs.writeFileSync(join(dir, 'big.bin'), bytes);
      const read = await recordFs.readCapped(join(dir, 'big.bin'), bytes.length + 1);
      expect(read.byteLength).toBe(bytes.length);
      expect(Buffer.from(read).equals(bytes)).toBe(true);
    });

    it('stops at the cap whatever the file size', async () => {
      fs.writeFileSync(join(dir, 'over.bin'), Buffer.alloc(100_001, 1));
      const read = await recordFs.readCapped(join(dir, 'over.bin'), 100_000);
      expect(read.byteLength).toBe(100_000);
    });

    it('returns exactly the cap for a file of exactly that size', async () => {
      fs.writeFileSync(join(dir, 'exact.bin'), Buffer.alloc(4096, 2));
      expect((await recordFs.readCapped(join(dir, 'exact.bin'), 4096)).byteLength).toBe(4096);
    });

    it('rejects for a missing file', async () => {
      await expect(recordFs.readCapped(join(dir, 'missing'), 10)).rejects.toThrow();
    });
  });

  describe('writeFile', () => {
    it('creates a file with UTF-8 text', async () => {
      await recordFs.writeFile(join(dir, 'new.txt'), 'héllo');
      expect(fs.readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('héllo');
    });

    it('refuses an existing path (exclusive create) and leaves it unchanged', async () => {
      fs.writeFileSync(join(dir, 'taken.txt'), 'old');
      await expect(recordFs.writeFile(join(dir, 'taken.txt'), 'new')).rejects.toMatchObject({ code: 'EEXIST' });
      expect(fs.readFileSync(join(dir, 'taken.txt'), 'utf8')).toBe('old');
    });
  });

  describe('unlink', () => {
    it('removes a file', async () => {
      fs.writeFileSync(join(dir, 'gone.txt'), 'x');
      await recordFs.unlink(join(dir, 'gone.txt'));
      expect(fs.existsSync(join(dir, 'gone.txt'))).toBe(false);
    });

    it('refuses a folder and leaves it and its contents in place', async () => {
      fs.mkdirSync(join(dir, 'keep'));
      fs.writeFileSync(join(dir, 'keep', 'inner.txt'), 'x');
      await expect(recordFs.unlink(join(dir, 'keep'))).rejects.toMatchObject({ code: 'EISDIR' });
      expect(fs.existsSync(join(dir, 'keep', 'inner.txt'))).toBe(true);
    });

    it('removes a symlink without touching its target', async (context) => {
      if (!canSymlink(dir)) {
        context.skip();
      }
      fs.writeFileSync(join(dir, 'target.txt'), 'x');
      fs.symlinkSync(join(dir, 'target.txt'), join(dir, 'link.txt'), 'file');
      await recordFs.unlink(join(dir, 'link.txt'));
      expect(fs.existsSync(join(dir, 'link.txt'))).toBe(false);
      expect(fs.readFileSync(join(dir, 'target.txt'), 'utf8')).toBe('x');
    });
  });

  it('hashFile streams a sha256: digest of the bytes', async () => {
    const bytes = Buffer.from('record bytes\n');
    fs.writeFileSync(join(dir, 'h.txt'), bytes);
    const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(await recordFs.hashFile(join(dir, 'h.txt'))).toBe(expected);
  });

  it('rename replaces the destination', async () => {
    fs.writeFileSync(join(dir, 'from.txt'), 'new');
    fs.writeFileSync(join(dir, 'to.txt'), 'old');
    await recordFs.rename(join(dir, 'from.txt'), join(dir, 'to.txt'));
    expect(fs.readFileSync(join(dir, 'to.txt'), 'utf8')).toBe('new');
    expect(fs.existsSync(join(dir, 'from.txt'))).toBe(false);
  });

  it('mkdir, readdir, exists and appendFile work together', async () => {
    await recordFs.mkdir(join(dir, 'a', 'b'), { recursive: true });
    await recordFs.appendFile(join(dir, 'a', 'b', 'log'), 'one\n');
    await recordFs.appendFile(join(dir, 'a', 'b', 'log'), 'two\n');
    expect(fs.readFileSync(join(dir, 'a', 'b', 'log'), 'utf8')).toBe('one\ntwo\n');
    expect(await recordFs.readdir(join(dir, 'a', 'b'))).toEqual(['log']);
    expect(await recordFs.exists(join(dir, 'a'))).toBe(true);
    expect(await recordFs.exists(join(dir, 'nope'))).toBe(false);
    await recordFs.mkdir(join(dir, 'single'));
    expect(fs.statSync(join(dir, 'single')).isDirectory()).toBe(true);
  });
});
