/**
 * Atomic text writes through the `RecordFs` port (BR4.1, NFR7.1).
 *
 * The text goes to a temp file created exclusively beside the target, which
 * is then renamed over it, so a reader sees the old file or the new one and
 * never a partial write. The record files and `info/exclude` are both written
 * this way.
 * @module records/atomic-write
 */
import {
  randomBytes,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  RecordFs,
} from '@ai-primitives-hub/core';

/**
 * Replace `target` with `text` atomically. The temp file is removed when the
 * write or the rename fails.
 * @param fs - Filesystem port.
 * @param target - File to replace or create; its folder must exist.
 * @param text - New contents, UTF-8.
 * @throws The filesystem error from the write or the rename; `target` is unchanged.
 */
export const writeFileAtomically = async (fs: RecordFs, target: string, text: string): Promise<void> => {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temp, text);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
};
