/**
 * Lockfile entry for an install.
 *
 * Every write site builds its lockfile entry here, so entries have one
 * shape whichever command or client wrote them: the written files with
 * their archive checksums and `installedPath`, the target type that
 * placed them, and `installedChecksum` where the bytes on disk differ from
 * the archive. New entries never record `commitMode`.
 * @module install/lockfile-entry
 */
import {
  createHash,
} from 'node:crypto';
import type {
  FileSystem,
  Target,
  TargetType,
  TargetWriter,
} from '@ai-primitives-hub/core';
import {
  checksumFiles,
  type LockfileBundleEntry,
  type LockfileFileEntry,
} from '../stores/json-lockfile-store';
import type {
  BundleTargetWrite,
} from './target-write';

/**
 * Files of a lockfile entry for a write, before `installedChecksum`.
 * @param write The successful write.
 * @returns One entry per written bundle path (manifest excluded).
 */
const writtenFiles = (write: BundleTargetWrite): LockfileFileEntry[] => checksumFiles(
  write.installableFiles,
  write.result.writtenBundlePaths ?? write.installableFiles.keys(),
  write.result.installedPaths
);

/**
 * Build the lockfile entry of an install.
 * @param input Entry inputs.
 * @param input.version Installed bundle version.
 * @param input.sourceId Id of the source the bundle came from.
 * @param input.sourceType Type of that source.
 * @param input.checksum Optional checksum of the bundle archive.
 * @param input.targetType Target type that placed the files.
 * @param input.write The successful write.
 * @param input.installedChecksums SHA256 of each written file on disk, by
 *   bundle path (see {@link computeInstalledChecksums}).
 * @param input.now Install time.
 * @returns The entry; a file records `installedChecksum` only when its
 *   on-disk checksum differs from the archive checksum.
 */
export function buildLockfileBundleEntry(input: {
  version: string;
  sourceId: string;
  sourceType: string;
  checksum?: string;
  targetType: TargetType;
  write: BundleTargetWrite;
  installedChecksums: ReadonlyMap<string, string>;
  now: Date;
}): LockfileBundleEntry {
  const files = writtenFiles(input.write).map((file) => {
    const installedChecksum = input.installedChecksums.get(file.path);
    return installedChecksum === undefined || installedChecksum === file.checksum
      ? file
      : { ...file, installedChecksum };
  });
  return {
    version: input.version,
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    ...(input.checksum === undefined ? {} : { checksum: input.checksum }),
    installedAt: input.now.toISOString(),
    targetType: input.targetType,
    files
  };
}

/**
 * Hash every written file where the writer placed it.
 * @param input Writer, target, write and filesystem.
 * @param input.writer Writer that performed the write.
 * @param input.target Target it wrote to.
 * @param input.write The successful write.
 * @param input.fs Filesystem the bytes are read from.
 * @returns SHA256 of each located file's bytes on disk, by bundle path;
 *   empty when the writer cannot locate files. Read errors reject.
 */
export async function computeInstalledChecksums(input: {
  writer: TargetWriter;
  target: Target;
  write: BundleTargetWrite;
  fs: Pick<FileSystem, 'readFileBytes'>;
}): Promise<Map<string, string>> {
  const checksums = new Map<string, string>();
  if (input.writer.locate === undefined) {
    return checksums;
  }
  const files = writtenFiles(input.write);
  const { paths } = await input.writer.locate(input.target, files);
  for (const [index, file] of files.entries()) {
    const location = paths[index];
    if (location !== null) {
      checksums.set(file.path, createHash('sha256').update(await input.fs.readFileBytes(location)).digest('hex'));
    }
  }
  return checksums;
}
