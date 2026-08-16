/**
 * Domain layer — install-time file integrity helpers (issue #357).
 *
 * The bundle pipeline already verifies checksums up to the in-memory
 * `ExtractedFiles` map (zip CRC-32 during extraction; per-file SHA-256
 * in governed deployment manifests). These helpers extend the guarantee
 * across the last hop — writing to the install target:
 *
 *   - `decodeUtf8Strict` lets writers distinguish text payloads (safe
 *     to transform and write as strings) from binary payloads (which
 *     must be written byte-for-byte; lossy UTF-8 round-trips are what
 *     corrupted binary assets such as PPTX files in the first place).
 *   - `verifyWrittenBytes` re-reads an installed file and compares it
 *     against the bytes the writer intended to write, failing loudly
 *     instead of leaving silent corruption on disk.
 *
 * Pure domain logic over injected port subsets: no `node:fs`, no IO of
 * its own.
 * @module domain/install/integrity
 */

/**
 * Narrow port subset needed to verify a written file. Satisfied by the
 * full `FileSystem` port.
 */
export interface ByteReader {
  readFileBytes(path: string): Promise<Uint8Array>;
}

/**
 * Thrown when an installed file's bytes do not match what the writer
 * intended to write (or the file cannot be read back at all).
 */
export class FileIntegrityError extends Error {
  /** Stable error code for programmatic handling. */
  public readonly code = 'BUNDLE.INTEGRITY_MISMATCH';

  public constructor(
    /** Absolute path of the file that failed verification. */
    public readonly filePath: string,
    detail: string
  ) {
    super(`integrity verification failed for "${filePath}": ${detail}`);
    this.name = 'FileIntegrityError';
  }
}

/**
 * Strictly decode UTF-8 bytes.
 *
 * Unlike the default `TextDecoder`, which silently substitutes U+FFFD
 * for invalid sequences (lossy — the root cause of binary asset
 * corruption on install), this returns `null` when the bytes are not
 * valid UTF-8 so callers can fall back to byte-for-byte handling.
 * @param bytes - Raw content bytes.
 * @returns The decoded string, or `null` when not valid UTF-8.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Constant-shape byte comparison.
 * @param a - First byte sequence.
 * @param b - Second byte sequence.
 * @returns `true` iff both sequences have identical length and content.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Re-read an installed file and verify it matches the intended bytes.
 * @param fs - Byte-level reader (satisfied by the `FileSystem` port).
 * @param filePath - Absolute path of the file that was written.
 * @param expected - The exact bytes the writer intended to write.
 * @throws {FileIntegrityError} When the file is unreadable or differs.
 */
export async function verifyWrittenBytes(
  fs: ByteReader,
  filePath: string,
  expected: Uint8Array
): Promise<void> {
  let actual: Uint8Array;
  try {
    actual = await fs.readFileBytes(filePath);
  } catch (cause) {
    throw new FileIntegrityError(filePath, `unreadable after write (${(cause as Error).message})`);
  }
  if (!bytesEqual(actual, expected)) {
    throw new FileIntegrityError(
      filePath,
      `wrote ${expected.byteLength} bytes but read back ${actual.byteLength} bytes with differing content`
    );
  }
}
