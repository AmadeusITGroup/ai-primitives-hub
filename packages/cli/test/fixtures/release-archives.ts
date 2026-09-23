import {
  mkdir,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ExtractedFiles,
} from '@ai-primitives-hub/core';

export {
  createGovernedReleaseArchive,
  createLegacyReleaseArchive,
} from '../../../core/test/fixtures/release-archives';

/**
 * Write an extracted archive fixture to a local bundle directory.
 * @param root
 * @param files
 */
export const writeReleaseArchive = async (
  root: string,
  files: ExtractedFiles
): Promise<void> => {
  for (const [filePath, content] of files) {
    const fullPath = path.join(root, filePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
};
