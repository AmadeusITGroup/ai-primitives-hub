/**
 * Tests for domain/install/integrity.ts — binary-safe content helpers
 * and post-write verification (issue #357).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  bytesEqual,
  decodeUtf8Strict,
  FileIntegrityError,
  verifyWrittenBytes,
} from '../../../src/domain/install/integrity';

/** Bytes that are NOT valid UTF-8 (zip local-header magic + 0xFF paddings). */
const BINARY_BYTES = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFE, 0x00, 0x9D, 0xC7]);

describe('decodeUtf8Strict', () => {
  it('decodes valid UTF-8 text', () => {
    const bytes = new TextEncoder().encode('# Héllo — prompt');
    expect(decodeUtf8Strict(bytes)).toBe('# Héllo — prompt');
  });

  it('returns null for binary (invalid UTF-8) content', () => {
    expect(decodeUtf8Strict(BINARY_BYTES)).toBeNull();
  });
});

describe('bytesEqual', () => {
  it('returns true for identical byte sequences', () => {
    expect(bytesEqual(BINARY_BYTES, Uint8Array.from(BINARY_BYTES))).toBe(true);
  });

  it('returns false for different lengths or contents', () => {
    expect(bytesEqual(BINARY_BYTES, BINARY_BYTES.slice(0, 4))).toBe(false);
    const flipped = Uint8Array.from(BINARY_BYTES);
    flipped[0] = 0x00;
    expect(bytesEqual(BINARY_BYTES, flipped)).toBe(false);
  });
});

describe('verifyWrittenBytes', () => {
  const fsWith = (bytes: Uint8Array | null): { readFileBytes(p: string): Promise<Uint8Array> } => ({
    readFileBytes: (p: string): Promise<Uint8Array> =>
      bytes === null ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(bytes)
  });

  it('resolves when the on-disk bytes match the intended bytes', async () => {
    await expect(verifyWrittenBytes(fsWith(BINARY_BYTES), '/t/a.pptx', BINARY_BYTES))
      .resolves.toBeUndefined();
  });

  it('throws FileIntegrityError with the path when bytes differ', async () => {
    const corrupted = Uint8Array.from(BINARY_BYTES);
    corrupted[4] = 0xEF;
    await expect(verifyWrittenBytes(fsWith(corrupted), '/t/a.pptx', BINARY_BYTES))
      .rejects.toThrow(FileIntegrityError);
    await expect(verifyWrittenBytes(fsWith(corrupted), '/t/a.pptx', BINARY_BYTES))
      .rejects.toThrow('/t/a.pptx');
  });

  it('throws FileIntegrityError when the file cannot be read back', async () => {
    await expect(verifyWrittenBytes(fsWith(null), '/t/missing.bin', BINARY_BYTES))
      .rejects.toThrow(FileIntegrityError);
  });
});
