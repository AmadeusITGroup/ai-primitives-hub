/**
 * `bundle build` release planning use case.
 *
 * Plans the governed release from the committed revision and, only when
 * that revision carries no license evidence, falls back to the legacy
 * working-tree release with a warning. The fallback rule and warning text
 * live in core (`isMissingSourceLicenseError`, `LEGACY_RELEASE_WARNING`).
 * @module release/plan-bundle-release
 */
import {
  createLegacyReleaseManifestPlan,
  createReleaseManifestPlan,
  isMissingSourceLicenseError,
  LEGACY_RELEASE_WARNING,
  type ReleaseManifestPlan,
  type ReleaseSourceReader,
} from '@ai-primitives-hub/core';
import {
  NodeReleaseSourceReader,
} from '@ai-primitives-hub/infra';

/** Inputs for {@link planBundleRelease}. */
export interface PlanBundleReleaseOptions {
  /** Absolute repository root. */
  repoRoot: string;
  /** Collection file, repo-relative or absolute under `repoRoot`. */
  collectionFile: string;
  version: string;
  /** Source reader; defaults to {@link NodeReleaseSourceReader}. */
  sources?: ReleaseSourceReader;
}

/** A release plan and the warnings raised while planning it. */
export interface BundleReleasePlan {
  plan: ReleaseManifestPlan;
  warnings: string[];
}

/**
 * Plan the release archive for one collection.
 * @param options - Planning inputs.
 * @returns The governed plan, or the legacy plan plus {@link LEGACY_RELEASE_WARNING}.
 * Rejects with any planning failure other than missing license evidence.
 */
export async function planBundleRelease(options: PlanBundleReleaseOptions): Promise<BundleReleasePlan> {
  const sources = options.sources ?? new NodeReleaseSourceReader();
  const planOptions = {
    repoRoot: options.repoRoot,
    collectionFile: options.collectionFile,
    version: options.version
  };
  const warnings: string[] = [];
  let plan: ReleaseManifestPlan;
  try {
    plan = await createReleaseManifestPlan(planOptions, sources);
  } catch (err) {
    if (!isMissingSourceLicenseError(err)) {
      throw err;
    }
    plan = await createLegacyReleaseManifestPlan(planOptions, sources);
    warnings.push(LEGACY_RELEASE_WARNING);
  }
  return { plan, warnings };
}
