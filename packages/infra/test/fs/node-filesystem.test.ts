/**
 * Coverage tests for infra/fs/node-filesystem.ts.
 *
 * Tests NodeFileSystem class methods.
 */
import * as fsp from 'node:fs/promises';
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

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn()
}));

describe('NodeFileSystem', () => {
  let fsAdapter: NodeFileSystem;

  beforeEach(() => {
    fsAdapter = new NodeFileSystem();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readFile', () => {
    it('reads file as UTF-8 string', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('file content');
      const content = await fsAdapter.readFile('/path/to/file.txt');
      expect(content).toBe('file content');
      expect(fsp.readFile).toHaveBeenCalledWith('/path/to/file.txt', 'utf8');
    });
  });

  describe('writeFile', () => {
    it('writes file as UTF-8 string', async () => {
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await fsAdapter.writeFile('/path/to/file.txt', 'content');
      expect(fsp.writeFile).toHaveBeenCalledWith('/path/to/file.txt', 'content', 'utf8');
    });
  });

  describe('readJson', () => {
    it('reads and parses JSON file', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{"key":"value"}');
      const data = await fsAdapter.readJson<{ key: string }>('/path/to/file.json');
      expect(data).toEqual({ key: 'value' });
      expect(fsp.readFile).toHaveBeenCalledWith('/path/to/file.json', 'utf8');
    });

    it('returns typed data', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{"number":123}');
      const data = await fsAdapter.readJson<{ number: number }>('/path/to/file.json');
      expect(data.number).toBe(123);
    });
  });

  describe('writeJson', () => {
    it('writes value as formatted JSON', async () => {
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await fsAdapter.writeJson('/path/to/file.json', { key: 'value' });
      expect(fsp.writeFile).toHaveBeenCalledWith(
        '/path/to/file.json',
        JSON.stringify({ key: 'value' }, null, 2),
        'utf8'
      );
    });
  });

  describe('exists', () => {
    it('returns true when file exists', async () => {
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      const exists = await fsAdapter.exists('/path/to/file');
      expect(exists).toBe(true);
    });

    it('returns false when file does not exist', async () => {
      vi.mocked(fsp.access).mockRejectedValue(new Error('ENOENT'));
      const exists = await fsAdapter.exists('/path/to/nonexistent');
      expect(exists).toBe(false);
    });
  });

  describe('mkdir', () => {
    it('creates directory without recursive option', async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      await fsAdapter.mkdir('/path/to/dir');
      expect(fsp.mkdir).toHaveBeenCalledWith('/path/to/dir', { recursive: false });
    });

    it('creates directory with recursive option', async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      await fsAdapter.mkdir('/path/to/dir', { recursive: true });
      expect(fsp.mkdir).toHaveBeenCalledWith('/path/to/dir', { recursive: true });
    });

    it('handles undefined recursive option', async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      await fsAdapter.mkdir('/path/to/dir', {});
      expect(fsp.mkdir).toHaveBeenCalledWith('/path/to/dir', { recursive: false });
    });
  });

  describe('readDir', () => {
    it('reads directory entries', async () => {
      vi.mocked(fsp.readdir).mockResolvedValue(['file1.txt', 'file2.txt'] as any);
      const entries = await fsAdapter.readDir('/path/to/dir');
      expect(entries).toEqual(['file1.txt', 'file2.txt']);
      expect(fsp.readdir).toHaveBeenCalledWith('/path/to/dir', { withFileTypes: false });
    });
  });

  describe('remove', () => {
    it('removes file without recursive option', async () => {
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      await fsAdapter.remove('/path/to/file');
      expect(fsp.rm).toHaveBeenCalledWith('/path/to/file', { recursive: false, force: true });
    });

    it('removes directory with recursive option', async () => {
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      await fsAdapter.remove('/path/to/dir', { recursive: true });
      expect(fsp.rm).toHaveBeenCalledWith('/path/to/dir', { recursive: true, force: true });
    });

    it('handles undefined recursive option', async () => {
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
      await fsAdapter.remove('/path/to/file', {});
      expect(fsp.rm).toHaveBeenCalledWith('/path/to/file', { recursive: false, force: true });
    });
  });
});
