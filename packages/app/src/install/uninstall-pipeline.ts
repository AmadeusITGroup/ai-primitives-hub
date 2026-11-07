/**
 * Uninstall Pipeline.
 *
 * Repository-scope uninstall over the two physical lockfiles
 * (`prompt-registry.lock.json` for `commit` mode,
 * `prompt-registry.local.lock.json` for `local-only`; see
 * `stores/json-lockfile-store.ts`'s module doc). A bundle id is looked up
 * in both files, commit first (mirroring the extension's own
 * `LockfileManager.remove()`), and whichever file holds it is the one
 * updated.
 *
 * `plan`/`planAll` only read the lockfiles. `run`/`runAll` delegate each
 * bundle to the shared `applyBundleUninstall` over a lockfile record
 * store: files another bundle records are kept, recorded paths with no
 * location inside the target root are refused, empty directories are
 * pruned, and `local-only` files leave the git exclusion list.
 * @module install/uninstall-pipeline
 */

import type {
  FileSystem,
  RepositoryExclusion,
  Target,
} from '@ai-primitives-hub/core';
import {
  GitInfoExclude,
} from '@ai-primitives-hub/infra';
import {
  createLockfileRecordStore,
  type InstallRecordStore,
} from '../stores/install-record-store';
import type {
  LockfileBundleEntry,
  RepositoryCommitMode,
} from '../stores/json-lockfile-store';
import {
  getLockfilePathForMode,
  readLockfile,
} from '../stores/json-lockfile-store';
import type {
  TargetWriter,
} from '../writers/file-tree-writer';
import {
  applyBundleUninstall,
  type ApplyBundleUninstallResult,
} from './apply-bundle-uninstall';

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
  /** `generatedBy` of a lockfile the record store writes (default `ai-primitives-hub-cli`). */
  generatedBy?: string;
  /** Git exclusion list (default: `GitInfoExclude` over `repositoryPath`). */
  exclusion?: RepositoryExclusion;
  /** Keep files whose bytes changed since install (default `false`). */
  preserveModified?: boolean;
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
  /** Files left in place: kept, refused, missing or failed (see `outcome`). */
  skipped: string[];
  /** Full outcome of the shared uninstall, when the bundle was recorded. */
  outcome?: ApplyBundleUninstallResult;
}

/**
 * The {@link UninstallResult} of a shared uninstall outcome.
 * @param bundleId Bundle id.
 * @param outcome Shared uninstall outcome.
 * @returns `removed` as is; `skipped` = kept ∪ refused ∪ missing ∪ errors.
 */
export const uninstallResultOf = (bundleId: string, outcome: ApplyBundleUninstallResult): UninstallResult => ({
  bundleId,
  removed: outcome.removed,
  skipped: [
    ...outcome.kept.map((file) => file.path),
    ...outcome.refused,
    ...outcome.missing,
    ...outcome.errors.map((file) => file.path)
  ],
  outcome
});

const COMMIT_MODES: readonly RepositoryCommitMode[] = ['commit', 'local-only'];

/**
 * Uninstall pipeline for bundle removal.
 */
export class UninstallPipeline {
  private readonly fs: FileSystem;
  private readonly target: Target;
  private readonly repositoryPath: string;
  private readonly writerFactory: (target: Target) => TargetWriter;
  private readonly exclusion: RepositoryExclusion;
  private readonly store: InstallRecordStore;
  private readonly preserveModified: boolean;

  public constructor(opts: UninstallPipelineOptions) {
    this.fs = opts.fs;
    this.target = opts.target;
    this.repositoryPath = opts.repositoryPath;
    this.writerFactory = opts.writerFactory;
    this.exclusion = opts.exclusion ?? new GitInfoExclude({ fs: opts.fs, workspaceRoot: opts.repositoryPath });
    this.store = createLockfileRecordStore({
      scope: 'repository',
      fs: opts.fs,
      rootPath: opts.repositoryPath,
      generatedBy: opts.generatedBy ?? 'ai-primitives-hub-cli',
      exclusion: this.exclusion
    });
    this.preserveModified = opts.preserveModified ?? false;
  }

  /**
   * Uninstall one recorded bundle through the shared use case.
   * @param id - Bundle id.
   * @returns Uninstall result.
   */
  private async uninstall(id: string): Promise<UninstallResult> {
    const outcome = await applyBundleUninstall({
      writerFactory: this.writerFactory,
      target: this.target,
      key: id,
      store: this.store,
      exclusion: this.exclusion,
      fs: this.fs,
      preserveModified: this.preserveModified
    });
    return uninstallResultOf(id, outcome);
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
   * Execute uninstall by removing files and updating the lockfile
   * through the shared uninstall.
   * @param id - Bundle ID to uninstall.
   * @returns Uninstall result.
   */
  public async run(id: string): Promise<UninstallResult> {
    const plan = await this.plan(id);

    if (plan.lockfileEntry === null || plan.commitMode === undefined) {
      return { bundleId: id, removed: [], skipped: [] };
    }

    return this.uninstall(id);
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

      results.push(await this.uninstall(plan.bundleId));
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
