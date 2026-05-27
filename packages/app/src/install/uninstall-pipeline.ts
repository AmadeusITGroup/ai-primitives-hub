/**
 * Uninstall Pipeline.
 *
 * Mirrors the install pipeline but for removal operations:
 * - Resolve installed bundle from lockfile/state
 * - Plan file removals based on target scope
 * - Execute removals via target writer
 * - Update lockfile and state
 *
 * Supports both user and repository scopes with appropriate
 * cleanup (e.g., git exclude removal for repository scope).
 */

import type {
  Target,
} from '../../domain/install';
import type {
  LockfileEntry,
} from '../../infra/stores/json-lockfile-store';
import {
  readLockfile,
  removeEntry,
  writeLockfile,
} from '../../infra/stores/json-lockfile-store';
import type {
  TargetWriter,
} from '../../infra/writers/file-tree-writer';
import type {
  FileSystem,
} from '../../ports/filesystem';

/**
 * Options for uninstall pipeline.
 */
export interface UninstallPipelineOptions {
  /** Filesystem abstraction. */
  fs: FileSystem;
  /** Target to uninstall from. */
  target: Target;
  /** Lockfile path. */
  lockfile: string;
  /** Writer factory for scope-aware routing. */
  writerFactory: (target: Target) => TargetWriter;
}

/**
 * Uninstall plan result.
 */
export interface UninstallPlan {
  /** Bundle ID to uninstall. */
  bundleId: string;
  /** Files to remove. */
  filesToRemove: string[];
  /** Lockfile entry to remove (if found). */
  lockfileEntry: LockfileEntry | null;
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

/**
 * Uninstall pipeline for bundle removal.
 */
export class UninstallPipeline {
  private readonly fs: FileSystem;
  private readonly target: Target;
  private readonly lockfile: string;
  private readonly writerFactory: (target: Target) => TargetWriter;

  public constructor(opts: UninstallPipelineOptions) {
    this.fs = opts.fs;
    this.target = opts.target;
    this.lockfile = opts.lockfile;
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
   * Plan uninstall by resolving lockfile entry.
   * @param id - Bundle ID to uninstall.
   * @returns Uninstall plan.
   */
  public async plan(id: string): Promise<UninstallPlan> {
    const lock = await readLockfile(this.lockfile, this.fs);
    const entry = lock.entries.find((e) => e.bundleId === id && e.target === this.target.name);

    return {
      bundleId: id,
      filesToRemove: entry?.files ?? [],
      lockfileEntry: entry ?? null
    };
  }

  /**
   * Execute uninstall by removing files and updating lockfile.
   * @param id - Bundle ID to uninstall.
   * @returns Uninstall result.
   */
  public async run(id: string): Promise<UninstallResult> {
    const plan = await this.plan(id);

    if (plan.lockfileEntry === null) {
      return {
        bundleId: id,
        removed: [],
        skipped: []
      };
    }

    const writer = this.writerFactory(this.target);
    const result = await this.removeFiles(writer, plan.filesToRemove);

    // Update lockfile
    const lock = await readLockfile(this.lockfile, this.fs);
    const nextLock = removeEntry(lock, plan.lockfileEntry);
    await writeLockfile(this.lockfile, nextLock, this.fs);

    return {
      bundleId: id,
      removed: result.removed,
      skipped: result.skipped
    };
  }

  /**
   * Plan uninstall for all bundles for the target.
   * @returns Array of uninstall plans.
   */
  public async planAll(): Promise<UninstallPlan[]> {
    const lock = await readLockfile(this.lockfile, this.fs);
    const matching = lock.entries.filter((e) => e.target === this.target.name);

    return matching.map((entry) => ({
      bundleId: entry.bundleId,
      filesToRemove: entry.files,
      lockfileEntry: entry
    }));
  }

  /**
   * Execute uninstall for all bundles for the target.
   * @returns Array of uninstall results.
   */
  public async runAll(): Promise<UninstallResult[]> {
    const plans = await this.planAll();
    const results: UninstallResult[] = [];

    for (const plan of plans) {
      if (plan.lockfileEntry === null) {
        continue;
      }

      const writer = this.writerFactory(this.target);
      const result = await this.removeFiles(writer, plan.filesToRemove);

      results.push({
        bundleId: plan.bundleId,
        removed: result.removed,
        skipped: result.skipped
      });
    }

    // Update lockfile by removing all matching entries
    const lock = await readLockfile(this.lockfile, this.fs);
    let nextLock = lock;
    for (const plan of plans) {
      if (plan.lockfileEntry) {
        nextLock = removeEntry(nextLock, plan.lockfileEntry);
      }
    }
    await writeLockfile(this.lockfile, nextLock, this.fs);

    return results;
  }

  /**
   * Execute uninstall from lockfile for the target.
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
