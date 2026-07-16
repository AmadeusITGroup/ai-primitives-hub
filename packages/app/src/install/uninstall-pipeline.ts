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
 *
 * Known gap (matches the reference branch's own pipeline, not a
 * regression introduced here): per-file removal goes through the
 * generic `TargetWriter.remove()` method, which does not perform the
 * git-exclude cleanup that `RepositoryScopeWriter`'s own richer
 * `.remove(bundleId, manifest)` method does. Wiring that through the
 * `TargetWriter` interface is deferred.
 * @module install/uninstall-pipeline
 */

import type {
  FileSystem,
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
  readLockfile,
  removeBundleEntry,
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
}

/**
 * Uninstall plan result.
 */
export interface UninstallPlan {
  /** Bundle ID to uninstall. */
  bundleId: string;
  /** Files to remove (bundle-relative paths from the lockfile entry). */
  filesToRemove: string[];
  /** Lockfile entry to remove (if found). */
  lockfileEntry: LockfileBundleEntry | null;
  /** Which physical lockfile the entry was found in. */
  commitMode?: RepositoryCommitMode;
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
}

const COMMIT_MODES: readonly RepositoryCommitMode[] = ['commit', 'local-only'];

/**
 * Uninstall pipeline for bundle removal.
 */
export class UninstallPipeline {
  private readonly fs: FileSystem;
  private readonly target: Target;
  private readonly repositoryPath: string;
  private readonly writerFactory: (target: Target) => TargetWriter;

  public constructor(opts: UninstallPipelineOptions) {
    this.fs = opts.fs;
    this.target = opts.target;
    this.repositoryPath = opts.repositoryPath;
    this.writerFactory = opts.writerFactory;
  }

  /**
   * Remove files via writer.
   * @param writer - Target writer.
   * @param files - Files to remove.
   * @returns Removal result.
   */
  private async removeFiles(writer: TargetWriter, files: string[]): Promise<{ removed: string[]; skipped: string[] }> {
    const removed: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      try {
        await writer.remove(this.target, file);
        removed.push(file);
      } catch {
        skipped.push(file);
      }
    }

    return { removed, skipped };
  }

  /**
   * Remove a bundle entry from its lockfile, cleaning up orphaned
   * sources and deleting the physical file when it becomes empty.
   * @param bundleId - Bundle id to remove.
   * @param entry - The entry being removed (for its sourceId).
   * @param commitMode - Which physical lockfile to update.
   */
  private async removeFromLockfile(
    bundleId: string,
    entry: LockfileBundleEntry,
    commitMode: RepositoryCommitMode
  ): Promise<void> {
    const lockPath = getLockfilePathForMode(this.repositoryPath, commitMode);
    const lock = await readLockfile(lockPath, this.fs);
    if (lock === null) {
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
        return {
          bundleId: id,
          filesToRemove: entry.files.map((f) => f.path),
          lockfileEntry: entry,
          commitMode
        };
      }
    }
    return { bundleId: id, filesToRemove: [], lockfileEntry: null };
  }

  /**
   * Execute uninstall by removing files and updating the lockfile.
   * @param id - Bundle ID to uninstall.
   * @returns Uninstall result.
   */
  public async run(id: string): Promise<UninstallResult> {
    const plan = await this.plan(id);

    if (plan.lockfileEntry === null || plan.commitMode === undefined) {
      return { bundleId: id, removed: [], skipped: [] };
    }

    const writer = this.writerFactory(this.target);
    const result = await this.removeFiles(writer, plan.filesToRemove);

    await this.removeFromLockfile(id, plan.lockfileEntry, plan.commitMode);

    return {
      bundleId: id,
      removed: result.removed,
      skipped: result.skipped
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
        plans.push({
          bundleId,
          filesToRemove: entry.files.map((f) => f.path),
          lockfileEntry: entry,
          commitMode
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
      const result = await this.removeFiles(writer, plan.filesToRemove);
      await this.removeFromLockfile(plan.bundleId, plan.lockfileEntry, plan.commitMode);

      results.push({
        bundleId: plan.bundleId,
        removed: result.removed,
        skipped: result.skipped
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
