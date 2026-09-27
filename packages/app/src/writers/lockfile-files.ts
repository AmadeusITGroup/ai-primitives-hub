import * as path from 'node:path';
import type {
  ExtractedFiles,
  Target,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  getKnowledgeRelativePath,
} from '@ai-primitives-hub/core';
import type {
  LockfileFileEntry,
} from '../stores/json-lockfile-store';
import {
  checksumFiles,
} from '../stores/json-lockfile-store';

export const checksumWrittenFiles = (
  files: ExtractedFiles,
  result: TargetWriteResult,
  target: Target,
  repositoryRoot: string
): LockfileFileEntry[] => {
  const bundlePaths = result.writtenBundlePaths;
  if (bundlePaths === undefined || bundlePaths.length !== result.written.length) {
    throw new Error('writer result does not align written paths with bundle paths');
  }

  return bundlePaths.map((bundlePath, index) => {
    if (!files.has(bundlePath)) {
      throw new Error(`writer reported an unknown bundle path: ${bundlePath}`);
    }
    const entry = checksumFiles(files, [bundlePath])[0];
    if (entry === undefined) {
      throw new Error(`writer reported a non-installable bundle path: ${bundlePath}`);
    }

    let lockfilePath = bundlePath;
    if (target.scope === 'repository' && bundlePath.startsWith('knowledge/')) {
      const writtenPath = result.written[index];
      if (writtenPath === undefined || !path.isAbsolute(writtenPath)) {
        throw new Error(`writer reported an invalid repository destination for ${bundlePath}`);
      }
      const root = path.resolve(repositoryRoot);
      const destination = path.resolve(writtenPath);
      const relativePath = path.relative(root, destination);
      if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error(`writer destination escapes repository root: ${writtenPath}`);
      }
      lockfilePath = relativePath.replaceAll('\\', '/');
      if (getKnowledgeRelativePath(lockfilePath) === null) {
        throw new Error(`writer reported an invalid repository knowledge destination: ${writtenPath}`);
      }
    }

    return { path: lockfilePath, checksum: entry.checksum };
  });
};
