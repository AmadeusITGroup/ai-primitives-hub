/**
 * Atomic text writes through the `RecordFs` port: temp file beside the target, then rename.
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
 * Replace `target` with `text` atomically; on failure `target` is unchanged.
 * @param fs - Filesystem port.
 * @param target - File to replace; its folder must exist.
 * @param text - New contents.
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
