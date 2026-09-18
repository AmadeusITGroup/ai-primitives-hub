/**
 * Safe target-write orchestration.
 *
 * A writer may know that a target cannot accept part of a bundle. Keep that
 * decision before the first filesystem mutation whenever the writer exposes
 * `preflight`; retain the result check as a compatibility guard for older or
 * external writers that only implement `write`.
 * @module install/target-write
 */
import * as path from 'node:path';
import type {
  FileSystem,
  InstalledFileRecord,
  TargetWritePlan,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import type {
  RepositoryCommitMode,
} from '../stores/json-lockfile-store';
import {
  isModifiedInstalledFile,
  removeInstalledFiles,
} from './uninstall-pipeline';

const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

/**
 * Raised when a target cannot install every routed bundle file.
 */
export class TargetWriteRejectedError extends Error {
  public readonly code = 'BUNDLE.UNSUPPORTED_CONTENT';

  public constructor(message: string) {
    super(message);
    this.name = 'TargetWriteRejectedError';
  }
}

/**
 * Preflight and execute a target write without accepting partial content.
 * @param writer Target writer.
 * @param plan Exact target write plan.
 * @returns The successful writer result.
 * @throws {TargetWriteRejectedError} When content is skipped.
 */
export async function writeTargetSafely(
  writer: TargetWriter,
  plan: TargetWritePlan
): Promise<TargetWriteResult> {
  if (writer.preflight !== undefined) {
    await writer.preflight(plan);
  }

  return await writer.write(plan);
}

interface FileSnapshot {
  path: string;
  bytes?: Uint8Array;
}

/**
 * Run a filesystem mutation and restore every declared file if it fails.
 * @param fs Filesystem containing the transaction files.
 * @param filePaths Exact files that the mutation may create, replace, or remove.
 * @param mutation Mutation to execute after snapshots are captured.
 */
export async function runFileTransaction<T>(
  fs: FileSystem,
  filePaths: readonly string[],
  mutation: () => Promise<T>
): Promise<T> {
  const snapshots: FileSnapshot[] = [];
  for (const filePath of new Set(filePaths)) {
    snapshots.push(await fs.exists(filePath)
      ? { path: filePath, bytes: await fs.readFileBytes(filePath) }
      : { path: filePath });
  }

  try {
    return await mutation();
  } catch (error) {
    for (const snapshot of snapshots.toReversed()) {
      try {
        if (snapshot.bytes === undefined) {
          if (await fs.exists(snapshot.path)) {
            await fs.remove(snapshot.path);
          }
        } else {
          await fs.mkdir(path.dirname(snapshot.path), { recursive: true });
          await fs.writeFileBytes(snapshot.path, snapshot.bytes);
        }
      } catch {
        // Preserve the mutation error when rollback is best effort.
      }
    }
    throw error;
  }
}

export interface UpdateTargetOptions {
  fs: FileSystem;
  writer: TargetWriter;
  plan: TargetWritePlan;
  installed: readonly InstalledFileRecord[];
  repositoryPath?: string;
  commitMode?: RepositoryCommitMode;
}

export interface UpdateTargetResult extends TargetWriteResult {
  removed: string[];
  retained: string[];
  warnings: string[];
}

/**
 * Updates a target while preserving modified and unsuccessfully removed files.
 * @param opts
 */
export async function updateTargetSafely(opts: UpdateTargetOptions): Promise<UpdateTargetResult> {
  const modifiedDestinations = new Set<string>();
  for (const file of opts.installed) {
    if (await isModifiedInstalledFile(opts.fs, file)) {
      modifiedDestinations.add(file.destinationPath);
    }
  }

  const plannedDestinations = new Set(opts.plan.operations.map((operation) => operation.destinationPath));
  const write = await writeTargetSafely(opts.writer, {
    ...opts.plan,
    operations: opts.plan.operations.filter((operation) => !modifiedDestinations.has(operation.destinationPath))
  });
  const obsolete = opts.installed.filter((file) =>
    !plannedDestinations.has(file.destinationPath) && !modifiedDestinations.has(file.destinationPath));
  const removal = await removeInstalledFiles({
    fs: opts.fs,
    writer: opts.writer,
    files: obsolete,
    repositoryPath: opts.repositoryPath,
    commitMode: opts.commitMode
  });
  const skipped = new Set(removal.skipped);
  const retainedRecords = opts.installed.filter((file) =>
    modifiedDestinations.has(file.destinationPath) || skipped.has(file.destinationRelativePath));
  const modified = opts.installed
    .filter((file) => modifiedDestinations.has(file.destinationPath))
    .map((file) => file.destinationRelativePath);

  return {
    installed: [...write.installed, ...retainedRecords],
    removed: removal.removed,
    retained: retainedRecords.map((file) => file.destinationRelativePath),
    warnings: [
      ...modified.map((filePath) => `Preserved modified file "${filePath}" during update.`),
      ...removal.warnings
    ]
  };
}

/**
 * Adds exact installed repository paths to the managed Git exclude section.
 * @param fs Filesystem used to persist the exclude file.
 * @param repositoryPath Repository root containing `.git/info/exclude`.
 * @param files Installed file records to exclude.
 */
export async function addInstalledFilesToGitExclude(
  fs: FileSystem,
  repositoryPath: string,
  files: readonly InstalledFileRecord[]
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const excludePath = path.join(repositoryPath, '.git', 'info', 'exclude');
  const existing = await fs.exists(excludePath) ? await fs.readFile(excludePath) : '';
  const lines = existing.split('\n');
  const entries = new Set(lines.map((line) => line.replaceAll('\\', '/')));
  const additions = files
    .map((file) => file.destinationRelativePath.replaceAll('\\', '/'))
    .filter((filePath) => !entries.has(filePath));
  if (additions.length === 0) {
    return;
  }

  let prefix = `${GIT_EXCLUDE_SECTION_HEADER}\n`;
  if (existing.length > 0) {
    prefix = entries.has(GIT_EXCLUDE_SECTION_HEADER)
      ? `${existing.trimEnd()}\n`
      : `${existing.trimEnd()}\n\n${GIT_EXCLUDE_SECTION_HEADER}\n`;
  }
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, `${prefix}${additions.join('\n')}\n`);
}
