/**
 * Safe target-write orchestration.
 *
 * A writer may know that a target cannot accept part of a bundle. Keep that
 * decision before the first filesystem mutation whenever the writer exposes
 * `preflight`; retain the result check as a compatibility guard for older or
 * external writers that only implement `write`.
 * @module install/target-write
 */
import type {
  CopilotFileType,
  ExtractedFiles,
  Target,
  TargetWriter,
  TargetWriteResult,
  ValidatedManifest,
} from '@ai-primitives-hub/core';
import {
  determineFileType,
  getFileExtension,
  getInstallableBundleFiles,
} from '@ai-primitives-hub/core';
import {
  FileTreeTargetWriter,
  type ManifestPlacementItem,
  skillSourcePrefix,
} from '../writers/file-tree-writer';

/**
 * Raised when a target cannot install every routed bundle file.
 */
export class TargetWriteRejectedError extends Error {
  public readonly code = 'BUNDLE.UNSUPPORTED_CONTENT';

  public constructor(public readonly skipped: readonly string[]) {
    super(`target cannot install bundle content: ${[...skipped].toSorted().join(', ')}`);
    this.name = 'TargetWriteRejectedError';
  }
}

/**
 * Preflight and execute a target write without accepting partial content.
 * @param writer Target writer.
 * @param target Target configuration.
 * @param files Extracted bundle files.
 * @returns The successful writer result.
 * @throws {TargetWriteRejectedError} When content is skipped.
 */
export async function writeTargetSafely(
  writer: TargetWriter,
  target: Target,
  files: ExtractedFiles
): Promise<TargetWriteResult> {
  if (writer.preflight !== undefined) {
    const plan = await writer.preflight(target, files);
    if (plan.skipped.length > 0) {
      throw new TargetWriteRejectedError(plan.skipped);
    }
  }

  const result = await writer.write(target, files);
  if (result.skipped.length > 0) {
    if (writer.rollback !== undefined && result.written.length > 0) {
      try {
        await writer.rollback(target, result.written);
      } catch {
        // Preserve the policy failure; rollback is explicitly best effort.
      }
    }
    throw new TargetWriteRejectedError(result.skipped);
  }
  return result;
}

const COPILOT_FILE_TYPES: ReadonlySet<string> = new Set<CopilotFileType>([
  'prompt',
  'instructions',
  'chatmode',
  'agent',
  'skill'
]);

/**
 * Turn a validated manifest's `prompts:` list into placement items for
 * {@link FileTreeTargetWriter.writeManifestItems}.
 *
 * Only file-backed entries count: an entry needs an `id` and a `file`.
 * An entry without `type` has its type auto-detected from `file`/`tags`;
 * an entry whose `type` is not a Copilot file type (prompt, instructions,
 * chatmode, agent, skill) is left out, so its file keeps today's path
 * routing. MCP servers live under `mcpServers`, not `prompts`, and are
 * never placement items.
 * @param manifest Validated deployment manifest.
 * @returns Placement items in manifest order.
 */
export function manifestPlacementItems(manifest: ValidatedManifest): ManifestPlacementItem[] {
  const prompts = (manifest as { prompts?: unknown }).prompts;
  if (!Array.isArray(prompts)) {
    return [];
  }
  const items: ManifestPlacementItem[] = [];
  for (const entry of prompts as unknown[]) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const { id, file, type, tags } = entry as Record<string, unknown>;
    // YAML can parse a numeric-looking id as a number.
    const itemId = typeof id === 'number' ? String(id) : id;
    if (typeof itemId !== 'string' || itemId.length === 0 || typeof file !== 'string' || file.length === 0) {
      continue;
    }
    if (type !== undefined && (typeof type !== 'string' || !COPILOT_FILE_TYPES.has(type))) {
      continue;
    }
    const itemTags = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : undefined;
    const effectiveType = (type as CopilotFileType | undefined) ?? determineFileType(file, itemTags);
    items.push({
      id: stripTypeSuffix(itemId, effectiveType),
      file,
      ...(type === undefined ? {} : { type: type as CopilotFileType }),
      ...(itemTags === undefined ? {} : { tags: itemTags })
    });
  }
  return items;
}

/**
 * Drop a trailing type marker from an item id (`x.instructions` →
 * `x`, `x.prompt` → `x`). Manifests built by `bundle build` derive ids
 * from file names, so `getTargetFileName` would otherwise produce
 * `x.instructions.instructions.md`. Skills are named by directory and
 * keep their id.
 * @param id Manifest item id.
 * @param type Item type.
 * @returns The id without a trailing `.{type}` marker.
 */
const stripTypeSuffix = (id: string, type: CopilotFileType): string => {
  const marker = getFileExtension(type).replace(/\.md$/, '');
  return marker.length > 0 && id.length > marker.length && id.toLowerCase().endsWith(marker)
    ? id.slice(0, -marker.length)
    : id;
};

/**
 * Whether a placement item has installable content. Archives hold files,
 * not directories, so a skill item whose `file:` names the skill directory
 * (`skills/foo`) counts when at least one installable file lies under it;
 * any other item needs its own file to be installable.
 * @param item Placement item.
 * @param installableFiles Installable bundle files.
 * @returns Whether the item can be placed.
 */
const isInstallableItem = (item: ManifestPlacementItem, installableFiles: ExtractedFiles): boolean => {
  if (installableFiles.has(item.file)) {
    return true;
  }
  const type = item.type ?? determineFileType(item.file, item.tags);
  if (type !== 'skill') {
    return false;
  }
  const prefix = skillSourcePrefix(item.file);
  return prefix !== null && [...installableFiles.keys()].some((bundlePath) => bundlePath.startsWith(prefix));
};

/**
 * Result of {@link writeBundleSafely}.
 */
export interface BundleTargetWrite {
  /** The installable files handed to the writer (see `getInstallableBundleFiles`). */
  installableFiles: ExtractedFiles;
  /** The successful writer result. */
  result: TargetWriteResult;
}

/**
 * Write a validated bundle into a target, placing manifest items by type.
 *
 * For a {@link FileTreeTargetWriter} whose manifest lists file-backed
 * items (see {@link manifestPlacementItems}), every item goes through
 * `writeManifestItems` (by type onto the layout's skills/instructions/
 * prompts/agents routes, renamed by item id; a skill copies its whole
 * directory), and every installable file no item covers goes through
 * path-routed `write()`. Any other writer, or a manifest without items,
 * uses {@link writeTargetSafely} unchanged.
 *
 * Same policy as `writeTargetSafely`: nothing is written when an item or
 * an uncovered file cannot be placed, and anything written is rolled
 * back when a late skip or failure occurs.
 * @param writer Target writer.
 * @param target Target configuration.
 * @param files Extracted bundle files (full archive).
 * @param manifest Validated manifest of `files`.
 * @returns The installable files and the successful writer result.
 * @throws {TargetWriteRejectedError} When content cannot be placed.
 */
export async function writeBundleSafely(
  writer: TargetWriter,
  target: Target,
  files: ExtractedFiles,
  manifest: ValidatedManifest
): Promise<BundleTargetWrite> {
  const installableFiles = getInstallableBundleFiles(files, manifest);
  const items = writer instanceof FileTreeTargetWriter
    ? manifestPlacementItems(manifest).filter((item) => isInstallableItem(item, installableFiles))
    : [];
  if (!(writer instanceof FileTreeTargetWriter) || items.length === 0) {
    return { installableFiles, result: await writeTargetSafely(writer, target, installableFiles) };
  }

  const itemPlan = await writer.preflightManifestItems(target, installableFiles, items);
  if (itemPlan.skipped.length > 0) {
    throw new TargetWriteRejectedError(itemPlan.skipped);
  }
  const covered = new Set(itemPlan.writable);
  const rest: ExtractedFiles = new Map([...installableFiles].filter(([bundlePath]) => !covered.has(bundlePath)));
  const restPlan = await writer.preflight(target, rest);
  if (restPlan.skipped.length > 0) {
    throw new TargetWriteRejectedError(restPlan.skipped);
  }

  const itemResult = await writer.writeManifestItems(target, installableFiles, items);
  let restResult: TargetWriteResult;
  try {
    restResult = await writer.write(target, rest);
  } catch (cause) {
    await writer.rollback(target, itemResult.written);
    throw cause;
  }
  const result: TargetWriteResult = {
    written: [...itemResult.written, ...restResult.written],
    skipped: [...itemResult.skipped, ...restResult.skipped],
    writtenBundlePaths: [...(itemResult.writtenBundlePaths ?? []), ...(restResult.writtenBundlePaths ?? [])],
    installedPaths: itemResult.installedPaths ?? {}
  };
  if (result.skipped.length > 0) {
    await writer.rollback(target, result.written);
    throw new TargetWriteRejectedError(result.skipped);
  }
  return { installableFiles, result };
}

/**
 * A file recorded for an installed bundle (shape of a lockfile file entry).
 */
export interface RecordedBundleFile {
  /** Bundle-relative source path. */
  path: string;
  /** Base-relative install location, when recorded by manifest placement. */
  installedPath?: string;
}

/**
 * Remove the files a previous install of a bundle left that the new
 * install no longer produces.
 *
 * Manifest placement can move a file (`prompts/x.md`, path-routed, becomes
 * `prompts/x.prompt.md`), and a new version can drop one; overwriting the
 * lockfile entry alone would leave those files behind. Files are compared
 * by physical location — `installedPath` when recorded, otherwise the
 * path-routed destination — so a file the new install wrote to the same
 * place is never removed. Removal goes through `writer.remove`, which keeps
 * its target-boundary check, and is best effort like uninstall.
 *
 * Only a {@link FileTreeTargetWriter} can report physical locations; for
 * any other writer nothing is removed.
 * @param writer Writer that performed the new install.
 * @param target Target configuration.
 * @param previous Files of the replaced lockfile entry (`undefined` when none).
 * @param next Files of the new lockfile entry.
 * @returns Bundle paths of the superseded files that were removed.
 */
export async function removeSupersededFiles(
  writer: TargetWriter,
  target: Target,
  previous: readonly RecordedBundleFile[] | undefined,
  next: readonly RecordedBundleFile[]
): Promise<string[]> {
  if (previous === undefined || previous.length === 0 || !(writer instanceof FileTreeTargetWriter)) {
    return [];
  }
  const produced = new Set(await writer.installedLocations(target, next));
  const oldLocations = await writer.installedLocations(target, previous);
  const removed: string[] = [];
  for (const [index, file] of previous.entries()) {
    const location = oldLocations[index];
    if (location === null || produced.has(location)) {
      continue;
    }
    try {
      await (file.installedPath === undefined
        ? writer.remove(target, file.path)
        : writer.remove(target, file.path, file.installedPath));
      removed.push(file.path);
    } catch {
      // Best effort, like uninstall: the new version is already installed.
    }
  }
  return removed;
}
