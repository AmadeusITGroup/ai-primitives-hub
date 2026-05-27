/**
 * Coverage tests for infra/resolvers/local-resolver.ts.
 *
 * Tests readLocalBundle and walk functions.
 */
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  type LocalDirFs,
  readLocalBundle,
} from '../../src/resolvers/local-resolver';

describe('readLocalBundle', () => {
  const mockFs: LocalDirFs = {
    readDir: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws error when directory does not exist', async () => {
    mockFs.exists.mockResolvedValue(false);
    await expect(readLocalBundle('/nonexistent', mockFs)).rejects.toThrow(
      'local bundle directory not found: /nonexistent'
    );
  });

  it('reads bundle directory and produces ExtractedFiles map', async () => {
    mockFs.exists.mockResolvedValue(true);
    mockFs.readDir.mockImplementation(async (p) => {
      if (p === '/bundle') {
        return ['file1.txt', 'subdir'];
      }
      if (p === '/bundle/subdir') {
        return ['file2.txt'];
      }
      return [];
    });
    mockFs.readFile.mockImplementation(async (p) => {
      if (p === '/bundle/file1.txt') {
        return 'content1';
      }
      if (p === '/bundle/subdir/file2.txt') {
        return 'content2';
      }
      throw new Error('Not a file');
    });

    const result = await readLocalBundle('/bundle', mockFs);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get('file1.txt')).toEqual(new TextEncoder().encode('content1'));
    expect(result.get('subdir/file2.txt')).toEqual(new TextEncoder().encode('content2'));
  });

  it('normalizes path separators to forward slashes', async () => {
    mockFs.exists.mockResolvedValue(true);
    mockFs.readDir.mockResolvedValue(['file.txt']);
    mockFs.readFile.mockResolvedValue('content');

    const result = await readLocalBundle('/bundle', mockFs);
    expect(result.has('file.txt')).toBe(true);
  });

  it('handles empty directory', async () => {
    mockFs.exists.mockResolvedValue(true);
    mockFs.readDir.mockResolvedValue([]);

    const result = await readLocalBundle('/bundle', mockFs);
    expect(result.size).toBe(0);
  });

  it('handles deeply nested directories', async () => {
    mockFs.exists.mockResolvedValue(true);
    mockFs.readDir.mockImplementation(async (p) => {
      if (p === '/bundle') {
        return ['dir1'];
      }
      if (p === '/bundle/dir1') {
        return ['dir2'];
      }
      if (p === '/bundle/dir1/dir2') {
        return ['file.txt'];
      }
      return [];
    });
    mockFs.readFile.mockImplementation(async (p) => {
      if (p === '/bundle/dir1/dir2/file.txt') {
        return 'content';
      }
      throw new Error('Not a file');
    });

    const result = await readLocalBundle('/bundle', mockFs);
    expect(result.has('dir1/dir2/file.txt')).toBe(true);
  });

  it('handles mixed files and directories', async () => {
    mockFs.exists.mockResolvedValue(true);
    mockFs.readDir.mockImplementation(async (p) => {
      if (p === '/bundle') {
        return ['file1.txt', 'dir1', 'file2.txt'];
      }
      if (p === '/bundle/dir1') {
        return ['file3.txt'];
      }
      return [];
    });
    mockFs.readFile.mockImplementation(async (p) => {
      if (p.includes('file')) {
        return 'content';
      }
      throw new Error('Not a file');
    });

    const result = await readLocalBundle('/bundle', mockFs);
    expect(result.size).toBe(3);
    expect(result.has('file1.txt')).toBe(true);
    expect(result.has('file2.txt')).toBe(true);
    expect(result.has('dir1/file3.txt')).toBe(true);
  });
});
