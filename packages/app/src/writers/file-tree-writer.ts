/**
 * TargetWriter interface + FileTreeTargetWriter.
 *
 * Writer = "given a Target, an Installable's manifest, and the
 * extracted file map, route the bundle's primitive files into the
 * target's filesystem layout".
 *
 * Layout definitions are loaded from a data-driven configuration
 * (see `infra/writers/default-layouts.json`, re-exported through
 * `@ai-primitives-hub/infra`'s barrel as `defaultLayouts` — this
 * module deliberately does not keep its own copy; the reference
 * branch this was ported from had two independently-drifted copies,
 * one in `infra` and one here, which is exactly the defect this
 * single-source-of-truth import avoids). The `resolveLayout` function
 * is a synchronous compatibility shim that uses the built-in defaults
 * only; async callers with a `LayoutConfigLoader` can use
 * `resolveLayoutAsync` for hierarchical overrides (built-in → user →
 * project).
 *
 * The writer is fully context-driven: no Node globals, all IO
 * through the injected `WriterFs`.
 * @module writers/file-tree-writer
 */
import * as path from 'node:path';
import type {
  CopilotFileType,
  ExtractedFiles,
  KindRoutes,
  LayoutConfigLoader,
  PrimitiveKind,
  ResourceTransformer,
  Target,
  TargetLayout,
  TargetWritePlan,
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';
import {
  decodeUtf8Strict,
  determineFileType,
  expandPath,
  getSkillName,
  getTargetFileName,
  normalizePrimitiveKind,
  normalizePromptId,
  verifyWrittenBytes,
} from '@ai-primitives-hub/core';
import {
  defaultLayouts as builtInLayouts,
} from '@ai-primitives-hub/infra';
import {
  resolveLayoutFromLayers,
} from '../install/layout-resolver';

export type {
  ExtractedFiles,
} from '@ai-primitives-hub/core';

export type {
  TargetWriter,
  TargetWriteResult,
} from '@ai-primitives-hub/core';

export interface WriterFs {
  writeFile(p: string, contents: string): Promise<void>;
  /**
   * Write raw bytes verbatim. Required for binary bundle assets
   * (images, archives, office documents): decoding them through the
   * string `writeFile` path is lossy and corrupts them (issue #357).
   */
  writeFileBytes(p: string, bytes: Uint8Array): Promise<void>;
  /** Byte-level read-back used for post-write integrity verification. */
  readFileBytes(p: string): Promise<Uint8Array>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
}

/**
 * A manifest-driven placement instruction: "this bundle-relative source
 * file/directory is primitive `id` of Copilot type `type`". Used by
 * `FileTreeTargetWriter.writeManifestItems` for targets/scopes (e.g. the
 * VS Code extension's user/repository scopes) whose real on-disk
 * convention renames every file to `{id}.{type-extension}` rather than
 * preserving the bundle's own directory layout — see migration plan
 * §7.5 item 2 for why this is a separate mode from `write()`'s
 * prefix-preserving routing.
 */
export interface ManifestPlacementItem {
  /** Manifest item id; used to compute the renamed on-disk file name. */
  id: string;
  /** Bundle-relative source path (looked up in the `ExtractedFiles` map). */
  file: string;
  /** Copilot file type; auto-detected from `file`/`tags` when omitted. */
  type?: CopilotFileType;
  tags?: string[];
}

/**
 * Maps a `CopilotFileType` to the `default-layouts.json` kindRoutes key
 * whose *value* (the output subdirectory) applies to it. Chatmodes are
 * deliberately routed through the agents key because they are associated
 * with agents at runtime.
 */
export const KIND_TO_ROUTE_KEY: Record<CopilotFileType, string> = {
  prompt: 'prompts/',
  instructions: 'instructions/',
  chatmode: 'agents/',
  agent: 'agents/',
  skill: 'skills/'
};

/**
 * Result of a remove operation.
 * Contains removed and skipped file paths.
 */
export interface TargetRemoveResult {
  /** Absolute paths of files removed. */
  removed: string[];
  /** Files not found (skipped). */
  skipped: string[];
}

// Re-export domain types for backward compatibility with existing callers.
export type { KindRoutes, TargetLayout } from '@ai-primitives-hub/core';

// Satisfy local usage (TypeScript needs the types in scope for the functions below).
// The re-export above covers external callers.

/**
 * Resolve the layout for a given Target using the built-in defaults.
 * Synchronous; uses the embedded JSON config (no filesystem IO).
 * For hierarchical override support (user + project configs) use
 * `resolveLayoutAsync` instead.
 * @param target - Target to resolve.
 * @returns Resolved TargetLayout.
 */
export const resolveLayout = (target: Target): TargetLayout => {
  // Cast needed: TypeScript widens JSON string values to `string`, making
  // serversKey: string incompatible with McpServersKey. Values are correct at runtime.
  const result = resolveLayoutFromLayers(target, [builtInLayouts]);
  if (result === null) {
    throw new Error(`No layout defined for target type "${target.type}"`);
  }
  return result;
};

/**
 * Resolve the layout for a given Target using all available layers
 * (built-in + user config + project config).
 * @param target - Target to resolve.
 * @param loader - Layout config loader (injected for testability).
 * @returns Resolved TargetLayout.
 */
export const resolveLayoutAsync = async (
  target: Target,
  loader: LayoutConfigLoader
): Promise<TargetLayout> => {
  const layers = await loader.load();
  const result = resolveLayoutFromLayers(target, layers);
  if (result === null) {
    throw new Error(`No layout defined for target type "${target.type}"`);
  }
  return result;
};

/**
 * Re-export of `expandPath` (expands `${VAR}` and a leading `~` in a path).
 * @deprecated Import `expandPath` from `@ai-primitives-hub/core` directly. This re-export
 * is kept for backward compatibility and will be removed in a future version.
 */
export { expandPath } from '@ai-primitives-hub/core';

/**
 * Options for FileTreeTargetWriter.
 */
export interface FileTreeTargetWriterOptions {
  fs: WriterFs;
  /** Process env, used for ${VAR} expansion. */
  env: Record<string, string | undefined>;
  /** Optional resource transformer for target-specific content transformations. */
  transformer?: ResourceTransformer;
  /** Optional hierarchical layout loader; built-in defaults are used when omitted. */
  layoutLoader?: LayoutConfigLoader;
}

/**
 * Generic writer that routes bundle files into a target tree using
 * the layout returned by resolveLayout(target).
 */
/* eslint-disable @typescript-eslint/member-ordering -- public API kept above helpers. */
export class FileTreeTargetWriter implements TargetWriter {
  /**
   * Construct a FileTreeTargetWriter.
   * @param opts Writer options including filesystem and environment.
   */
  public constructor(private readonly opts: FileTreeTargetWriterOptions) {}

  /**
   * Determine which extracted bundle files this writer can place without
   * changing the target filesystem.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Extracted bundle files.
   * @returns Deterministic writable/skipped bundle-relative paths.
   */
  public async preflight(target: Target, files: ExtractedFiles): Promise<TargetWritePlan> {
    const layout = await this.resolveLayout(target);
    const skip = new Set(layout.skipPaths);
    const allowed = target.allowedKinds === undefined
      ? null
      : new Set(target.allowedKinds.map((kind) => normalizePrimitiveKind(kind) ?? kind));
    const writable: string[] = [];
    const skipped: string[] = [];

    for (const bundlePath of files.keys()) {
      if (skip.has(bundlePath)) {
        continue;
      }
      const route = pickRoute(bundlePath, layout.kindRoutes);
      if (route === null) {
        skipped.push(bundlePath);
        continue;
      }
      const routeKind = routeToKind(route.prefix);
      if (allowed !== null && (routeKind === null || !allowed.has(routeKind))) {
        skipped.push(bundlePath);
        continue;
      }
      writable.push(bundlePath);
    }

    return { writable, skipped };
  }

  /**
   * Write the bundle into the target.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Extracted bundle files.
   * @returns TargetWriteResult.
   */
  public async write(target: Target, files: ExtractedFiles): Promise<TargetWriteResult> {
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const skip = new Set(layout.skipPaths);
    const allowed = target.allowedKinds === undefined
      ? null
      : new Set(target.allowedKinds.map((kind) => normalizePrimitiveKind(kind) ?? kind));
    const written: string[] = [];
    const writtenBundlePaths: string[] = [];
    const skipped: string[] = [];
    let pendingWritePath: string | null = null;

    try {
      // Eager mkdir of the routed-kind directories; reduces churn over
      // calling mkdir per file. Per-kind subdir creation is recursive
      // so root + nested dirs are covered.
      for (const sub of Object.values(layout.kindRoutes)) {
        await this.opts.fs.mkdir(path.join(baseDir, sub), { recursive: true });
      }

      for (const [bundlePath, bytes] of files) {
        if (skip.has(bundlePath)) {
          continue;
        }
        const route = pickRoute(bundlePath, layout.kindRoutes);
        if (route === null) {
          // Unrouted file; not an error (bundles may carry extras).
          skipped.push(bundlePath);
          continue;
        }
        // Skip when allowedKinds explicitly excludes this kind.
        const routeKind = routeToKind(route.prefix);
        if (allowed !== null && (routeKind === null || !allowed.has(routeKind))) {
          skipped.push(bundlePath);
          continue;
        }

        const outPath = path.join(baseDir, route.outPrefix, route.tail);
        // Keep the path visible to the catch block before write starts:
        // a filesystem can persist the file and then throw.
        pendingWritePath = outPath;
        await this.writeContent(target, bundlePath, bytes, outPath);
        pendingWritePath = null;
        written.push(outPath);
        writtenBundlePaths.push(bundlePath);
      }
    } catch (cause) {
      const rollbackPaths = pendingWritePath === null
        ? written
        : [...written, pendingWritePath];
      await this.rollback(target, rollbackPaths);
      throw cause;
    }
    return { written, skipped, writtenBundlePaths };
  }

  /**
   * Remove files written by a failed or rejected installation.
   * @param _target - Target chosen via `--target <name>`.
   * @param written - Absolute paths returned by `write`.
   */
  public async rollback(_target: Target, written: readonly string[]): Promise<void> {
    for (const filePath of written) {
      try {
        await this.opts.fs.remove(filePath);
      } catch {
        // Rollback is best effort; preserve the original install failure.
      }
    }
  }

  /**
   * Write one bundle file to its resolved output path, binary-safe
   * (issue #357).
   *
   * Text payloads (strict UTF-8) go through the optional transformer
   * and are written as strings; anything else is written byte-for-byte
   * — the previous unconditional `TextDecoder` round-trip replaced
   * invalid UTF-8 sequences with U+FFFD and corrupted binary assets
   * such as PPTX files. Every write is verified by re-reading the file
   * and comparing it against the intended bytes.
   * @param target - Install target (passed to the transformer).
   * @param bundlePath - Bundle-relative source path (transformer context).
   * @param bytes - Raw source bytes from the extracted bundle.
   * @param outPath - Absolute destination path.
   */
  private async writeContent(
    target: Target,
    bundlePath: string,
    bytes: Uint8Array,
    outPath: string
  ): Promise<void> {
    await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });

    const text = decodeUtf8Strict(bytes);
    if (text === null) {
      // Binary payload: write verbatim, never transform.
      await this.opts.fs.writeFileBytes(outPath, bytes);
      await verifyWrittenBytes(this.opts.fs, outPath, bytes);
      return;
    }

    let content = text;
    if (this.opts.transformer !== undefined) {
      try {
        const result = this.opts.transformer.transform({
          target,
          filePath: bundlePath,
          content
        });
        content = result.content;
      } catch {
        // Fail-safe: on transformation error, use original content
        // In production, this would log a warning
      }
    }
    await this.opts.fs.writeFile(outPath, content);
    await verifyWrittenBytes(this.opts.fs, outPath, new TextEncoder().encode(content));
  }

  /**
   * Write bundle files into the target using manifest-driven, ID-based
   * renaming rather than `write()`'s prefix-preserving routing.
   *
   * For each item: the Copilot file type (explicit or auto-detected from
   * `file`/`tags`) selects the output subdirectory via
   * {@link KIND_TO_ROUTE_KEY} + the layout's `kindRoutes`, and the output
   * file name is `{id}.{type-extension}` (via `core`'s `getTargetFileName`)
   * rather than the source file's own name. Skill items are the exception:
   * every bundle file under the skill's `skills/<sourceId>/` prefix is
   * copied, preserving its relative path, into
   * `{baseDir}/{skillsRoute}/{normalizedId}/`.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Extracted bundle files.
   * @param items - Manifest-derived placement instructions.
   * @returns TargetWriteResult.
   */
  public async writeManifestItems(
    target: Target,
    files: ExtractedFiles,
    items: readonly ManifestPlacementItem[]
  ): Promise<TargetWriteResult> {
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    const allowed = allowedKindSet(target);
    const written: string[] = [];
    const writtenBundlePaths: string[] = [];
    const installedPaths: Record<string, string> = {};
    const skipped: string[] = [];
    const record = (bundlePath: string, outPath: string): void => {
      written.push(outPath);
      writtenBundlePaths.push(bundlePath);
      installedPaths[bundlePath] = toInstalledPath(baseDir, outPath);
    };
    let pendingWritePath: string | null = null;

    const taken = new Set<string>();

    try {
      for (const item of items) {
        const placement = placeManifestItem(item, files, layout, allowed);
        // Never let a later item silently overwrite an earlier item's file.
        if (placement === null || !claimDestinations(placement, taken)) {
          skipped.push(item.file);
          continue;
        }
        for (const { bundlePath, tail } of placement.sources) {
          const outPath = path.join(baseDir, placement.outDir, tail);
          const bytes = files.get(bundlePath) as Uint8Array;
          // Keep the path visible to the catch block before write starts:
          // a filesystem can persist the file and then throw.
          pendingWritePath = outPath;
          if (placement.type === 'skill') {
            // Skill directories carry arbitrary assets (scripts, images,
            // office documents) — copy byte-for-byte, never transform.
            await this.opts.fs.mkdir(path.dirname(outPath), { recursive: true });
            await this.opts.fs.writeFileBytes(outPath, bytes);
            await verifyWrittenBytes(this.opts.fs, outPath, bytes);
          } else {
            await this.writeContent(target, bundlePath, bytes, outPath);
          }
          pendingWritePath = null;
          record(bundlePath, outPath);
        }
      }
    } catch (cause) {
      const rollbackPaths = pendingWritePath === null
        ? written
        : [...written, pendingWritePath];
      await this.rollback(target, rollbackPaths);
      throw cause;
    }

    return { written, skipped, writtenBundlePaths, installedPaths };
  }

  /**
   * Determine, without touching the filesystem, which manifest items
   * {@link writeManifestItems} can place.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Extracted bundle files.
   * @param items - Manifest-derived placement instructions.
   * @returns `writable` lists every bundle path the items would write
   *   (a skill item contributes every file of its directory); `skipped`
   *   lists the `file` of each item that cannot be placed, including an
   *   item whose destination an earlier item already takes.
   */
  public async preflightManifestItems(
    target: Target,
    files: ExtractedFiles,
    items: readonly ManifestPlacementItem[]
  ): Promise<TargetWritePlan> {
    const layout = await this.resolveLayout(target);
    const allowed = allowedKindSet(target);
    const writable: string[] = [];
    const skipped: string[] = [];
    const taken = new Set<string>();
    for (const item of items) {
      const placement = placeManifestItem(item, files, layout, allowed);
      // Two items mapping to one destination (e.g. ids `alpha` and
      // `alpha.instructions`) would overwrite each other: skip the later one.
      if (placement === null || !claimDestinations(placement, taken)) {
        skipped.push(item.file);
        continue;
      }
      writable.push(...placement.sources.map((source) => source.bundlePath));
    }
    return { writable, skipped };
  }

  private async resolveLayout(target: Target): Promise<TargetLayout> {
    if (this.opts.layoutLoader === undefined) {
      return resolveLayout(target);
    }
    return await resolveLayoutAsync(target, this.opts.layoutLoader);
  }

  /**
   * Compute, without touching the filesystem, where each recorded file
   * lives relative to the target's base directory: its `installedPath`
   * when present, otherwise the path-routed destination of `path` — the
   * same location {@link remove} would delete.
   * @param target - Target chosen via `--target <name>`.
   * @param files - Recorded files (lockfile `path` + optional `installedPath`).
   * @returns One `/`-separated base-relative location per file, or `null`
   *   for a path-routed file the layout does not route.
   */
  public async installedLocations(
    target: Target,
    files: readonly { path: string; installedPath?: string }[]
  ): Promise<(string | null)[]> {
    const layout = await this.resolveLayout(target);
    return files.map((file) => {
      if (file.installedPath !== undefined) {
        return path.posix.normalize(file.installedPath.replaceAll('\\', '/'));
      }
      const route = pickRoute(file.path, layout.kindRoutes);
      return route === null
        ? null
        : path.posix.normalize(path.posix.join(route.outPrefix.replaceAll('\\', '/'), route.tail));
    });
  }

  /**
   * Remove a file from the target.
   * @param target - Target chosen via `--target <name>`.
   * @param filePath - Relative file path to remove (from bundle root).
   * @param installedPath - Output path relative to the target's base
   *   directory, as recorded from `installedPaths` by a manifest-driven
   *   install. When given, it is removed instead of the path recomputed
   *   from `filePath`; a path that leaves the base directory is refused.
   */
  public async remove(target: Target, filePath: string, installedPath?: string): Promise<void> {
    const layout = await this.resolveLayout(target);
    const baseDir = expandPath(layout.baseDir, this.opts.env);
    if (installedPath !== undefined) {
      await this.opts.fs.remove(resolveInstalledPath(baseDir, installedPath));
      return;
    }
    const route = pickRoute(filePath, layout.kindRoutes);
    if (route === null) {
      return; // Unrouted file, nothing to do
    }
    const outPath = path.join(baseDir, route.outPrefix, route.tail);
    await this.opts.fs.remove(outPath);
  }
}

/**
 * Where one manifest item goes: its Copilot type, the output directory
 * (relative to the layout base directory) and every bundle file it writes
 * with its path below that directory.
 */
interface ManifestItemPlacement {
  type: CopilotFileType;
  outDir: string;
  sources: { bundlePath: string; tail: string }[];
}

const allowedKindSet = (target: Target): Set<string> | null =>
  target.allowedKinds === undefined
    ? null
    : new Set(target.allowedKinds.map((kind) => normalizePrimitiveKind(kind) ?? kind));

/**
 * Decide where a manifest item is written, or `null` when the target
 * cannot place it: its kind is excluded by `allowedKinds`, the layout has
 * no route for its type, a skill item does not point into a `skills/`
 * directory or that directory has no files, or the item's file is missing.
 * The type (explicit or auto-detected from `file`/`tags`) selects the
 * layout route via {@link KIND_TO_ROUTE_KEY}. Non-skill files are renamed
 * to `{id}.{type-extension}`; a skill's whole source directory is copied
 * into `{route}/{normalizedId}/`.
 * @param item - Manifest placement item.
 * @param files - Extracted bundle files.
 * @param layout - Resolved target layout.
 * @param allowed - Normalized `allowedKinds`, or `null` for all kinds.
 * @returns The placement, or `null` when the item is skipped.
 */
const placeManifestItem = (
  item: ManifestPlacementItem,
  files: ExtractedFiles,
  layout: TargetLayout,
  allowed: Set<string> | null
): ManifestItemPlacement | null => {
  const type = item.type ?? determineFileType(item.file, item.tags);
  if (allowed !== null && !allowed.has(copilotTypeToPrimitiveKind(type))) {
    return null;
  }
  const outPrefix = layout.kindRoutes[KIND_TO_ROUTE_KEY[type]];
  if (outPrefix === undefined) {
    // Target's layout has no route for this kind at all.
    return null;
  }

  if (type === 'skill') {
    const sourcePrefix = skillSourcePrefix(item.file);
    if (sourcePrefix === null) {
      return null;
    }
    const sources = [...files.keys()]
      .filter((bundlePath) => bundlePath.startsWith(sourcePrefix))
      .map((bundlePath) => ({ bundlePath, tail: bundlePath.slice(sourcePrefix.length) }));
    return sources.length === 0
      ? null
      : staysInside({ type, outDir: path.join(outPrefix, normalizePromptId(item.id)), sources });
  }

  if (!files.has(item.file) || !isPlainFileName(item.id)) {
    return null;
  }
  return staysInside({
    type,
    outDir: outPrefix,
    sources: [{ bundlePath: item.file, tail: getTargetFileName(item.id, type) }]
  });
};

/**
 * Whether a manifest item id can be used as a single file name: no path
 * separators and not `.`/`..`. The manifest is untrusted input, so an id
 * like `../../x` must never pick the output location.
 * @param id - Manifest item id.
 * @returns Whether the id is a plain file name.
 */
const isPlainFileName = (id: string): boolean =>
  id.length > 0 && !/[/\\]/.test(id) && id !== '.' && id !== '..';

/**
 * Keep a placement only when every destination stays below the layout
 * base directory (relative, no `..` segment after normalization).
 * @param placement - Candidate placement.
 * @returns The placement, or `null` when a destination would escape.
 */
const staysInside = (placement: ManifestItemPlacement): ManifestItemPlacement | null => {
  for (const { tail } of placement.sources) {
    const relative = path.normalize(path.join(placement.outDir, tail));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      return null;
    }
  }
  return placement;
};

/**
 * The bundle-path prefix of a skill item's directory: everything up to
 * and including `skills/<name>/`, whether the item names the directory
 * itself (`skills/foo`, `skills/foo/`) or a file inside it
 * (`.github/skills/foo/SKILL.md`). Mirrors `getSkillName`'s match.
 * @param file - Skill item `file`.
 * @returns The `/`-terminated prefix, or `null` when the path is not under
 *   a `skills/<name>` directory.
 */
export const skillSourcePrefix = (file: string): string | null => {
  if (getSkillName(file) === null) {
    return null;
  }
  const normalized = file.replaceAll('\\', '/');
  const match = /(?:^|\/)skills\/[^/]+(?:\/|$)/i.exec(normalized);
  if (match === null) {
    return null;
  }
  const root = normalized.slice(0, match.index + match[0].length).replace(/\/$/, '');
  return `${root}/`;
};

/**
 * Reserve every destination of a placement (relative to the layout base
 * directory), unless one is already reserved by an earlier item.
 * @param placement - Placement to reserve.
 * @param taken - Destinations reserved so far; updated on success.
 * @returns `false` (reserving nothing) when any destination is taken.
 */
const claimDestinations = (placement: ManifestItemPlacement, taken: Set<string>): boolean => {
  const destinations = placement.sources.map(({ tail }) => path.join(placement.outDir, tail));
  if (destinations.some((destination) => taken.has(destination))) {
    return false;
  }
  for (const destination of destinations) {
    taken.add(destination);
  }
  return true;
};

/**
 * Express an absolute output path relative to the layout base directory,
 * `/`-separated so lockfiles are portable across platforms.
 * @param baseDir - Expanded layout base directory.
 * @param outPath - Absolute output path below it.
 * @returns The base-relative path.
 */
const toInstalledPath = (baseDir: string, outPath: string): string =>
  path.relative(baseDir, outPath).split(path.sep).join('/');

/**
 * Resolve a recorded base-relative output path, refusing anything that
 * would leave the base directory (the lockfile is user-editable).
 * @param baseDir - Expanded layout base directory.
 * @param installedPath - Recorded base-relative path.
 * @returns Absolute output path.
 * @throws {Error} When the path is absolute or escapes `baseDir`.
 */
const resolveInstalledPath = (baseDir: string, installedPath: string): string => {
  // Build the path exactly as the write did (`path.join(baseDir, …)`), so it
  // names the same file. `path.resolve` is used only for the escape check: on
  // Windows it adds a drive letter to a drive-less base like `\home\u`.
  const outPath = path.join(baseDir, installedPath);
  const relative = path.relative(path.resolve(baseDir), path.resolve(outPath));
  if (path.isAbsolute(installedPath)
    || relative.length === 0
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`installed path "${installedPath}" is outside the target directory`);
  }
  return outPath;
};

interface PickedRoute {
  prefix: string;
  outPrefix: string;
  tail: string;
}

const pickRoute = (bundlePath: string, routes: KindRoutes): PickedRoute | null => {
  const normalizedBundlePath = normalizeBundlePath(bundlePath);
  const sorted = Object.entries(routes).toSorted((a, b) => b[0].length - a[0].length);
  for (const [prefix, outPrefix] of sorted) {
    if (normalizedBundlePath.startsWith(prefix)) {
      return { prefix, outPrefix, tail: normalizedBundlePath.slice(prefix.length) };
    }
  }
  return null;
};

/**
 * Normalize legacy bundle directory aliases before route matching.
 *
 * `chatmodes/` was the historical authoring path while the canonical
 * vocabulary uses `chat-modes/`. Keep accepting both on disk without
 * duplicating aliases in every target layout. The original path remains in
 * lockfile/checksum data; only the routing view is normalized.
 * @param bundlePath
 */
const normalizeBundlePath = (bundlePath: string): string =>
  bundlePath.startsWith('chatmodes/')
    ? `chat-modes/${bundlePath.slice('chatmodes/'.length)}`
    : bundlePath;

/**
 * Map a layout prefix back to the primitive kind it represents.
 * Used to honor `target.allowedKinds`.
 * @param prefix - Layout prefix (e.g., "prompts/").
 * @returns Kind name without trailing slash.
 */
const ROUTE_PREFIX_KINDS: Record<string, PrimitiveKind> = {
  '.kiro/steering/': 'steering',
  '.kiro/specs/': 'spec',
  '.claude/commands/': 'command',
  '.claude/output-styles/': 'output-style',
  '.cursor/rules/': 'rule',
  '.cursor/agents/': 'agent',
  '.cursor/skills/': 'skill',
  '.cursor/commands/': 'command',
  '.opencode/tools/': 'tool',
  '.opencode/commands/': 'command',
  '.opencode/agents/': 'agent',
  '.opencode/skills/': 'skill',
  '.opencode/rules/': 'rule',
  '.opencode/hooks/': 'hook',
  '.opencode/plugins/': 'plugin',
  '.devin/knowledge/': 'knowledge',
  '.devin/playbooks/': 'playbook',
  '.devin/powers/': 'power',
  '.devin/prompts/': 'prompt',
  '.devin/instructions/': 'instruction',
  '.devin/agents/': 'agent',
  '.devin/skills/': 'skill',
  '.devin/hooks/': 'hook',
  '.devin/plugins/': 'plugin'
};

const routeToKind = (prefix: string): PrimitiveKind | null => {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return normalizePrimitiveKind(prefix.replace(/\/$/, ''))
    ?? ROUTE_PREFIX_KINDS[normalizedPrefix]
    ?? null;
};

const copilotTypeToPrimitiveKind = (type: CopilotFileType): PrimitiveKind =>
  type === 'instructions' ? 'instruction' : (type === 'chatmode' ? 'chat-mode' : type);
