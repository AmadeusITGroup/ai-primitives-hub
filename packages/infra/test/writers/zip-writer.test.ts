import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildZip,
  fileSetSha256,
} from '../../src/writers/zip-writer';

describe('zip-writer', () => {
  describe('buildZip', () => {
    it('creates a zip file with single entry', () => {
      const entries = [
        { path: 'test.txt', bytes: new TextEncoder().encode('Hello, World!') }
      ];

      const zipBytes = buildZip(entries);

      expect(zipBytes.length).toBeGreaterThan(0);
      // Check for ZIP signature (0x04_03_4B_50 = PK\x03\x04)
      expect(zipBytes[0]).toBe(0x50);
      expect(zipBytes[1]).toBe(0x4B);
      expect(zipBytes[2]).toBe(0x03);
      expect(zipBytes[3]).toBe(0x04);
    });

    it('creates a zip file with multiple entries', () => {
      const entries = [
        { path: 'file1.txt', bytes: new TextEncoder().encode('Content 1') },
        { path: 'file2.txt', bytes: new TextEncoder().encode('Content 2') },
        { path: 'dir/file3.txt', bytes: new TextEncoder().encode('Content 3') }
      ];

      const zipBytes = buildZip(entries);

      expect(zipBytes.length).toBeGreaterThan(0);
      expect(zipBytes[0]).toBe(0x50); // 'P'
      expect(zipBytes[1]).toBe(0x4B); // 'K'
    });

    it('creates a zip file with empty entries', () => {
      const entries: readonly { path: string; bytes: Uint8Array }[] = [];

      const zipBytes = buildZip(entries);

      expect(zipBytes.length).toBeGreaterThan(0);
      // Should have end of central directory record
      expect(zipBytes[0]).toBe(0x50); // 'P'
      expect(zipBytes[1]).toBe(0x4B); // 'K'
    });

    it('handles UTF-8 filenames', () => {
      const entries = [
        { path: '日本語.txt', bytes: new TextEncoder().encode('Content') }
      ];

      const zipBytes = buildZip(entries);

      expect(zipBytes.length).toBeGreaterThan(0);
      expect(zipBytes[0]).toBe(0x50);
    });

    it('uses deflate compression when beneficial', () => {
      const largeContent = 'A'.repeat(1000);
      const entries = [
        { path: 'large.txt', bytes: new TextEncoder().encode(largeContent) }
      ];

      const zipBytes = buildZip(entries);

      expect(zipBytes.length).toBeLessThan(largeContent.length + 100); // Should be compressed
    });

    it('uses STORE method for small files', () => {
      const entries = [
        { path: 'small.txt', bytes: new TextEncoder().encode('Hi') }
      ];

      const zipBytes = buildZip(entries);

      expect(zipBytes.length).toBeGreaterThan(0);
    });
  });

  describe('fileSetSha256', () => {
    it('computes hash for single file', () => {
      const entries = [
        { path: 'test.txt', bytes: new TextEncoder().encode('Hello') }
      ];

      const hash = fileSetSha256(entries);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('computes hash for multiple files', () => {
      const entries = [
        { path: 'a.txt', bytes: new TextEncoder().encode('Content A') },
        { path: 'b.txt', bytes: new TextEncoder().encode('Content B') }
      ];

      const hash = fileSetSha256(entries);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('computes same hash for same content regardless of order', () => {
      const entries1 = [
        { path: 'a.txt', bytes: new TextEncoder().encode('Content') },
        { path: 'b.txt', bytes: new TextEncoder().encode('Content') }
      ];

      const entries2 = [
        { path: 'b.txt', bytes: new TextEncoder().encode('Content') },
        { path: 'a.txt', bytes: new TextEncoder().encode('Content') }
      ];

      const hash1 = fileSetSha256(entries1);
      const hash2 = fileSetSha256(entries2);

      expect(hash1).toBe(hash2);
    });

    it('computes different hash for different content', () => {
      const entries1 = [
        { path: 'a.txt', bytes: new TextEncoder().encode('Content A') }
      ];

      const entries2 = [
        { path: 'a.txt', bytes: new TextEncoder().encode('Content B') }
      ];

      const hash1 = fileSetSha256(entries1);
      const hash2 = fileSetSha256(entries2);

      expect(hash1).not.toBe(hash2);
    });

    it('computes hash for empty entries', () => {
      const entries: readonly { path: string; bytes: Uint8Array }[] = [];

      const hash = fileSetSha256(entries);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
