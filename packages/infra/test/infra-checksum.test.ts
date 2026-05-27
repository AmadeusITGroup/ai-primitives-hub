/**
 * Coverage tests for infra/checksum.ts.
 *
 * Tests checksumFile and checksumFiles functions.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  checksumFile,
  checksumFiles,
} from '../src/checksum';

describe('checksumFile', () => {
  it('computes SHA-256 hash for string content', () => {
    const hash = checksumFile('hello world');
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('computes SHA-256 hash for Uint8Array content', () => {
    const bytes = new Uint8Array([104, 101, 108, 108, 111]); // 'hello'
    const hash = checksumFile(bytes);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('produces 64-character hex string', () => {
    const hash = checksumFile('test');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces consistent hash for same input', () => {
    const hash1 = checksumFile('consistent input');
    const hash2 = checksumFile('consistent input');
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different input', () => {
    const hash1 = checksumFile('input one');
    const hash2 = checksumFile('input two');
    expect(hash1).not.toBe(hash2);
  });

  it('handles empty string', () => {
    const hash = checksumFile('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('handles empty Uint8Array', () => {
    const hash = checksumFile(new Uint8Array([]));
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('checksumFiles', () => {
  it('computes checksums for all files in Map', () => {
    const files = new Map([
      ['file1.txt', 'content1'],
      ['file2.txt', 'content2']
    ]);
    const checksums = checksumFiles(files);
    expect(checksums).toEqual({
      'file1.txt': checksumFile('content1'),
      'file2.txt': checksumFile('content2')
    });
  });

  it('computes checksums for all files in Record', () => {
    const files = {
      'file1.txt': 'content1',
      'file2.txt': 'content2'
    };
    const checksums = checksumFiles(files);
    expect(checksums).toEqual({
      'file1.txt': checksumFile('content1'),
      'file2.txt': checksumFile('content2')
    });
  });

  it('skips deployment-manifest.yml by default', () => {
    const files = new Map([
      ['deployment-manifest.yml', 'manifest content'],
      ['file.txt', 'content']
    ]);
    const checksums = checksumFiles(files);
    expect(checksums).not.toHaveProperty('deployment-manifest.yml');
    expect(checksums).toHaveProperty('file.txt');
  });

  it('skips custom skip paths', () => {
    const files = new Map([
      ['skip-me.txt', 'content'],
      ['keep-me.txt', 'content']
    ]);
    const checksums = checksumFiles(files, ['skip-me.txt']);
    expect(checksums).not.toHaveProperty('skip-me.txt');
    expect(checksums).toHaveProperty('keep-me.txt');
  });

  it('handles empty Map', () => {
    const checksums = checksumFiles(new Map());
    expect(checksums).toEqual({});
  });

  it('handles empty Record', () => {
    const checksums = checksumFiles({});
    expect(checksums).toEqual({});
  });

  it('handles Uint8Array content', () => {
    const files = new Map([
      ['file1.txt', new Uint8Array([104, 101, 108, 108, 111])]
    ]);
    const checksums = checksumFiles(files);
    expect(checksums['file1.txt']).toBe(checksumFile(new Uint8Array([104, 101, 108, 108, 111])));
  });

  it('handles mixed string and Uint8Array content', () => {
    const files = new Map([
      ['file1.txt', 'string content'],
      ['file2.txt', new Uint8Array([104, 101, 108, 108, 111])]
    ]);
    const checksums = checksumFiles(files);
    expect(checksums['file1.txt']).toBe(checksumFile('string content'));
    expect(checksums['file2.txt']).toBe(checksumFile(new Uint8Array([104, 101, 108, 108, 111])));
  });
});
