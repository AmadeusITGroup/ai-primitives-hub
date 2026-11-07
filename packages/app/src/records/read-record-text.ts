/**
 * The capped, strict-UTF-8 read shared by the record store and migration.
 * @module records/read-record-text
 */
import {
  RECORD_MAX_BYTES,
  recordError,
  type RecordFs,
} from '@ai-primitives-hub/core';

/**
 * Read a record file of at most 10 MB as UTF-8 text.
 * @param fs - Filesystem port.
 * @param readPath - Absolute path to read.
 * @param file - File to name in errors.
 * @param hint - Hint for the size error.
 * @throws {RegistryError} `RECORD.MALFORMED` naming `file`.
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
