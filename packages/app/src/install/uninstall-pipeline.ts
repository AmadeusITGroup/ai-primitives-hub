/**
 * Uninstall Pipeline.
 *
 * Mirrors the install pipeline but for removal operations:
 * - Resolve installed bundle from the lockfile
 * - Plan file removals
 * - Execute removals via target writer
 * - Update the lockfile
 *
 * Repository scope only — see `stores/json-lockfile-store.ts`'s module
 * doc for why. Since the lockfile is split across two physical files
 * (`prompt-registry.lock.json` for `commit` mode,
 * `prompt-registry.local.lock.json` for `local-only`) with no
 * per-entry `target` field, a bundle id is looked up in both files
 * (mirroring the extension's own `LockfileManager.remove()`), and
 * whichever file it's found in is the one updated.
 * @module install/uninstall-pipeline
 */

import {
  createHash,
} from 'node:crypto';
import * as path from 'node:path';
import type {
  FileSystem,
  InstalledFileRecord,
  Target,
} from '@ai-primitives-hub/core';
import type {
  LockfileBundleEntry,
  RepositoryCommitMode,
} from '../stores/json-lockfile-store';
import {
  cleanupOrphanedSource,
  deleteLockfile,
  getLockfilePathForMode,
  lockfileFilesFromInstalledRecords,
  readLockfile,
  removeBundleEntry,
  resolveInstalledFilesForLockfileEntry,
  upsertBundleEntry,
  writeLockfile,
} from '../stores/json-lockfile-store';
import type {
  TargetWriter,
} from '../writers/file-tree-writer';

/**
 * Options for uninstall pipeline.
 */
export interface UninstallPipelineOptions {
  /** Filesystem abstraction. */
  fs: FileSystem;
  /** Target to uninstall from (must be repository scope). */
  target: Target;
  /** Repository root — both lockfile variants are read from here. */
  repositoryPath: string;
  /** Writer factory for scope-aware routing. */
  writerFactory: (target: Target) => TargetWriter;
  /** Optional warning sink for compatibility and preservation diagnostics. */
  onWarning?: (warning: string) => void;
}

/**
 * Uninstall plan result.
 */
export interface UninstallPlan {
  /** Bundle ID to uninstall. */
  bundleId: string;
  /** Files to remove (resolved destination-relative paths). */
  filesToRemove: string[];
  /** Exact installed records resolved from the lockfile entry. */
  installedFiles: InstalledFileRecord[];
  /** Lockfile entry to remove (if found). */
  lockfileEntry: LockfileBundleEntry | null;
  /** Which physical lockfile the entry was found in. */
  commitMode?: RepositoryCommitMode;
  /** Warnings surfaced while interpreting the lockfile entry. */
  warnings: string[];
}

/**
 * Uninstall result.
 */
export interface UninstallResult {
  /** Bundle ID that was uninstalled. */
  bundleId: string;
  /** Files removed. */
  removed: string[];
  /** Files not found (skipped). */
  skipped: string[];
  /** Compatibility or preservation diagnostics produced during uninstall. */
  warnings: string[];
}

const COMMIT_MODES: readonly RepositoryCommitMode[] = ['commit', 'local-only'];
const GIT_EXCLUDE_SECTION_HEADER = '# Prompt Registry (local)';

export interface RemoveInstalledFilesOptions {
  fs: FileSystem;
  writer: TargetWriter;
  files: readonly InstalledFileRecord[];
  repositoryPath?: string;
  commitMode?: RepositoryCommitMode;
}

export const removeInstalledFiles = async (
  opts: RemoveInstalledFilesOptions
): Promise<{ removed: string[]; skipped: string[]; warnings: string[] }> => {
  const removedRecords: InstalledFileRecord[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  for (const file of opts.files) {
    if (await isModifiedInstalledFile(opts.fs, file)) {
      skipped.push(file.destinationRelativePath);
      warnings.push(
        `Preserved modified file "${file.destinationRelativePath}" during uninstall. Remove it manually if you still want it gone.`
      );
      continue;
    }

    try {
      await opts.writer.remove([file]);
      removedRecords.push(file);
    } catch {
      skipped.push(file.destinationRelativePath);
    }
  }

  await cleanupManagedSkillDirectories(opts.fs, removedRecords.map((file) => file.destinationPath));
  if (opts.repositoryPath !== undefined && opts.commitMode === 'local-only' && removedRecords.length > 0) {
    await removeFromGitExclude(opts.fs, opts.repositoryPath, removedRecords.map((file) => file.destinationRelativePath));
  }

  return {
    removed: removedRecords.map((file) => file.destinationRelativePath),
    skipped,
    warnings
  };
};

/**
 * Uninstall pipeline for bundle removal.
 */
export class UninstallPipeline {
  private readonly fs: FileSystem;
  private readonly target: Target;
  private readonly repositoryPath: string;
  private readonly writerFactory: (target: Target) => TargetWriter;
  private readonly onWarning?: (warning: string) => void;

  public constructor(opts: UninstallPipelineOptions) {
    this.fs = opts.fs;
    this.target = opts.target;
    this.repositoryPath = opts.repositoryPath;
    this.writerFactory = opts.writerFactory;
    this.onWarning = opts.onWarning;
  }

  private emitWarnings(warnings: readonly string[]): void {
    if (this.onWarning === undefined) {
      return;
    }
    for (const warning of warnings) {
      this.onWarning(warning);
    }
  }

  private async destinationsOwnedByOtherBundles(bundleId: string): Promise<Set<string>> {
    const destinations = new Set<string>();
    for (const commitMode of COMMIT_MODES) {
      const lock = await readLockfile(getLockfilePathForMode(this.repositoryPath, commitMode), this.fs);
      if (lock === null) {
        continue;
      }
      for (const [otherBundleId, entry] of Object.entries(lock.bundles)) {
        if (otherBundleId === bundleId) {
          continue;
        }
        const resolved = resolveInstalledFilesForLockfileEntry(otherBundleId, entry, {
          repositoryPath: this.repositoryPath
        });
        for (const file of resolved.files) {
          destinations.add(path.resolve(file.destinationPath));
        }
      }
    }
    return destinations;
  }

  /**
   * Remove a bundle entry from its lockfile, cleaning up orphaned
   * sources and deleting the physical file when it becomes empty.
   * @param bundleId - Bundle id to remove.
   * @param entry - The entry being removed (for its sourceId).
   * @param commitMode - Which physical lockfile to update.
   * @param remainingFiles
   */
  private async removeFromLockfile(
    bundleId: string,
    entry: LockfileBundleEntry,
    commitMode: RepositoryCommitMode,
    remainingFiles: readonly InstalledFileRecord[]
  ): Promise<void> {
    const lockPath = getLockfilePathForMode(this.repositoryPath, commitMode);
    const lock = await readLockfile(lockPath, this.fs);
    if (lock === null) {
      return;
    }
    if (remainingFiles.length > 0) {
      await writeLockfile(lockPath, upsertBundleEntry(lock, bundleId, {
        ...entry,
        files: lockfileFilesFromInstalledRecords(remainingFiles)
      }), this.fs);
      return;
    }
    let next = removeBundleEntry(lock, bundleId);
    next = cleanupOrphanedSource(next, entry.sourceId);

    if (Object.keys(next.bundles).length === 0) {
      await deleteLockfile(lockPath, this.fs);
      return;
    }
    await writeLockfile(lockPath, next, this.fs);
  }

  /**
   * Plan uninstall by resolving the bundle in either lockfile.
   * @param id - Bundle ID to uninstall.
   * @returns Uninstall plan.
   */
  public async plan(id: string): Promise<UninstallPlan> {
    for (const commitMode of COMMIT_MODES) {
      const lockPath = getLockfilePathForMode(this.repositoryPath, commitMode);
      const lock = await readLockfile(lockPath, this.fs);
      const entry = lock?.bundles[id];
      if (entry !== undefined) {
        const resolved = resolveInstalledFilesForLockfileEntry(id, entry, { repositoryPath: this.repositoryPath });
        this.emitWarnings(resolved.warnings);
        return {
          bundleId: id,
          filesToRemove: resolved.files.map((file) => file.destinationRelativePath),
          installedFiles: resolved.files,
          lockfileEntry: entry,
          commitMode,
          warnings: resolved.warnings
        };
      }
    }
    return { bundleId: id, filesToRemove: [], installedFiles: [], lockfileEntry: null, warnings: [] };
  }

  /**
   * Execute uninstall by removing files and updating the lockfile.
   * @param id - Bundle ID to uninstall.
   * @returns Uninstall result.
   */
  public async run(id: string): Promise<UninstallResult> {
    const plan = await this.plan(id);

    if (plan.lockfileEntry === null || plan.commitMode === undefined) {
      return { bundleId: id, removed: [], skipped: [], warnings: [] };
    }

    const writer = this.writerFactory(this.target);
    const destinationsOwnedByOthers = await this.destinationsOwnedByOtherBundles(id);
    const removableFiles = plan.installedFiles.filter(
      (file) => !destinationsOwnedByOthers.has(path.resolve(file.destinationPath))
    );
    const result = await removeInstalledFiles({
      fs: this.fs,
      writer,
      files: removableFiles,
      repositoryPath: this.repositoryPath,
      commitMode: plan.commitMode
    });
    this.emitWarnings(result.warnings);

    const skipped = new Set(result.skipped);
    await this.removeFromLockfile(
      id,
      plan.lockfileEntry,
      plan.commitMode,
      plan.installedFiles.filter((file) => skipped.has(file.destinationRelativePath))
    );

    return {
      bundleId: id,
      removed: result.removed,
      skipped: result.skipped,
      warnings: [...plan.warnings, ...result.warnings]
    };
  }

  /**
   * Plan uninstall for every bundle across both lockfiles.
   * @returns Array of uninstall plans.
   */
  public async planAll(): Promise<UninstallPlan[]> {
    const plans: UninstallPlan[] = [];
    for (const commitMode of COMMIT_MODES) {
      const lockPath = getLockfilePathForMode(this.repositoryPath, commitMode);
      const lock = await readLockfile(lockPath, this.fs);
      if (lock === null) {
        continue;
      }
      for (const [bundleId, entry] of Object.entries(lock.bundles)) {
        const resolved = resolveInstalledFilesForLockfileEntry(bundleId, entry, { repositoryPath: this.repositoryPath });
        this.emitWarnings(resolved.warnings);
        plans.push({
          bundleId,
          filesToRemove: resolved.files.map((file) => file.destinationRelativePath),
          installedFiles: resolved.files,
          lockfileEntry: entry,
          commitMode,
          warnings: resolved.warnings
        });
      }
    }
    return plans;
  }

  /**
   * Execute uninstall for every bundle across both lockfiles.
   * @returns Array of uninstall results.
   */
  public async runAll(): Promise<UninstallResult[]> {
    const plans = await this.planAll();
    const results: UninstallResult[] = [];

    for (const plan of plans) {
      if (plan.lockfileEntry === null || plan.commitMode === undefined) {
        continue;
      }

      const writer = this.writerFactory(this.target);
      const result = await removeInstalledFiles({
        fs: this.fs,
        writer,
        files: plan.installedFiles,
        repositoryPath: this.repositoryPath,
        commitMode: plan.commitMode
      });
      this.emitWarnings(result.warnings);
      const skipped = new Set(result.skipped);
      await this.removeFromLockfile(
        plan.bundleId,
        plan.lockfileEntry,
        plan.commitMode,
        plan.installedFiles.filter((file) => skipped.has(file.destinationRelativePath))
      );

      results.push({
        bundleId: plan.bundleId,
        removed: result.removed,
        skipped: result.skipped,
        warnings: [...plan.warnings, ...result.warnings]
      });
    }

    return results;
  }

  /**
   * Execute uninstall for every bundle across both lockfiles,
   * tolerating missing/invalid lockfiles by returning an empty result.
   * @returns Array of uninstall results.
   */
  public async runFromLockfile(): Promise<UninstallResult[]> {
    try {
      return await this.runAll();
    } catch {
      // Lockfile doesn't exist or is invalid
      return [];
    }
  }
}

export const isModifiedInstalledFile = async (fs: FileSystem, file: InstalledFileRecord): Promise<boolean> => {
  try {
    const bytes = await fs.readFileBytes(file.destinationPath);
    return normalizeChecksum(checksum(bytes)) !== normalizeChecksum(file.installedChecksum);
  } catch {
    return false;
  }
};

const normalizeChecksum = (value: string): string => value.startsWith('sha256:') ? value : `sha256:${value}`;

const removeFromGitExclude = async (
  fs: FileSystem,
  repositoryPath: string,
  relativePaths: readonly string[]
): Promise<void> => {
  const excludePath = path.join(repositoryPath, '.git', 'info', 'exclude');
  try {
    const existing = await fs.readFile(excludePath);
    const toRemove = new Set(relativePaths.map((filePath) => filePath.replaceAll('\\', '/')));
    const filtered = existing
      .split('\n')
      .filter((line, index) => index === 0 && line === GIT_EXCLUDE_SECTION_HEADER ? true : !toRemove.has(line.replaceAll('\\', '/')));
    await fs.writeFile(excludePath, filtered.join('\n'));
  } catch {
    // No exclude file to clean.
  }
};

const cleanupManagedSkillDirectories = async (
  fs: FileSystem,
  removedPaths: readonly string[]
): Promise<void> => {
  const visited = new Set<string>();

  for (const removedPath of removedPaths) {
    const skillRoot = findManagedSkillRoot(removedPath);
    if (skillRoot === null) {
      continue;
    }

    let current = path.dirname(removedPath);
    while (isWithinSkillRoot(current, skillRoot)) {
      const normalizedCurrent = current.replaceAll('\\', '/');
      if (visited.has(normalizedCurrent)) {
        if (normalizedCurrent === skillRoot) {
          break;
        }
        current = path.dirname(current);
        continue;
      }
      visited.add(normalizedCurrent);

      try {
        const entries = await fs.readDir(current);
        if (entries.length > 0) {
          break;
        }
        await fs.remove(current);
      } catch {
        break;
      }

      if (normalizedCurrent === skillRoot) {
        break;
      }
      current = path.dirname(current);
    }
  }
};

const findManagedSkillRoot = (filePath: string): string | null => {
  const normalized = filePath.replaceAll('\\', '/');
  const marker = '/skills/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const skillIdStart = markerIndex + marker.length;
  const nextSlash = normalized.indexOf('/', skillIdStart);
  if (nextSlash === -1) {
    return normalized;
  }
  return normalized.slice(0, nextSlash);
};

const isWithinSkillRoot = (candidate: string, skillRoot: string): boolean => {
  const normalizedCandidate = candidate.replaceAll('\\', '/');
  return normalizedCandidate === skillRoot || normalizedCandidate.startsWith(`${skillRoot}/`);
};

const checksum = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
