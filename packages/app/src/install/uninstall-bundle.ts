/**
 * UninstallBundleUseCase — application-layer orchestrator for bundle
 * removal. Wraps `UninstallPipeline` and depends only on port interfaces.
 *
 * This module never instantiates concrete classes; it only calls
 * port interface methods.
 * @module app/install/uninstall-bundle
 */
import {
  UninstallPipeline,
  type UninstallPlan,
  type UninstallResult,
} from '../../app/install/uninstall-pipeline';
import type {
  Target,
} from '../../domain/install';
import type {
  FileSystem,
} from '../../ports/filesystem';
import type {
  TargetWriter,
} from '../../ports/target-writer';

export interface UninstallBundleInput {
  bundleId?: string;
  target: Target;
  lockfilePath: string;
}

export interface UninstallBundleOptions {
  fs: FileSystem;
  writerFactory: (target: Target) => TargetWriter;
}

/**
 * Plan a bundle uninstall (reads lockfile, produces removal list).
 * @param input Bundle id, target, and lockfile path.
 * @param opts Injected port implementations.
 * @returns Uninstall plan.
 */
export const planUninstall = (
  input: UninstallBundleInput,
  opts: UninstallBundleOptions
): Promise<UninstallPlan | UninstallPlan[]> => {
  const pipeline = createPipeline(input, opts);
  return input.bundleId === undefined
    ? pipeline.planAll()
    : pipeline.plan(input.bundleId);
};

/**
 * Execute a bundle uninstall.
 * @param input Bundle id, target, and lockfile path.
 * @param opts Injected port implementations.
 * @returns Uninstall result.
 */
export const uninstallBundle = (
  input: UninstallBundleInput,
  opts: UninstallBundleOptions
): Promise<UninstallResult | UninstallResult[]> => {
  const pipeline = createPipeline(input, opts);
  return input.bundleId === undefined
    ? pipeline.runAll()
    : pipeline.run(input.bundleId);
};

const createPipeline = (
  input: UninstallBundleInput,
  opts: UninstallBundleOptions
): UninstallPipeline =>
  new UninstallPipeline({
    fs: opts.fs,
    target: input.target,
    lockfile: input.lockfilePath,
    writerFactory: opts.writerFactory
  });
