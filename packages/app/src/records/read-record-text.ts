/**
 * The capped, strict-UTF-8 read every install record reader runs before
 * parsing (security layer 1: NFR1.1, NFR4.21): at most 10 MB + 1 byte is
 * read, a larger file is refused, and the bytes must decode as UTF-8. The
 * record store and record migration (the old 2.0.0 lockfiles) both use it.
 * @module records/read-record-text
 */
import {
  RECORD_MAX_BYTES,
  recordError,
  type RecordFs,
} from '@ai-primitives-hub/core';

/**
 * Read a record file as text.
 * @param fs - Filesystem port.
 * @param readPath - Absolute path to read (a record symlink's resolved target, for the store).
 * @param file - File to name in errors.
 * @param hint - Hint of the "larger than 10 MB" error; the `RECORD.MALFORMED` default without it.
 * @returns The decoded text.
 * @throws {RegistryError} `RECORD.MALFORMED` naming `file` when the file cannot
 * be read, is larger than 10 MB or is not valid UTF-8.
 */
export const readRecordText = async (fs: RecordFs, readPath: string, file: string, hint?: string): Promise<string> => {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readCapped(readPath, RECORD_MAX_BYTES + 1);
  } catch (error) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'the file could not be read', cause: error });
  }
  if (bytes.byteLength > RECORD_MAX_BYTES) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'record larger than 10 MB', hint });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw recordError('RECORD.MALFORMED', { file, detail: 'not valid UTF-8', cause: error });
  }
};
