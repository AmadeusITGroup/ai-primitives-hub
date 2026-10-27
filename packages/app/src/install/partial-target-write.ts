/**
 * Opt-in partial install.
 *
 * By default an install is all-or-nothing: {@link writeBundleSafely}
 * rejects the bundle when the target cannot hold every item. With
 * `skipUnsupported`, the content the target supports is written and the
 * rest is reported, so the caller can record only what was installed.
 * @module install/partial-target-write
 */
import type {
  ExtractedFiles,
  Target,
  TargetWriter,
  TargetWriteResult,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import {
  determineFileType,
  getInstallableBundleFiles,
} from '@ai-primitives-hub/core';
import {
  FileTreeTargetWriter,
  type ManifestPlacementItem,
  skillSourcePrefix,
} from '../writers/file-tree-writer';
import {
  type BundleTargetWrite,
  isInstallableItem,
  manifestPlacementItems,
  TargetWriteRejectedError,
  writeBundleSafely,
} from './target-write';

/**
 * A bundle item a partial install left out.
 */
export interface SkippedBundleContent {
  /** Bundle-relative path (a manifest item's `file`, or a path-routed file). */
  path: string;
  /** Machine-readable reason code. */
  code: 'BUNDLE.UNSUPPORTED_CONTENT';
  /** Human-readable reason. */
  reason: string;
}

/**
 * Result of {@link writeBundleForInstall}.
 */
export interface BundleInstallWrite extends BundleTargetWrite {
  /** Content left out of the install, sorted by path; empty unless `skipUnsupported` is set. */
  skipped: SkippedBundleContent[];
}

/**
 * Options for {@link writeBundleForInstall}.
 */
export interface WriteBundleForInstallOptions {
  /**
   * Install the content the target supports and report the rest instead
   * of rejecting the bundle. Defaults to `false` (all-or-nothing).
   */
  skipUnsupported?: boolean;
}

/** A writer result plus every bundle path skipped by preflight or write. */
interface SkippingWrite {
  result: TargetWriteResult;
  skippedPaths: string[];
}

/**
 * Write a validated bundle into a target for an install.
 *
 * Without `skipUnsupported` this is {@link writeBundleSafely}, unchanged:
 * nothing is written when any content cannot be placed. With it, the
 * install is planned before the first write, the supported content is
 * written, and each skipped item is returned in `skipped`. The returned
 * `result.writtenBundlePaths` then lists only installed files, so a
 * lockfile entry built from it never records skipped content.
 *
 * In both modes the bundle is rejected, with nothing written, when the
 * target supports none of its content, and a write failure rolls back
 * what was written.
 * @param writer Target writer.
 * @param target Target configuration.
 * @param files Extracted bundle files (full archive).
 * @param manifest Validated manifest of `files`.
 * @param options Install options.
 * @returns The installable files, the writer result and the skipped content.
 * @throws {TargetWriteRejectedError} When content cannot be placed (default)
 *   or when nothing can be placed (`skipUnsupported`).
 */
export async function writeBundleForInstall(
  writer: TargetWriter,
  target: Target,
  files: ExtractedFiles,
  manifest: ValidatedManifest,
  options: WriteBundleForInstallOptions = {}
): Promise<BundleInstallWrite> {
  if (options.skipUnsupported !== true) {
    return { ...(await writeBundleSafely(writer, target, files, manifest)), skipped: [] };
  }

  const installableFiles = getInstallableBundleFiles(files, manifest);
  const items = writer instanceof FileTreeTargetWriter
    ? manifestPlacementItems(manifest).filter((item) => isInstallableItem(item, installableFiles))
    : [];
  const { result, skippedPaths } = writer instanceof FileTreeTargetWriter && items.length > 0
    ? await writeItemsSkipping(writer, target, installableFiles, items)
    : await writeSkipping(writer, target, installableFiles);

  const skipped = [...new Set(skippedPaths)].toSorted();
  const skippedSet = new Set(skipped);
  const reason = `target "${target.name}" (${target.type}) cannot install this content`;
  return {
    installableFiles,
    result: {
      ...result,
      skipped,
      writtenBundlePaths: result.writtenBundlePaths
        ?? [...installableFiles.keys()].filter((bundlePath) => !skippedSet.has(bundlePath))
    },
    skipped: skipped.map((bundlePath) => ({ path: bundlePath, code: 'BUNDLE.UNSUPPORTED_CONTENT', reason }))
  };
}

/**
 * Partial write through the writer's own `preflight`/`write`. The full
 * file map is passed on: writers skip what they cannot place, and a
 * repository-scope writer needs every file of a skill directory.
 * @param writer Target writer.
 * @param target Target configuration.
 * @param installableFiles Installable bundle files.
 * @returns The writer result and every skipped bundle path.
 * @throws {TargetWriteRejectedError} When nothing can be written.
 */
async function writeSkipping(
  writer: TargetWriter,
  target: Target,
  installableFiles: ExtractedFiles
): Promise<SkippingWrite> {
  const plan = writer.preflight === undefined ? undefined : await writer.preflight(target, installableFiles);
  if (plan !== undefined && plan.skipped.length > 0 && plan.writable.length === 0) {
    throw new TargetWriteRejectedError(plan.skipped);
  }
  const result = await writer.write(target, installableFiles);
  const skippedPaths = [...(plan?.skipped ?? []), ...result.skipped];
  if (result.written.length === 0 && skippedPaths.length > 0) {
    throw new TargetWriteRejectedError(skippedPaths);
  }
  return { result, skippedPaths };
}

/**
 * Partial write of a bundle whose manifest lists placement items: items
 * go through `writeManifestItems`, every other file through path-routed
 * `write`. The files of a skipped item are never path-routed, so they
 * cannot land elsewhere (or over another item's file) by accident.
 * @param writer File-tree writer.
 * @param target Target configuration.
 * @param installableFiles Installable bundle files.
 * @param items Installable placement items.
 * @returns The merged writer result and every skipped bundle path.
 * @throws {TargetWriteRejectedError} When nothing can be written.
 */
async function writeItemsSkipping(
  writer: FileTreeTargetWriter,
  target: Target,
  installableFiles: ExtractedFiles,
  items: readonly ManifestPlacementItem[]
): Promise<SkippingWrite> {
  const itemPlan = await writer.preflightManifestItems(target, installableFiles, items);
  const covered = new Set(itemPlan.writable);
  const skippedFiles = new Set(itemPlan.skipped);
  const skippedItems = items.filter((item) => skippedFiles.has(item.file));
  const belongsToSkippedItem = (bundlePath: string): boolean => skippedItems.some((item) => {
    if (bundlePath === item.file) {
      return true;
    }
    if ((item.type ?? determineFileType(item.file, item.tags)) !== 'skill') {
      return false;
    }
    const prefix = skillSourcePrefix(item.file);
    return prefix !== null && bundlePath.startsWith(prefix);
  });
  const rest: ExtractedFiles = new Map([...installableFiles]
    .filter(([bundlePath]) => !covered.has(bundlePath) && !belongsToSkippedItem(bundlePath)));
  const restPlan = await writer.preflight(target, rest);
  if (covered.size + restPlan.writable.length === 0) {
    throw new TargetWriteRejectedError([...itemPlan.skipped, ...restPlan.skipped]);
  }

  const itemResult = await writer.writeManifestItems(target, installableFiles, items);
  let restResult: TargetWriteResult;
  try {
    restResult = await writer.write(target, rest);
  } catch (cause) {
    await writer.rollback(target, itemResult.written);
    throw cause;
  }
  return {
    result: {
      written: [...itemResult.written, ...restResult.written],
      skipped: [...itemResult.skipped, ...restResult.skipped],
      writtenBundlePaths: [...(itemResult.writtenBundlePaths ?? []), ...(restResult.writtenBundlePaths ?? [])],
      installedPaths: itemResult.installedPaths ?? {}
    },
    skippedPaths: [...itemPlan.skipped, ...restPlan.skipped, ...itemResult.skipped, ...restResult.skipped]
  };
}
